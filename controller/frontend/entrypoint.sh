#!/bin/sh
# TLS for the console + intercom client, mkcert-style: a small local CA
# (generated once, persisted in the /etc/nginx/tls volume) signs the
# server cert nginx presents. Lab-appropriate: a real domain + Let's Encrypt
# isn't an option for a private/routed LAN deployment with no public DNS.
#
# Why a CA rather than one self-signed cert (2026-10-17): tapping through a
# browser's self-signed-cert warning only trusts the PAGE. WebKit (Safari,
# every iPad/iPhone browser) doesn't extend that exception to WebSocket
# connections, so the client's wss:// SIP line silently never connected
# from an iPad. Installing and trusting a CA fixes page AND wss://, and iOS
# only trusts a server cert that is <= 825 days, has EKU serverAuth, and
# isn't itself a CA, none of which the old single cert met. The CA is
# downloadable at http://<host>:8080/ca.crt (see nginx.conf) and carries
# name constraints (localhost / 127.0.0.1 / CERT_SAN_IP only), so trusting
# it on a device can't be abused to impersonate any other site.
set -e

CERT_DIR=/etc/nginx/tls
CA_CERT="$CERT_DIR/ca.pem"
CA_KEY="$CERT_DIR/ca.key"
CA_SCOPE="$CERT_DIR/ca.scope" # the CERT_SAN_IP the CA's name constraints were built for
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"
mkdir -p "$CERT_DIR"

SCOPE="${CERT_SAN_IP:-none}"
SAN="DNS:localhost,IP:127.0.0.1"
PERMITTED="permitted;DNS:localhost,permitted;IP:127.0.0.1/255.255.255.255"
if [ -n "$CERT_SAN_IP" ]; then
  SAN="$SAN,IP:$CERT_SAN_IP"
  PERMITTED="$PERMITTED,permitted;IP:$CERT_SAN_IP/255.255.255.255"
fi

# CA: generated once. Regenerated only if missing or if CERT_SAN_IP changed
# (its name constraints would exclude the new IP) -either way every device
# that trusted the old one has to re-install /ca.crt.
if [ ! -f "$CA_CERT" ] || [ ! -f "$CA_KEY" ] || [ "$(cat "$CA_SCOPE" 2>/dev/null)" != "$SCOPE" ]; then
  echo "[entrypoint] Generating local CA (scope: $SCOPE) -devices must (re)install /ca.crt"
  cat > /tmp/ca.cnf <<CNF
[req]
distinguished_name = dn
x509_extensions = ca_ext
prompt = no
[dn]
CN = Open Intercom local CA ($SCOPE)
[ca_ext]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical,$PERMITTED
CNF
  openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 3650 \
    -config /tmp/ca.cnf -keyout "$CA_KEY" -out "$CA_CERT"
  chmod 600 "$CA_KEY"
  echo "$SCOPE" > "$CA_SCOPE"
  rm -f "$CERT_FILE" "$KEY_FILE" # force a fresh server cert under the new CA
fi

# Server cert: regenerated if missing, not issued by the current CA (e.g.
# the old pre-CA self-signed cert), missing the current SAN IP, or within
# 30 days of expiry (825-day validity, so this runs every ~2 years).
need_leaf=no
if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then need_leaf=yes
elif ! openssl verify -CAfile "$CA_CERT" "$CERT_FILE" >/dev/null 2>&1; then need_leaf=yes
elif ! openssl x509 -in "$CERT_FILE" -noout -checkend 2592000 >/dev/null; then need_leaf=yes
elif [ -n "$CERT_SAN_IP" ] && ! openssl x509 -in "$CERT_FILE" -noout -ext subjectAltName | grep -q "IP Address:$CERT_SAN_IP"; then need_leaf=yes
fi
if [ "$need_leaf" = yes ]; then
  echo "[entrypoint] Issuing server cert (SAN: $SAN)"
  cat > /tmp/leaf.cnf <<CNF
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $SAN
authorityKeyIdentifier = keyid
subjectKeyIdentifier = hash
CNF
  openssl req -new -nodes -newkey rsa:2048 -sha256 -subj "/CN=open-intercom" \
    -keyout "$KEY_FILE" -out /tmp/leaf.csr
  openssl x509 -req -in /tmp/leaf.csr -CA "$CA_CERT" -CAkey "$CA_KEY" \
    -set_serial "0x$(openssl rand -hex 16)" -days 825 -sha256 \
    -extfile /tmp/leaf.cnf -out "$CERT_FILE"
  chmod 600 "$KEY_FILE"
  rm -f /tmp/leaf.csr
fi
# Served at /ca.crt by nginx (see nginx.conf) -world-readable copy of the
# PUBLIC cert only; ca.key never leaves the volume.
cp "$CA_CERT" /usr/share/nginx/ca.crt

# nginx.conf's /ws proxy target -pbx-core runs network_mode: host, so it's
# reached at the host's LAN IP (see the comment at the top of nginx.conf).
# Substituted on every start (from the image's pristine copy), so a changed
# PBX_HOST takes effect on a plain restart.
: "${PBX_HOST:?PBX_HOST must be set -the host's routed/LAN IP, same as RTPENGINE_PUBLIC_IP}"
# HTTPS_PORT is the HOST-side TLS port, for the plain-HTTP server's
# non-localhost redirect of /intercom-client/ (see nginx.conf).
: "${HTTPS_PORT:?HTTPS_PORT must be set -the host port mapped to this container's 443}"
sed -e "s/__PBX_HOST__/${PBX_HOST}/g" -e "s/__HTTPS_PORT__/${HTTPS_PORT}/g" \
  /etc/nginx/default.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
