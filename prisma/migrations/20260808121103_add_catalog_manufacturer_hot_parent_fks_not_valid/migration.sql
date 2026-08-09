-- Manufacturer is isolated from the core transaction to avoid retaining locks on live parents.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogManufacturer"
  ADD CONSTRAINT "CatalogManufacturer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogManufacturer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogManufacturer_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
