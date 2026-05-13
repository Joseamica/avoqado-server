-- Replace PaymentLink.productId (single FK) with PaymentLinkItem join table.
-- Bundle-style line items (Stripe Payment Links / Shopify cart pattern).
-- Each row = one product + quantity. Total at checkout = sum(qty × price).

CREATE TABLE IF NOT EXISTS "PaymentLinkItem" (
  "id"            TEXT NOT NULL,
  "paymentLinkId" TEXT NOT NULL,
  "productId"     TEXT NOT NULL,
  "quantity"      INTEGER NOT NULL DEFAULT 1,
  "position"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentLinkItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentLinkItem_paymentLinkId_productId_key"
  ON "PaymentLinkItem"("paymentLinkId", "productId");

CREATE INDEX IF NOT EXISTS "PaymentLinkItem_productId_idx"
  ON "PaymentLinkItem"("productId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PaymentLinkItem_paymentLinkId_fkey'
  ) THEN
    ALTER TABLE "PaymentLinkItem"
      ADD CONSTRAINT "PaymentLinkItem_paymentLinkId_fkey"
      FOREIGN KEY ("paymentLinkId") REFERENCES "PaymentLink"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PaymentLinkItem_productId_fkey'
  ) THEN
    ALTER TABLE "PaymentLinkItem"
      ADD CONSTRAINT "PaymentLinkItem_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "Product"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Migrate existing single-product ITEM links into the join table at qty=1.
INSERT INTO "PaymentLinkItem" ("id", "paymentLinkId", "productId", "quantity", "position", "createdAt")
SELECT
  'cmig_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
  "id",
  "productId",
  1,
  0,
  NOW()
FROM "PaymentLink"
WHERE "productId" IS NOT NULL
ON CONFLICT ("paymentLinkId", "productId") DO NOTHING;

-- Drop the legacy single-product column + FK.
ALTER TABLE "PaymentLink"
  DROP CONSTRAINT IF EXISTS "PaymentLink_productId_fkey";
ALTER TABLE "PaymentLink"
  DROP COLUMN IF EXISTS "productId";
