-- Price's CatalogItem FK stays in core; tenant/actor parents get one bounded lock window.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogItemPrice"
  ADD CONSTRAINT "CatalogItemPrice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogItemPrice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogItemPrice_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
