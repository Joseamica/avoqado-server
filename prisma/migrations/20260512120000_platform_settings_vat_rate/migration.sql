-- Add VAT (IVA) rate to PlatformSettings so Avoqado's platform fee is
-- charged inclusive of IVA, matching how every Mexican payments platform
-- bills (Mercado Pago, Stripe, Conekta all use "X% + IVA").
--
-- 1600 bps = 16% — the standard MX VAT rate. Existing/future rows default
-- to this. The migration also updates the singleton row in case it was
-- already created without the column (idempotent).

ALTER TABLE "PlatformSettings"
  ADD COLUMN IF NOT EXISTS "vatRateBps" INTEGER NOT NULL DEFAULT 1600;

UPDATE "PlatformSettings"
SET "vatRateBps" = 1600
WHERE "vatRateBps" IS NULL OR "vatRateBps" = 0;
