-- ── Migration 018: who can talk in a listen-only group ───────────────────────
-- A listen-only group (intercom_groups.mode = 'announce') is a paging zone:
-- the people whose button has can_talk talk (push to talk); everyone else
-- listens, and their client joins by itself while a talker is in the group
-- (issue #11). Set per holder on the console's group page. Ignored for
-- open-mic and push-to-talk groups, where everyone talks.
ALTER TABLE intercom_directory_user_buttons
    ADD COLUMN can_talk BOOLEAN NOT NULL DEFAULT FALSE;
