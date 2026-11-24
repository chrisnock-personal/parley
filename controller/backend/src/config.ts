// src/config.ts -intercom controller config (mirrors Walk the Nxt Floor style)

// Secrets fail closed (security review 2026-11-09, C2): no built-in
// fallbacks. With the old 'dev-secret-change-in-production' default anyone
// could forge an admin token on a stack started without a .env.
const KNOWN_DEFAULTS = new Set(['dev-secret-change-in-production', 'change-me-to-a-long-random-string',
  'admin123', 'change-me', 'intercom_pass']);
function requiredSecret(name: string, minLength: number): string {
  const v = process.env[name] || '';
  if (!v || KNOWN_DEFAULTS.has(v) || v.length < minLength) {
    console.error(`FATAL: ${name} must be set in .env to a random value of at least ${minLength} characters (not a default)`);
    process.exit(1);
  }
  return v;
}

const config = {
  port:       parseInt(process.env.PORT || '3100', 10),
  nodeEnv:    process.env.NODE_ENV || 'development',
  jwtSecret:  requiredSecret('JWT_SECRET', 32),
  jwtTtl:     process.env.JWT_TTL || '8h',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@intercom.local',
  adminPass:  requiredSecret('ADMIN_PASSWORD', 12),
  // Empty (the default) = no CORS headers at all: the console and client
  // reach the API same-origin through nginx. '*' is refused (index.ts).
  corsOrigin: process.env.CORS_ORIGIN || '',

  // PostgreSQL
  pgHost:     process.env.PGHOST || '127.0.0.1',
  pgPort:     parseInt(process.env.PGPORT || '5432', 10),
  pgDatabase: process.env.PGDATABASE || 'intercom',
  pgUser:     process.env.PGUSER || 'intercom_user',
  pgPassword: requiredSecret('PGPASSWORD', 16),
  pgPoolMax:  parseInt(process.env.PG_POOL_MAX || '10', 10),
  pgSsl:      process.env.PGSSL === 'true',

  // pbx-core's read-only admin/status HTTP server (registrations + live
  // calls) -see services/pbxCoreService.ts. Docker-compose overrides this
  // to the host's LAN IP since pbx-core runs network_mode: host.
  pbxBaseUrl: process.env.PBX_BASE_URL || 'http://127.0.0.1:9080',

  // The transcriber's who's-talking endpoint (transcriber/src/index.ts
  // GET /talking) -merged into the intercom client's participant lists.
  transcriberUrl: process.env.TRANSCRIBER_URL || 'http://127.0.0.1:9081',

  // Bearer token for pbx-core's /status and the transcriber's /talking
  // (both host-network, so bound on every interface: a loopback bind isn't
  // reachable from this bridged container under WSL).
  internalToken: requiredSecret('INTERNAL_API_TOKEN', 32),

  // Endpoint health polling (hits each endpoint's container-sip-endpoint /api/status)
  healthInterval:      parseInt(process.env.HEALTH_INTERVAL_MS || '30000', 10),
  healthLogRetentionDays: parseInt(process.env.HEALTH_LOG_RETENTION_DAYS || '90', 10),

  // Demo data (services/demoSeedService.ts) -off unless explicitly enabled.
  seedDemo:     process.env.SEED_DEMO === 'true',
  demoPassword: process.env.DEMO_PASSWORD || 'demo1234',

  // Graceful shutdown drain
  shutdownDrainMs: parseInt(process.env.SHUTDOWN_DRAIN_MS || '15000', 10),

  // Podman API socket, mounted read-write into this container -used by the
  // System Health page's log viewer (routes/system.ts) to fetch other
  // containers' logs via the libpod HTTP API over a unix socket. Widens this
  // container's blast radius to every container on the host, not just this
  // project's -see CLAUDE.md.
  // The Health page's container logs (#37): log-reader holds the podman socket.
  logReaderUrl: process.env.LOG_READER_URL || 'http://log-reader:9300',
};

export default config;
