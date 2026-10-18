-- ── Migration 014: directory user profile pictures ───────────────────────────
-- Set by the user from the intercom client's "My profile" menu. The client
-- crops and shrinks the photo to a small square JPEG before uploading, so
-- these stay a few KB each; the server still checks the type and caps the
-- size (routes/intercomClient.ts). avatar_updated_at versions the image URL,
-- so browsers cache a picture until it changes.
ALTER TABLE intercom_directory_users
    ADD COLUMN avatar BYTEA,
    ADD COLUMN avatar_mime TEXT,
    ADD COLUMN avatar_updated_at TIMESTAMPTZ;
