// Transcriber configuration -all from the environment (docker-compose.yml).
// Runs network_mode: host, like pbx-core/rtpengine: it receives RTP from
// rtpengine on local UDP ports, and reaches pbx-core's admin API, rtpengine's
// ng port and the shared whisper-server on this host directly.
export const config = {
  pbxStatusUrl: process.env.PBX_STATUS_URL || 'http://127.0.0.1:9080/status',
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
  // Biases whisper's vocabulary; also used to drop prompt echoes.
  prompt: process.env.TRANSCRIPT_PROMPT || 'Intercom talkback between a broadcast production crew.',
  pollMs: parseInt(process.env.POLL_MS || '2000', 10),
  // A segment ends at a pause of this length after speech, or at the max.
  pauseMs: parseInt(process.env.TRANSCRIPT_PAUSE_MS || '700', 10),
  maxSegmentMs: parseInt(process.env.TRANSCRIPT_MAX_SEGMENT_MS || '8000', 10),
  db: {
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'intercom',
    user: process.env.PGUSER || 'intercom_user',
    password: process.env.PGPASSWORD || 'intercom_pass',
  },
};
