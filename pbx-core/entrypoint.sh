#!/usr/bin/env bash
set -euo pipefail

# Start the drachtio SIP server (SofiaSIP engine). It exposes the admin/control
# socket on :9022 that our TS app connects to. All SIP logic stays in the app.
#
# Both the UDP/TCP SIP port (5063) and the WS port (8188) are pinned off
# their standard defaults (5060, 8088) -this container runs network_mode:
# host (see docker-compose.yml), so it binds the HOST's ports directly, and
# this host also runs an unrelated Asterisk project (asterisk-ci) that
# already holds BOTH 5060 and 8088 (its own built-in HTTP/WS server) -hit
# exactly this 2026-09-29, see CLAUDE.md's status entry. nginx.conf's /ws
# proxy target must match the WS port here. Nothing today actually depends
# on the literal port numbers (intercom-client derives wss://<host>/ws from
# window.location and never sees pbx-core's real host/port; pbx-core's own
# outbound leg to FreeSWITCH is a UAC, not bound to a fixed port), so moving
# them is safe -grep the repo for "5063"/"8188" before changing either
# again, in case that ever stops being true.
/usr/local/bin/drachtio --daemon \
                        --contact "sip:*:5063;transport=udp,tcp" \
                        --contact "sip:*:8188;transport=ws" \
                        --loglevel info --sofia-loglevel 2 \
                        --port 9022 --secret "${DRACHTIO_SECRET:-cymru}"

# --daemon forks and returns immediately regardless of whether the forked
# process actually stayed up -a bind failure is otherwise silent: the script
# would just proceed to start the app, which then spins forever on
# ECONNREFUSED to :9022 with no indication why. Poll for the control port,
# and fail loudly if it never comes up.
#
# One wrinkle confirmed by reading drachtio's own startup log ordering: the
# control port (9022) opens BEFORE it attempts the SIP-transport binds -so a
# single successful probe isn't proof it's healthy; a bind failure on 5063/
# 8188 crashes it shortly AFTER 9022 already looked open, which raced this
# check on first write (it saw 9022 briefly up, exec'd node, then drachtio
# died). Require two consecutive successful probes, half a second apart, so
# a crash in that window shows up as the second probe failing instead of a
# false positive.
ok_streak=0
for i in $(seq 1 20); do
  if (exec 3<>/dev/tcp/127.0.0.1/9022) 2>/dev/null; then
    exec 3<&- 3>&-
    ok_streak=$((ok_streak + 1))
    if [ "$ok_streak" -ge 2 ]; then
      exec node dist/index.js
    fi
  else
    ok_streak=0
  fi
  sleep 0.5
done
echo "FATAL: drachtio did not stay up on its control port :9022 within 10s -" \
     "check for a SIP port bind conflict (e.g. another SIP stack already" \
     "holding this host's UDP/TCP 5063 or WS 8188)." >&2
exit 1
