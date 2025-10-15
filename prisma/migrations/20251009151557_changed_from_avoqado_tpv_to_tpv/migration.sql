/*
  Warnings:

  - Changed AVOQADO_TPV to TPV for consistency with OrderSource enum
  - Kept DASHBOARD_TEST for test payments
  - Changed UNKNOWN to OTHER for clarity

*/

-- Step 1: Add new enum values (MUST be outside transaction due to PostgreSQL enum limitations)
ALTER TYPE "public"."PaymentSource" ADD VALUE IF NOT EXISTS 'TPV';
ALTER TYPE "public"."PaymentSource" ADD VALUE IF NOT EXISTS 'OTHER';

-- Force commit to make enum values usable
COMMIT;

-- Step 2: Update existing data to new values (can be in transaction now)
BEGIN;
UPDATE "public"."Payment" SET source = 'TPV' WHERE source = 'AVOQADO_TPV';
UPDATE "public"."Payment" SET source = 'OTHER' WHERE source = 'UNKNOWN';
-- DASHBOARD_TEST stays as is

-- Step 3: Recreate enum without old values
DO $$
BEGIN
  -- Drop default temporarily
  ALTER TABLE "public"."Payment" ALTER COLUMN "source" DROP DEFAULT;

  -- Create new enum type with correct values
  CREATE TYPE "public"."PaymentSource_new" AS ENUM ('TPV', 'DASHBOARD_TEST', 'QR', 'WEB', 'APP', 'PHONE', 'POS', 'OTHER');

  -- Convert column to new type
  ALTER TABLE "public"."Payment" ALTER COLUMN "source" TYPE "public"."PaymentSource_new" USING ("source"::text::"public"."PaymentSource_new");

  -- Swap enum types
  ALTER TYPE "public"."PaymentSource" RENAME TO "PaymentSource_old";
  ALTER TYPE "public"."PaymentSource_new" RENAME TO "PaymentSource";
  DROP TYPE "public"."PaymentSource_old";

  -- Set default to TPV (most common case)
  ALTER TABLE "public"."Payment" ALTER COLUMN "source" SET DEFAULT 'TPV';
END $$;

COMMIT;
