-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('BUNDLE', 'COMBO', 'DISCOUNT');

-- CreateEnum
CREATE TYPE "PromotionPricingMode" AS ENUM ('FIXED_TOTAL', 'PER_UNIT');

-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PromotionPanelMode" AS ENUM ('HIDDEN', 'TAB', 'SIDE_PANEL');

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "orderPromotionId" TEXT;

-- AlterTable
ALTER TABLE "VenueSettings" ADD COLUMN     "promotionsPanelCashier" "PromotionPanelMode" NOT NULL DEFAULT 'TAB',
ADD COLUMN     "promotionsPanelCustomer" "PromotionPanelMode" NOT NULL DEFAULT 'SIDE_PANEL';

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "type" "PromotionType" NOT NULL,
    "pricingMode" "PromotionPricingMode" NOT NULL,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "discountId" TEXT,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "daysOfWeek" INTEGER[],
    "timeFrom" TEXT,
    "timeUntil" TEXT,
    "status" "PromotionStatus" NOT NULL DEFAULT 'DRAFT',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionGroup" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "minSelect" INTEGER NOT NULL DEFAULT 1,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PromotionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionOption" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "chargedQuantity" INTEGER NOT NULL DEFAULT 1,
    "priceDeltaCents" INTEGER NOT NULL DEFAULT 0,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PromotionOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderPromotion" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL,
    "netCents" INTEGER NOT NULL,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Promotion_venueId_status_idx" ON "Promotion"("venueId", "status");

-- CreateIndex
CREATE INDEX "Promotion_venueId_displayOrder_idx" ON "Promotion"("venueId", "displayOrder");

-- CreateIndex
CREATE INDEX "PromotionGroup_promotionId_idx" ON "PromotionGroup"("promotionId");

-- CreateIndex
CREATE INDEX "PromotionOption_groupId_idx" ON "PromotionOption"("groupId");

-- CreateIndex
CREATE INDEX "PromotionOption_productId_idx" ON "PromotionOption"("productId");

-- CreateIndex
CREATE INDEX "OrderPromotion_promotionId_idx" ON "OrderPromotion"("promotionId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderPromotion_orderId_instanceId_key" ON "OrderPromotion"("orderId", "instanceId");

-- CreateIndex
CREATE INDEX "OrderItem_orderPromotionId_idx" ON "OrderItem"("orderPromotionId");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderPromotionId_fkey" FOREIGN KEY ("orderPromotionId") REFERENCES "OrderPromotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "Discount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionGroup" ADD CONSTRAINT "PromotionGroup_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionOption" ADD CONSTRAINT "PromotionOption_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PromotionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionOption" ADD CONSTRAINT "PromotionOption_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPromotion" ADD CONSTRAINT "OrderPromotion_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPromotion" ADD CONSTRAINT "OrderPromotion_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
