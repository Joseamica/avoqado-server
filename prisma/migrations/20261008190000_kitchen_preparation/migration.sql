-- Additive. Existing tickets keep their legacy behavior and are not backfilled as delivered.
ALTER TABLE "KdsOrder" ADD COLUMN "preparationVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "KdsOrderItem" ADD COLUMN "serviceCourse" JSONB,
  ADD COLUMN "orderPromotionId" TEXT,
  ADD COLUMN "preparation" JSONB,
  ADD COLUMN "preparationRevision" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "KdsOrderItem_orderItemId_kdsOrderId_idx" ON "KdsOrderItem"("orderItemId", "kdsOrderId");
