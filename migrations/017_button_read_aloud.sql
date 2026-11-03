-- ── Migration 017: read chat messages aloud ─────────────────────────────────
-- Set by the user from the intercom client (the speaker on a group's
-- Conversation). Typed messages in that group are then read aloud by their
-- browser, only while they've joined it. Per button row, like favourites,
-- so it follows the person between devices. Voice, speed and volume stay
-- per device (voices differ by device), in the browser.
ALTER TABLE intercom_directory_user_buttons
    ADD COLUMN read_aloud BOOLEAN NOT NULL DEFAULT FALSE;
