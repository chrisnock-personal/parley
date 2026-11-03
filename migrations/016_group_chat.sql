-- ── Migration 016: group chat ────────────────────────────────────────────────
-- Typed messages to a group, switched on per group like transcription
-- (intercom_groups.chat_enabled). Anyone with a button for the group can
-- read and post, joined or not. The client shows them in one timeline with
-- the group's transcript when both are on. Pruned with the transcript
-- retention (system_settings.transcript_retention_days).
ALTER TABLE intercom_groups
    ADD COLUMN chat_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE intercom_chat_messages (
    id               BIGSERIAL   PRIMARY KEY,
    group_id         UUID        NOT NULL REFERENCES intercom_groups (id) ON DELETE CASCADE,
    author_extension TEXT        NOT NULL,
    author_name      TEXT,                    -- snapshot at the time it was sent
    body             TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_messages_group ON intercom_chat_messages (group_id, id);
CREATE INDEX idx_chat_messages_created ON intercom_chat_messages (created_at);
