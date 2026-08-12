-- The organization edge is separated so the core never retains a live-parent lock.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogItemBusinessType"
  ADD CONSTRAINT "CatalogItemBusinessType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
COMMIT;
