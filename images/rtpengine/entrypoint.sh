#!/bin/sh
set -e
: "${RTPENGINE_PUBLIC_IP:?set RTPENGINE_PUBLIC_IP to this host's routed/LAN IP}"

# --table=-1  -> userspace-only forwarding (no kernel module needed)
# --interface -> the address rtpengine advertises + anchors media on
# --listen-ng -> the (unauthenticated) control port: keep it off the LAN.
#                RTPENGINE_NG_HOST exists for WSL2's mirrored networking,
#                which drops UDP over 1472 bytes sent to 127.0.0.1 (a
#                browser's WebRTC offer is ~3.4 KB); there, use the other
#                loopback address, 10.255.255.254.
exec rtpengine \
  --foreground --log-stderr --log-level="${RTPENGINE_LOG_LEVEL:-6}" \
  --table=-1 \
  --interface="${RTPENGINE_PUBLIC_IP}" \
  --listen-ng="${RTPENGINE_NG_HOST:-127.0.0.1}":"${RTPENGINE_NG_PORT:-22222}" \
  --port-min="${RTPENGINE_PORT_MIN:-30000}" \
  --port-max="${RTPENGINE_PORT_MAX:-40000}"
