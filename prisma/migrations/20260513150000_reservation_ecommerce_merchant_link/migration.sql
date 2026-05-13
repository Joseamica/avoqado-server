-- Pin every reservation to the Stripe Connect merchant that processed its
-- charge. Required because Stripe refunds MUST originate from the same
-- connected account that captured the original charge — without this column
-- a venue that adds a second Stripe Connect later (or migrates between
-- accounts) will see refunds fail with account-mismatch errors.
--
-- Stamped at checkout-mint time in the public reservation controller.
-- Nullable for legacy rows + bookings that never charged (pay-at-venue or
-- 100% credit redemption).

ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "ecommerceMerchantId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Reservation_ecommerceMerchantId_fkey'
  ) THEN
    ALTER TABLE "Reservation"
      ADD CONSTRAINT "Reservation_ecommerceMerchantId_fkey"
      FOREIGN KEY ("ecommerceMerchantId") REFERENCES "EcommerceMerchant"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Reservation_ecommerceMerchantId_idx" ON "Reservation"("ecommerceMerchantId");
