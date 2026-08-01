-- Additive shadow-mode classification only. Existing pricing and settlement
-- calculations continue reading Payment.processorData.isInternational.
CREATE TYPE "CardInternationalityStatus" AS ENUM ('DOMESTIC', 'INTERNATIONAL', 'UNKNOWN');

CREATE TYPE "CardInternationalitySource" AS ENUM (
  'EMV_5F28',
  'PROCESSOR',
  'BIN_REGISTRY',
  'MANUAL',
  'LEGACY',
  'CONFLICT',
  'NONE'
);

ALTER TABLE "Payment"
  ADD COLUMN "internationalityStatus" "CardInternationalityStatus",
  ADD COLUMN "internationalitySource" "CardInternationalitySource",
  ADD COLUMN "issuerCountryCode" VARCHAR(3),
  ADD COLUMN "internationalityClassificationVersion" INTEGER,
  ADD COLUMN "internationalityClassifiedAt" TIMESTAMP(3);

CREATE INDEX "Payment_internationalityStatus_idx" ON "Payment"("internationalityStatus");
