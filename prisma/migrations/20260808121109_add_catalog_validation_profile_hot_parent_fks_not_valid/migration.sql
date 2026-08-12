-- Profile metadata is empty during expand, so its hot-parent FK phase is bounded and reversible by retry.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogValidationProfile"
  ADD CONSTRAINT "CatalogValidationProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogValidationProfile_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogValidationProfile_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
