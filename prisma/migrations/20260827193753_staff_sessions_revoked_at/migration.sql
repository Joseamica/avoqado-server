-- Cutoff for "log me out of every device".
--
-- Same mechanism as "lastPasswordReset" (passwordChangeGuard refuses any token
-- whose `iat` predates the LATER of the two), with a second trigger: the person
-- pressing a button, not a password change. NULL for every existing account, so
-- nobody's live session is affected by this migration.
ALTER TABLE "Staff" ADD COLUMN "sessionsRevokedAt" TIMESTAMP(3);
