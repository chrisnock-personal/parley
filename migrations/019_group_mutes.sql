-- ── Migration 019: remote mutes survive a pbx-core restart ───────────────────
-- Remote mutes (issue #9) were only in pbx-core's memory, so restarting it
-- unmuted everyone (issue #19). controller-backend writes them here when the
-- console mutes or unmutes someone; pbx-core loads them at start and every
-- minute, and applies them when a muted member joins.
CREATE TABLE intercom_group_mutes (
    group_id   UUID        NOT NULL REFERENCES intercom_groups(id) ON DELETE CASCADE,
    extension  TEXT        NOT NULL,
    muted_by   TEXT        NOT NULL,
    muted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, extension)
);
