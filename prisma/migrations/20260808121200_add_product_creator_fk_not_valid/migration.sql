-- Installation avoids the validating scan; ON DELETE SET NULL retains legacy
-- Products when a creator Staff row is removed.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "Staff"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
COMMIT;
