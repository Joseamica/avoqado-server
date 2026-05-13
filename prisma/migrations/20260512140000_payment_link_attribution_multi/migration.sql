-- Replace PaymentLink.attributedStaffId (single FK) with PaymentLinkAttribution
-- join table (many-to-many). N rows → commission split equally; 0 rows → no
-- commission. The FIRST row also acts as Payment.processedById so reports
-- and receipts have a named staff. Existing single-attribution rows (if any)
-- are migrated into the join table before the column is dropped.

CREATE TABLE IF NOT EXISTS "PaymentLinkAttribution" (
  "id"            TEXT NOT NULL,
  "paymentLinkId" TEXT NOT NULL,
  "staffId"       TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentLinkAttribution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentLinkAttribution_paymentLinkId_staffId_key"
  ON "PaymentLinkAttribution"("paymentLinkId", "staffId");

CREATE INDEX IF NOT EXISTS "PaymentLinkAttribution_staffId_idx"
  ON "PaymentLinkAttribution"("staffId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PaymentLinkAttribution_paymentLinkId_fkey'
  ) THEN
    ALTER TABLE "PaymentLinkAttribution"
      ADD CONSTRAINT "PaymentLinkAttribution_paymentLinkId_fkey"
      FOREIGN KEY ("paymentLinkId") REFERENCES "PaymentLink"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PaymentLinkAttribution_staffId_fkey'
  ) THEN
    ALTER TABLE "PaymentLinkAttribution"
      ADD CONSTRAINT "PaymentLinkAttribution_staffId_fkey"
      FOREIGN KEY ("staffId") REFERENCES "Staff"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Migrate any existing single-attribution rows into the join table.
INSERT INTO "PaymentLinkAttribution" ("id", "paymentLinkId", "staffId", "createdAt")
SELECT
  -- cuid-shaped fallback; PaymentLink.id provides uniqueness collision-free here
  'cmig_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
  "id",
  "attributedStaffId",
  NOW()
FROM "PaymentLink"
WHERE "attributedStaffId" IS NOT NULL
ON CONFLICT ("paymentLinkId", "staffId") DO NOTHING;

-- Drop the now-redundant single-attribution column + FK + index.
ALTER TABLE "PaymentLink"
  DROP CONSTRAINT IF EXISTS "PaymentLink_attributedStaffId_fkey";
DROP INDEX IF EXISTS "PaymentLink_attributedStaffId_idx";
ALTER TABLE "PaymentLink"
  DROP COLUMN IF EXISTS "attributedStaffId";
