-- Publication batches are new; hot tenant/actor parents are locked only briefly.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogPublicationBatch"
  ADD CONSTRAINT "CatalogPublicationBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogPublicationBatch_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
