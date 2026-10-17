-- ── Migration 012: endpoint API tokens ──────────────────────────────────────
-- controller-backend drives each endpoint's own REST API (container-sip-
-- endpoint-style: /api/call, /api/hangup, /api/hold, /api/resume, /api/status)
-- with no credential at all -any endpoint listening on its rest_url has to
-- trust whoever hits it, unauthenticated. This is a client-side credential,
-- not a login: unlike password_hash/sip_ha1 elsewhere in this schema, it has
-- to be stored in a form controller-backend can present as-is on outbound
-- calls, so it's plaintext, not hashed (same pattern as any system storing a
-- third-party API key). Nullable: NULL means "no token configured", and
-- controller-backend sends no Authorization header at all in that case
-- (see pbxService.ts/endpointHealthService.ts) -a deliberately gradual
-- rollout, since no endpoint implementation is known to expect this yet
-- (intercom-endpoint, the one that lived in this repo, was removed
-- 2026-07-09; container-sip-endpoint is a separate sibling project).
ALTER TABLE intercom_endpoints
    ADD COLUMN api_token TEXT;
