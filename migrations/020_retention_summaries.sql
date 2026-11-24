-- ── Migration 020: per-group retention and shift summaries (#26, #29) ────────
-- keep_days: how long this group's transcript lines and chat are kept.
-- NULL = the global setting; 0 = "don't keep" (deleted after 15 minutes,
-- long enough to be seen live; never archived or summarised).
ALTER TABLE intercom_groups
    ADD COLUMN keep_days INTEGER NULL CHECK (keep_days IS NULL OR keep_days BETWEEN 0 AND 3650);

-- An AI summary of one group's shift, kept after the lines themselves are
-- deleted (pruned after 365 days). partial: made by "Summarise now" before
-- the shift ended; the end-of-shift summary replaces it.
CREATE TABLE intercom_shift_summaries (
    id           BIGSERIAL   PRIMARY KEY,
    group_id     UUID        NOT NULL REFERENCES intercom_groups(id) ON DELETE CASCADE,
    shift_start  TIMESTAMPTZ NOT NULL,
    shift_end    TIMESTAMPTZ NOT NULL,
    summary      TEXT        NOT NULL,
    line_count   INTEGER     NOT NULL,
    model        TEXT        NOT NULL,
    partial      BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (group_id, shift_start)
);
CREATE INDEX idx_shift_summaries_group ON intercom_shift_summaries (group_id, shift_start DESC);
