-- ── Migration 015: favourite groups ──────────────────────────────────────────
-- Set by the user from the intercom client (the star on a group's card or
-- tile). A favourite group always shows as a full card, joined or not;
-- the rest are small tiles under "Other groups" until joined. Per button
-- row, so it follows the person to any device they log in on.
ALTER TABLE intercom_directory_user_buttons
    ADD COLUMN favourite BOOLEAN NOT NULL DEFAULT FALSE;
