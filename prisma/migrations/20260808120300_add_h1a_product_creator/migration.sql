-- No Product is re-identified or backfilled. New writers may add provenance,
-- and the FK is installed/validated separately to avoid a long legacy lock.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Product" ADD COLUMN "createdById" TEXT;
COMMIT;
