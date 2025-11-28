-- CreateEnum
CREATE TYPE "public"."DiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'COMP');

-- CreateEnum
CREATE TYPE "public"."DiscountScope" AS ENUM ('ORDER', 'ITEM', 'CATEGORY', 'MODIFIER', 'MODIFIER_GROUP', 'CUSTOMER_GROUP', 'QUANTITY');

-- CreateTable
CREATE TABLE "public"."Discount" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "public"."DiscountType" NOT NULL,
    "value" DECIMAL(10,4) NOT NULL,
    "scope" "public"."DiscountScope" NOT NULL DEFAULT 'ORDER',
    "targetItemIds" TEXT[],
    "targetCategoryIds" TEXT[],
    "targetModifierIds" TEXT[],
    "targetModifierGroupIds" TEXT[],
    "customerGroupId" TEXT,
    "isAutomatic" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "minPurchaseAmount" DECIMAL(10,2),
    "maxDiscountAmount" DECIMAL(10,2),
    "minQuantity" INTEGER,
    "buyQuantity" INTEGER,
    "getQuantity" INTEGER,
    "getDiscountPercent" DECIMAL(5,2),
    "buyItemIds" TEXT[],
    "getItemIds" TEXT[],
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "daysOfWeek" INTEGER[],
    "timeFrom" TEXT,
    "timeUntil" TEXT,
    "maxTotalUses" INTEGER,
    "maxUsesPerCustomer" INTEGER,
    "currentUses" INTEGER NOT NULL DEFAULT 0,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "compReason" TEXT,
    "applyBeforeTax" BOOLEAN NOT NULL DEFAULT true,
    "modifyTaxBasis" BOOLEAN NOT NULL DEFAULT true,
    "isStackable" BOOLEAN NOT NULL DEFAULT false,
    "stackPriority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Discount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CouponCode" (
    "id" TEXT NOT NULL,
    "discountId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "maxUses" INTEGER,
    "maxUsesPerCustomer" INTEGER,
    "currentUses" INTEGER NOT NULL DEFAULT 0,
    "minPurchaseAmount" DECIMAL(10,2),
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CouponCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CouponRedemption" (
    "id" TEXT NOT NULL,
    "couponCodeId" TEXT NOT NULL,
    "customerId" TEXT,
    "orderId" TEXT NOT NULL,
    "amountSaved" DECIMAL(10,2) NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CustomerDiscount" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "discountId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "maxUses" INTEGER,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerDiscount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrderDiscount" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "discountId" TEXT,
    "couponCodeId" TEXT,
    "type" "public"."DiscountType" NOT NULL,
    "name" TEXT NOT NULL,
    "value" DECIMAL(10,4) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "taxReduction" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "isComp" BOOLEAN NOT NULL DEFAULT false,
    "isAutomatic" BOOLEAN NOT NULL DEFAULT false,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "compReason" TEXT,
    "appliedById" TEXT,
    "authorizedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDiscount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Discount_venueId_idx" ON "public"."Discount"("venueId");

-- CreateIndex
CREATE INDEX "Discount_isAutomatic_idx" ON "public"."Discount"("isAutomatic");

-- CreateIndex
CREATE INDEX "Discount_active_idx" ON "public"."Discount"("active");

-- CreateIndex
CREATE INDEX "Discount_customerGroupId_idx" ON "public"."Discount"("customerGroupId");

-- CreateIndex
CREATE INDEX "Discount_validFrom_validUntil_idx" ON "public"."Discount"("validFrom", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "CouponCode_code_key" ON "public"."CouponCode"("code");

-- CreateIndex
CREATE INDEX "CouponCode_discountId_idx" ON "public"."CouponCode"("discountId");

-- CreateIndex
CREATE INDEX "CouponCode_code_idx" ON "public"."CouponCode"("code");

-- CreateIndex
CREATE INDEX "CouponCode_active_idx" ON "public"."CouponCode"("active");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_orderId_key" ON "public"."CouponRedemption"("orderId");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponCodeId_idx" ON "public"."CouponRedemption"("couponCodeId");

-- CreateIndex
CREATE INDEX "CouponRedemption_customerId_idx" ON "public"."CouponRedemption"("customerId");

-- CreateIndex
CREATE INDEX "CouponRedemption_orderId_idx" ON "public"."CouponRedemption"("orderId");

-- CreateIndex
CREATE INDEX "CustomerDiscount_customerId_idx" ON "public"."CustomerDiscount"("customerId");

-- CreateIndex
CREATE INDEX "CustomerDiscount_discountId_idx" ON "public"."CustomerDiscount"("discountId");

-- CreateIndex
CREATE INDEX "CustomerDiscount_active_idx" ON "public"."CustomerDiscount"("active");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerDiscount_customerId_discountId_key" ON "public"."CustomerDiscount"("customerId", "discountId");

-- CreateIndex
CREATE INDEX "OrderDiscount_orderId_idx" ON "public"."OrderDiscount"("orderId");

-- CreateIndex
CREATE INDEX "OrderDiscount_discountId_idx" ON "public"."OrderDiscount"("discountId");

-- CreateIndex
CREATE INDEX "OrderDiscount_couponCodeId_idx" ON "public"."OrderDiscount"("couponCodeId");

-- AddForeignKey
ALTER TABLE "public"."Discount" ADD CONSTRAINT "Discount_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Discount" ADD CONSTRAINT "Discount_customerGroupId_fkey" FOREIGN KEY ("customerGroupId") REFERENCES "public"."CustomerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Discount" ADD CONSTRAINT "Discount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."StaffVenue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CouponCode" ADD CONSTRAINT "CouponCode_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "public"."Discount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponCodeId_fkey" FOREIGN KEY ("couponCodeId") REFERENCES "public"."CouponCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CouponRedemption" ADD CONSTRAINT "CouponRedemption_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CouponRedemption" ADD CONSTRAINT "CouponRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerDiscount" ADD CONSTRAINT "CustomerDiscount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerDiscount" ADD CONSTRAINT "CustomerDiscount_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "public"."Discount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerDiscount" ADD CONSTRAINT "CustomerDiscount_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "public"."StaffVenue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrderDiscount" ADD CONSTRAINT "OrderDiscount_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrderDiscount" ADD CONSTRAINT "OrderDiscount_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "public"."Discount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrderDiscount" ADD CONSTRAINT "OrderDiscount_couponCodeId_fkey" FOREIGN KEY ("couponCodeId") REFERENCES "public"."CouponCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrderDiscount" ADD CONSTRAINT "OrderDiscount_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "public"."StaffVenue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrderDiscount" ADD CONSTRAINT "OrderDiscount_authorizedById_fkey" FOREIGN KEY ("authorizedById") REFERENCES "public"."StaffVenue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
