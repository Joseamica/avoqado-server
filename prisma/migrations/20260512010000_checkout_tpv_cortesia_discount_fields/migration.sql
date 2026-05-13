-- Add structured TPV Cobrar fields for item-level cortesía and discounts.
-- Backfill-safe: existing order items remain non-cortesía with no linked discount.
--
-- Scope note: these columns are additive metadata for the new standalone TPV
-- Cobrar flow. Existing /mobile, dashboard, payment link, and legacy TPV
-- endpoints are not required to use them. See:
-- docs/TPV_COBRAR_STRUCTURED_DISCOUNTS.md

ALTER TABLE "OrderItem"
  ADD COLUMN "isCortesia" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cortesiaReason" TEXT,
  ADD COLUMN "appliedDiscountId" TEXT;

ALTER TABLE "OrderDiscount"
  ADD COLUMN "appliedToItemIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_appliedDiscountId_fkey"
  FOREIGN KEY ("appliedDiscountId") REFERENCES "Discount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "OrderItem_appliedDiscountId_idx" ON "OrderItem"("appliedDiscountId");
