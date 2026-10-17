-- ── Migration 013: SIP-REC recording + group transcription ───────────────────
-- Two features that both take a copy of call media from rtpengine
-- ("subscribe request" -see pbx-core/src/rtpengine.ts):
--
--  * SIP-REC (RFC 7865/7866): pbx-core acts as the recording client (SRC)
--    for any call involving a directory user with siprec_enabled, sending
--    the media to ONE global recording server (system_settings
--    'siprec_srs_uri'). pbx-core reads siprec_enabled in the same narrow,
--    cached, read-only lookup it already does for sip_ha1 (CLAUDE.md's
--    design-decision note on pbx-core's DB access covers this too).
--
--  * Group transcription: the transcriber service subscribes to each
--    member's own voice in groups with transcribe_enabled, runs it through
--    whisper, and stores attributed lines here so anyone with the group can
--    read them without joining. Kept for system_settings
--    'transcript_retention_days', pruned hourly by controller-backend.

-- Small global key/value settings (first one this schema has needed).
CREATE TABLE system_settings (
    key         TEXT        PRIMARY KEY,
    value       TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  TEXT
);

INSERT INTO system_settings (key, value) VALUES
    ('siprec_srs_uri', NULL),               -- e.g. sip:srs@10.0.0.5:5060; NULL = recording off globally
    ('transcript_retention_days', '30');

ALTER TABLE intercom_directory_users
    ADD COLUMN siprec_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE intercom_groups
    ADD COLUMN transcribe_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE intercom_transcript_lines (
    id                BIGSERIAL   PRIMARY KEY,
    group_id          UUID        NOT NULL REFERENCES intercom_groups (id) ON DELETE CASCADE,
    speaker_extension TEXT        NOT NULL,
    speaker_name      TEXT,                    -- snapshot at the time it was said
    text              TEXT        NOT NULL,
    spoken_at         TIMESTAMPTZ NOT NULL,    -- start of the audio window
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transcript_lines_group_time ON intercom_transcript_lines (group_id, spoken_at DESC);
CREATE INDEX idx_transcript_lines_created ON intercom_transcript_lines (created_at);
