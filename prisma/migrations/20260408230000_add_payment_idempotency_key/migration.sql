-- Add idempotencyKey column to Payment + unique index
--
-- Context: Stripe/Square/Toast pattern — client generates a UUID v4 once per
-- logical payment attempt and sends it on every retry. Backend deduplicates
-- atomically via the unique index below.
--
-- Backwards compatible: column is nullable, so older TPV versions (< v1.10.10)
-- and non-TPV payment sources (dashboard, POS sync, mobile) continue working
-- with NULL values. Postgres does not treat NULL as equal in unique indexes,
-- so multiple NULLs coexist without colliding.
--
-- Incident: Testarudo Cafe 2026-04-08 — 5 duplicates from 2 parallel TPV retry
-- chains racing the non-atomic idempotency check in recordFastPayment.
--
-- Rollback:
--   DROP INDEX "public"."Payment_venueId_idempotencyKey_key";
--   ALTER TABLE "public"."Payment" DROP COLUMN "idempotencyKey";

-- AlterTable
ALTER TABLE "public"."Payment" ADD COLUMN     "idempotencyKey" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_venueId_idempotencyKey_key" ON "public"."Payment"("venueId", "idempotencyKey");
