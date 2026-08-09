-- Corporate identifier's CatalogItem FK stays in core; hot tenant/actor locks are short here.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogIdentifier"
  ADD CONSTRAINT "CatalogIdentifier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogIdentifier_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
