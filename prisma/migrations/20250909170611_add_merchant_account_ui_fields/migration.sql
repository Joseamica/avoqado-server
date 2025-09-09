-- AlterTable
ALTER TABLE "public"."MerchantAccount" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "displayOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "MerchantAccount_active_idx" ON "public"."MerchantAccount"("active");

-- CreateIndex
CREATE INDEX "MerchantAccount_displayOrder_idx" ON "public"."MerchantAccount"("displayOrder");
