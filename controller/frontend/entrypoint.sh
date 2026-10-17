#!/bin/sh
# Generates a self-signed TLS cert on first start (only -/etc/nginx/tls is
# a mounted volume, so a redeploy doesn't regenerate it and force a fresh
# browser trust-exception every time). Lab-appropriate: a real domain +
# Let's Encrypt isn't an option for a private/routed LAN deployment with no
# public DNS.
set -e

CERT_DIR=/etc/nginx/tls
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "[entrypoint] No TLS cert found -generating a self-signed one..."
  mkdir -p "$CERT_DIR"
  SAN="DNS:localhost,IP:127.0.0.1"
  if [ -n "$CERT_SAN_IP" ]; then SAN="$SAN,IP:$CERT_SAN_IP"; fi
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$KEY_FILE" -out "$CERT_FILE" \
    -subj "/CN=open-intercom.local" \
    -addext "subjectAltName=$SAN"
  echo "[entrypoint] Cert generated (SAN: $SAN)"
fi

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
