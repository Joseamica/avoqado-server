-- Family's self-FK stays in core; only hot Organization/Staff edges are phased here.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogFamily"
  ADD CONSTRAINT "CatalogFamily_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogFamily_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogFamily_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
