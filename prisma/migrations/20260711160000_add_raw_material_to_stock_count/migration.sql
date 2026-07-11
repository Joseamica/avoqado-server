-- StockCountItem: allow ingredient (RawMaterial) count lines alongside product lines.
-- Exactly one of productId / rawMaterialId per row (enforced at the service layer).
ALTER TABLE "StockCountItem" ALTER COLUMN "productId" DROP NOT NULL;
ALTER TABLE "StockCountItem" ADD COLUMN "rawMaterialId" TEXT;
ALTER TABLE "StockCountItem"
  ADD CONSTRAINT "StockCountItem_rawMaterialId_fkey"
  FOREIGN KEY ("rawMaterialId") REFERENCES "RawMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "StockCountItem_rawMaterialId_idx" ON "StockCountItem"("rawMaterialId");
-- Widen precision so ingredient quantities (kg/L with 3 decimals) fit.
ALTER TABLE "StockCountItem" ALTER COLUMN "expected" TYPE DECIMAL(12,3);
ALTER TABLE "StockCountItem" ALTER COLUMN "counted" TYPE DECIMAL(12,3);
-- Only lines the cashier actually counted get applied on confirm.
ALTER TABLE "StockCountItem" ADD COLUMN "countedAt" TIMESTAMP(3);
