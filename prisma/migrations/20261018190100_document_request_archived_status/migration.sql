-- Retained delivery files leave the active draft without deleting their private bytes.
-- Widen the existing check without rewriting records or altering other tables.
BEGIN;
ALTER TABLE "DocumentRequestFile" DROP CONSTRAINT "DocumentRequestFile_status_check";
ALTER TABLE "DocumentRequestFile" ADD CONSTRAINT "DocumentRequestFile_status_check"
  CHECK ("status" IN ('PENDING', 'READY', 'ARCHIVED', 'DELETING', 'DELETED'));
COMMIT;
