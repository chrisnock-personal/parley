-- ── Migration 011: SIP digest auth for directory users ──────────────────────
-- pbx-core's registrar/INVITE handlers accepted any REGISTER/INVITE
-- unconditionally -no credential check at all, so anyone reachable on the
-- SIP ports could register as (or place a call claiming to be) any
-- extension. Closing that needs SIP digest auth (RFC 2617/3261), which
-- needs a credential to challenge against: the RFC-mandated form is
-- HA1 = MD5(username:realm:password), computed once at password-set time
-- so the plaintext password itself never has to live at the SIP layer.
--
-- This is a deliberate, narrow exception to "pbx-core stays database-free"
-- (see CLAUDE.md's design decisions) -pbx-core gains a read-only lookup of
-- this one column, not general DB access. sip_ha1 is nullable: NULL means
-- "cannot authenticate via SIP yet" (e.g. right after an extension change,
-- until the password is reset -see directoryUserService.ts's comment on
-- why changing the extension invalidates the old HA1).
ALTER TABLE intercom_directory_users
    ADD COLUMN sip_ha1 CHAR(32);
