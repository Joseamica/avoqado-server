BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Exchange"
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewNote" VARCHAR(500);
COMMIT;
