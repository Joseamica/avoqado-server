-- Adds per-product hybrid pricing fields and venue-wide upfront-payment defaults.
-- All columns are additive with safe defaults; no existing data is touched.

-- AlterTable: Product
ALTER TABLE "public"."Product"
  ADD COLUMN "creditCost" INTEGER,
  ADD COLUMN "upfrontPolicy" TEXT DEFAULT 'inherit';

-- AlterTable: ReservationSettings
ALTER TABLE "public"."ReservationSettings"
  ADD COLUMN "appointmentUpfrontDefault" TEXT NOT NULL DEFAULT 'at_venue',
  ADD COLUMN "classUpfrontDefault" TEXT NOT NULL DEFAULT 'required';
