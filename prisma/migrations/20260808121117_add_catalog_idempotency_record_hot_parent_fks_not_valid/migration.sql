-- Generic operation rows are new/empty; Organization and actor locks stay bounded.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogIdempotencyRecord"
  ADD CONSTRAINT "CatalogIdempotencyRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogIdempotencyRecord_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
