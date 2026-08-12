-- Import batches are empty at expand time; hot tenant/actor parent locks are isolated.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogImportBatch"
  ADD CONSTRAINT "CatalogImportBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogImportBatch_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
