-- Binding batches are empty; live tenant/actor metadata locks get one short transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogBindingBatch"
  ADD CONSTRAINT "CatalogBindingBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogBindingBatch_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
