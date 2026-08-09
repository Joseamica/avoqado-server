-- ImportLine's batch/item edges stay in core; the hot Organization edge is isolated.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogImportLine"
  ADD CONSTRAINT "CatalogImportLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
COMMIT;
