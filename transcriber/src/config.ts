// Transcriber configuration -all from the environment (docker-compose.yml).
// Runs network_mode: host, like pbx-core/rtpengine: it receives RTP from
// rtpengine on local UDP ports, and reaches pbx-core's admin API, rtpengine's
// ng port and the shared whisper-server on this host directly.
import { requiredSecret } from './internalAuth';

export const config = {
  pbxStatusUrl: process.env.PBX_STATUS_URL || 'http://127.0.0.1:9080/status',
  // Bearer token: sent to pbx-core's /status, required on /talking and /poke.
  internalToken: requiredSecret('INTERNAL_API_TOKEN', 32),
  rtpengine: {
    host: process.env.RTPENGINE_HOST || '127.0.0.1',
    port: parseInt(process.env.RTPENGINE_PORT || '22222', 10),
  },
  // The address rtpengine sends our copy of the media to. This host's LAN
  // IP, same as RTPENGINE_PUBLIC_IP: rtpengine anchors media there.
  mediaIp: process.env.MEDIA_IP || '127.0.0.1',
  // Shared whisper.cpp whisper-server (on this lab host: CallNest's
  // callnest-whisper, 127.0.0.1:8090 -never start a second one).
  whisperUrl: process.env.WHISPER_URL || 'http://127.0.0.1:8090',
  // Optional vocabulary hint for whisper. Off by default: on noisy audio a
  // prompt gets echoed back as invented text and hides whisper's no-speech
  // signal (see whisper.ts).
  prompt: process.env.TRANSCRIPT_PROMPT || '',
  // Set to a directory to keep every sent segment's audio + whisper's
  // verdict there (see whisper.ts debugDump). Off by default.
  debugDir: process.env.TRANSCRIPT_DEBUG_DIR || '',
  // With debugDir: only dump this extension's segments (a test user), so
  // nobody else's voice is kept.
  debugExt: process.env.TRANSCRIPT_DEBUG_EXT || '',
  pollMs: parseInt(process.env.POLL_MS || '1000', 10),
  // Who's-talking endpoint (GET /talking), polled by controller-backend for
  // the client's participant lists. Host network, so 0.0.0.0 like pbx-core's
  // admin port: controller-backend (bridged) reaches it at the host LAN IP.
  // INTERNAL_API_HOST can narrow the bind to one address (e.g. 127.0.0.1
  // when the caller shares this network namespace); default is unchanged.
  talkingPort: parseInt(process.env.TALKING_PORT || '9081', 10),
  talkingHost: process.env.INTERNAL_API_HOST || '0.0.0.0',
  // How long someone still counts as talking after their last speech frame:
  // bridges the gaps between words so the indicator doesn't flicker.
  talkHoldMs: parseInt(process.env.TALK_HOLD_MS || '700', 10),
  // A segment ends at a pause of this length after speech, or at the max.
  pauseMs: parseInt(process.env.TRANSCRIPT_PAUSE_MS || '900', 10),
  maxSegmentMs: parseInt(process.env.TRANSCRIPT_MAX_SEGMENT_MS || '12000', 10),
  db: {
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'intercom',
    user: process.env.PGUSER || 'intercom_user',
    password: requiredSecret('PGPASSWORD', 16),
  },
};
