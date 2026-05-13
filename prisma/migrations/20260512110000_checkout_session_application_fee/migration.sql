-- Promote Avoqado's platform fee from metadata JSON to a real column on
-- CheckoutSession. Lets `SUM(applicationFeeCents)` reporting queries run as
-- fast indexed aggregates instead of full-table JSON parsing.
--
-- Nullable: existing rows stay NULL until a webhook updates them or until
-- backfilled. New Stripe Connect sessions populate it at creation time
-- (see createStripeCheckoutForPaymentLink).

ALTER TABLE "CheckoutSession"
  ADD COLUMN IF NOT EXISTS "applicationFeeCents" INTEGER;

-- Backfill from existing metadata.applicationFeeCents where present. Safe
-- to re-run: WHERE clause skips rows that already have a value.
UPDATE "CheckoutSession"
SET "applicationFeeCents" = (metadata->>'applicationFeeCents')::int
WHERE "applicationFeeCents" IS NULL
  AND metadata ? 'applicationFeeCents'
  AND (metadata->>'applicationFeeCents') ~ '^\d+$';
