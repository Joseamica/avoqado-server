-- CreateEnum
CREATE TYPE "UpsellTriggerType" AS ENUM ('PRODUCT', 'CATEGORY', 'ALWAYS');

-- CreateEnum
CREATE TYPE "UpsellOrigin" AS ENUM ('OWNER', 'BASKET_DATA', 'AI', 'PROMOTION');

-- CreateEnum
CREATE TYPE "UpsellRuleStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'DISMISSED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "UpsellSurface" AS ENUM ('CUSTOMER_DISPLAY', 'CASHIER', 'NONE', 'HOLDOUT');

-- CreateEnum
CREATE TYPE "UpsellAiRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "upsellEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Venue" ADD COLUMN     "upsellSurfaces" JSONB;

-- CreateTable
CREATE TABLE "UpsellRule" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "triggerType" "UpsellTriggerType" NOT NULL DEFAULT 'ALWAYS',
    "triggerProductIds" TEXT[],
    "triggerCategoryIds" TEXT[],
    "suggestedProductId" TEXT NOT NULL,
    "headline" TEXT,
    "origin" "UpsellOrigin" NOT NULL,
    "status" "UpsellRuleStatus" NOT NULL DEFAULT 'PROPOSED',
    "supportCount" INTEGER,
    "lift" DECIMAL(8,4),
    "rationale" TEXT,
    "linkedDiscountId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "daysOfWeek" INTEGER[],
    "timeFrom" TEXT,
    "timeUntil" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpsellRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpsellImpression" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "orderId" TEXT,
    "shownRuleIds" TEXT[],
    "context" TEXT NOT NULL,
    "reportedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "cartSubtotalBefore" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "surface" "UpsellSurface" NOT NULL DEFAULT 'NONE',
    "shownAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "convertedAt" TIMESTAMP(3),

    CONSTRAINT "UpsellImpression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpsellAcceptance" (
    "id" TEXT NOT NULL,
    "impressionId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "orderItemExternalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpsellAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpsellAiRun" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "status" "UpsellAiRunStatus" NOT NULL DEFAULT 'RUNNING',
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "proposedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "UpsellAiRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UpsellRule_venueId_status_idx" ON "UpsellRule"("venueId", "status");

-- CreateIndex
CREATE INDEX "UpsellRule_suggestedProductId_idx" ON "UpsellRule"("suggestedProductId");

-- CreateIndex
CREATE UNIQUE INDEX "UpsellRule_venueId_dedupeKey_key" ON "UpsellRule"("venueId", "dedupeKey");

-- CreateIndex
CREATE INDEX "UpsellImpression_venueId_shownAt_idx" ON "UpsellImpression"("venueId", "shownAt");

-- CreateIndex
CREATE INDEX "UpsellImpression_orderId_idx" ON "UpsellImpression"("orderId");

-- CreateIndex
CREATE INDEX "UpsellAcceptance_ruleId_idx" ON "UpsellAcceptance"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "UpsellAcceptance_impressionId_orderItemExternalId_key" ON "UpsellAcceptance"("impressionId", "orderItemExternalId");

-- CreateIndex
CREATE INDEX "UpsellAiRun_venueId_startedAt_idx" ON "UpsellAiRun"("venueId", "startedAt");

-- CreateIndex
CREATE INDEX "UpsellAiRun_status_leaseExpiresAt_idx" ON "UpsellAiRun"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "Product_venueId_upsellEnabled_idx" ON "Product"("venueId", "upsellEnabled");

-- AddForeignKey
ALTER TABLE "UpsellRule" ADD CONSTRAINT "UpsellRule_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellRule" ADD CONSTRAINT "UpsellRule_suggestedProductId_fkey" FOREIGN KEY ("suggestedProductId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellRule" ADD CONSTRAINT "UpsellRule_linkedDiscountId_fkey" FOREIGN KEY ("linkedDiscountId") REFERENCES "Discount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellRule" ADD CONSTRAINT "UpsellRule_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "StaffVenue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellImpression" ADD CONSTRAINT "UpsellImpression_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellImpression" ADD CONSTRAINT "UpsellImpression_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellAcceptance" ADD CONSTRAINT "UpsellAcceptance_impressionId_fkey" FOREIGN KEY ("impressionId") REFERENCES "UpsellImpression"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellAcceptance" ADD CONSTRAINT "UpsellAcceptance_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "UpsellRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellAiRun" ADD CONSTRAINT "UpsellAiRun_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
