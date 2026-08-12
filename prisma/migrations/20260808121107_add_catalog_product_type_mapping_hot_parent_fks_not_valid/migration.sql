-- Alias mappings are new and empty; tenant/actor FKs get a bounded lock window.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogProductTypeMapping"
  ADD CONSTRAINT "CatalogProductTypeMapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogProductTypeMapping_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
