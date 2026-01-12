-- CreateEnum
CREATE TYPE "CommissionRecipient" AS ENUM ('CREATOR', 'SERVER', 'PROCESSOR');

-- CreateEnum
CREATE TYPE "CommissionTrigger" AS ENUM ('PER_PAYMENT', 'PER_ORDER');

-- CreateEnum
CREATE TYPE "CommissionCalcType" AS ENUM ('PERCENTAGE', 'FIXED', 'TIERED', 'MILESTONE', 'MANUAL');

-- CreateEnum
CREATE TYPE "TierType" AS ENUM ('BY_QUANTITY', 'BY_AMOUNT');

-- CreateEnum
CREATE TYPE "TierPeriod" AS ENUM ('DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "MilestoneTargetType" AS ENUM ('ORDER_QUANTITY', 'SALES_AMOUNT', 'PRODUCT_QUANTITY', 'CATEGORY_QUANTITY', 'CATEGORY_AMOUNT');

-- CreateEnum
CREATE TYPE "BonusType" AS ENUM ('FIXED_AMOUNT', 'PERCENTAGE_OF_SALES', 'PERCENTAGE_OF_TARGET');

-- CreateEnum
CREATE TYPE "CommissionCalcStatus" AS ENUM ('CALCULATED', 'AGGREGATED', 'VOIDED');

-- CreateEnum
CREATE TYPE "CommissionSummaryStatus" AS ENUM ('DRAFT', 'CALCULATED', 'PENDING_APPROVAL', 'APPROVED', 'DISPUTED', 'PAID');

-- CreateEnum
CREATE TYPE "CommissionPayoutStatus" AS ENUM ('PENDING', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClawbackReason" AS ENUM ('REFUND', 'CHARGEBACK', 'CORRECTION', 'FRAUD');

-- CreateTable
CREATE TABLE "CommissionConfig" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "orgId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "recipient" "CommissionRecipient" NOT NULL DEFAULT 'SERVER',
    "trigger" "CommissionTrigger" NOT NULL DEFAULT 'PER_PAYMENT',
    "calcType" "CommissionCalcType" NOT NULL DEFAULT 'PERCENTAGE',
    "defaultRate" DECIMAL(5,4) NOT NULL,
    "minAmount" DECIMAL(10,2),
    "maxAmount" DECIMAL(10,2),
    "includeTips" BOOLEAN NOT NULL DEFAULT false,
    "includeDiscount" BOOLEAN NOT NULL DEFAULT false,
    "includeTax" BOOLEAN NOT NULL DEFAULT false,
    "roleRates" JSONB,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionOverride" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "customRate" DECIMAL(5,4) NOT NULL,
    "reason" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionTier" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "tierLevel" INTEGER NOT NULL,
    "tierName" TEXT NOT NULL,
    "tierType" "TierType" NOT NULL,
    "tierPeriod" "TierPeriod" NOT NULL,
    "minThreshold" DECIMAL(12,2) NOT NULL,
    "maxThreshold" DECIMAL(12,2),
    "rate" DECIMAL(5,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionMilestone" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "targetType" "MilestoneTargetType" NOT NULL,
    "targetValue" DECIMAL(12,2) NOT NULL,
    "productId" TEXT,
    "categoryId" TEXT,
    "bonusType" "BonusType" NOT NULL,
    "bonusValue" DECIMAL(10,2) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneAchievement" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "currentValue" DECIMAL(12,2) NOT NULL,
    "achieved" BOOLEAN NOT NULL DEFAULT false,
    "achievedAt" TIMESTAMP(3),
    "bonusAmount" DECIMAL(10,2),
    "bonusPaidAt" TIMESTAMP(3),
    "bonusPaidIn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MilestoneAchievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionCalculation" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "paymentId" TEXT,
    "orderId" TEXT,
    "shiftId" TEXT,
    "configId" TEXT NOT NULL,
    "baseAmount" DECIMAL(12,2) NOT NULL,
    "tipAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "effectiveRate" DECIMAL(5,4) NOT NULL,
    "grossCommission" DECIMAL(10,2) NOT NULL,
    "netCommission" DECIMAL(10,2) NOT NULL,
    "calcType" "CommissionCalcType" NOT NULL,
    "tier" INTEGER,
    "tierName" TEXT,
    "status" "CommissionCalcStatus" NOT NULL DEFAULT 'CALCULATED',
    "aggregatedAt" TIMESTAMP(3),
    "summaryId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionCalculation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionSummary" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "periodType" "TierPeriod" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "totalSales" DECIMAL(14,2) NOT NULL,
    "totalTips" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalCommissions" DECIMAL(12,2) NOT NULL,
    "totalBonuses" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalClawbacks" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(12,2) NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "paymentCount" INTEGER NOT NULL DEFAULT 0,
    "status" "CommissionSummaryStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "disputedAt" TIMESTAMP(3),
    "disputeReason" TEXT,
    "disputeResolvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionPayout" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "summaryId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "reference" TEXT,
    "status" "CommissionPayoutStatus" NOT NULL DEFAULT 'PENDING',
    "processedAt" TIMESTAMP(3),
    "processedById" TEXT,
    "failureReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionClawback" (
    "id" TEXT NOT NULL,
    "calculationId" TEXT NOT NULL,
    "summaryId" TEXT NOT NULL,
    "reason" "ClawbackReason" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "refundId" TEXT,
    "appliedToSummaryId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionClawback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionConfig_venueId_active_idx" ON "CommissionConfig"("venueId", "active");

-- CreateIndex
CREATE INDEX "CommissionConfig_venueId_effectiveFrom_effectiveTo_idx" ON "CommissionConfig"("venueId", "effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE INDEX "CommissionConfig_orgId_idx" ON "CommissionConfig"("orgId");

-- CreateIndex
CREATE INDEX "CommissionOverride_configId_idx" ON "CommissionOverride"("configId");

-- CreateIndex
CREATE INDEX "CommissionOverride_staffId_effectiveFrom_effectiveTo_idx" ON "CommissionOverride"("staffId", "effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE INDEX "CommissionOverride_venueId_idx" ON "CommissionOverride"("venueId");

-- CreateIndex
CREATE INDEX "CommissionTier_configId_idx" ON "CommissionTier"("configId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionTier_configId_tierLevel_key" ON "CommissionTier"("configId", "tierLevel");

-- CreateIndex
CREATE INDEX "CommissionMilestone_configId_idx" ON "CommissionMilestone"("configId");

-- CreateIndex
CREATE INDEX "CommissionMilestone_periodStart_periodEnd_idx" ON "CommissionMilestone"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "MilestoneAchievement_staffId_idx" ON "MilestoneAchievement"("staffId");

-- CreateIndex
CREATE INDEX "MilestoneAchievement_venueId_idx" ON "MilestoneAchievement"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneAchievement_milestoneId_staffId_key" ON "MilestoneAchievement"("milestoneId", "staffId");

-- CreateIndex
CREATE INDEX "CommissionCalculation_venueId_staffId_idx" ON "CommissionCalculation"("venueId", "staffId");

-- CreateIndex
CREATE INDEX "CommissionCalculation_paymentId_idx" ON "CommissionCalculation"("paymentId");

-- CreateIndex
CREATE INDEX "CommissionCalculation_orderId_idx" ON "CommissionCalculation"("orderId");

-- CreateIndex
CREATE INDEX "CommissionCalculation_status_idx" ON "CommissionCalculation"("status");

-- CreateIndex
CREATE INDEX "CommissionCalculation_summaryId_idx" ON "CommissionCalculation"("summaryId");

-- CreateIndex
CREATE INDEX "CommissionCalculation_staffId_calculatedAt_idx" ON "CommissionCalculation"("staffId", "calculatedAt");

-- CreateIndex
CREATE INDEX "CommissionSummary_venueId_periodStart_idx" ON "CommissionSummary"("venueId", "periodStart");

-- CreateIndex
CREATE INDEX "CommissionSummary_staffId_idx" ON "CommissionSummary"("staffId");

-- CreateIndex
CREATE INDEX "CommissionSummary_status_idx" ON "CommissionSummary"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionSummary_venueId_staffId_periodType_periodStart_key" ON "CommissionSummary"("venueId", "staffId", "periodType", "periodStart");

-- CreateIndex
CREATE INDEX "CommissionPayout_venueId_idx" ON "CommissionPayout"("venueId");

-- CreateIndex
CREATE INDEX "CommissionPayout_summaryId_idx" ON "CommissionPayout"("summaryId");

-- CreateIndex
CREATE INDEX "CommissionPayout_status_idx" ON "CommissionPayout"("status");

-- CreateIndex
CREATE INDEX "CommissionClawback_calculationId_idx" ON "CommissionClawback"("calculationId");

-- CreateIndex
CREATE INDEX "CommissionClawback_summaryId_idx" ON "CommissionClawback"("summaryId");

-- AddForeignKey
ALTER TABLE "CommissionConfig" ADD CONSTRAINT "CommissionConfig_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionConfig" ADD CONSTRAINT "CommissionConfig_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionConfig" ADD CONSTRAINT "CommissionConfig_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionOverride" ADD CONSTRAINT "CommissionOverride_configId_fkey" FOREIGN KEY ("configId") REFERENCES "CommissionConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionOverride" ADD CONSTRAINT "CommissionOverride_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionOverride" ADD CONSTRAINT "CommissionOverride_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionOverride" ADD CONSTRAINT "CommissionOverride_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionTier" ADD CONSTRAINT "CommissionTier_configId_fkey" FOREIGN KEY ("configId") REFERENCES "CommissionConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionMilestone" ADD CONSTRAINT "CommissionMilestone_configId_fkey" FOREIGN KEY ("configId") REFERENCES "CommissionConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionMilestone" ADD CONSTRAINT "CommissionMilestone_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionMilestone" ADD CONSTRAINT "CommissionMilestone_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MenuCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneAchievement" ADD CONSTRAINT "MilestoneAchievement_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "CommissionMilestone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneAchievement" ADD CONSTRAINT "MilestoneAchievement_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneAchievement" ADD CONSTRAINT "MilestoneAchievement_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionCalculation" ADD CONSTRAINT "CommissionCalculation_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionCalculation" ADD CONSTRAINT "CommissionCalculation_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionCalculation" ADD CONSTRAINT "CommissionCalculation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionCalculation" ADD CONSTRAINT "CommissionCalculation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionCalculation" ADD CONSTRAINT "CommissionCalculation_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionCalculation" ADD CONSTRAINT "CommissionCalculation_configId_fkey" FOREIGN KEY ("configId") REFERENCES "CommissionConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionCalculation" ADD CONSTRAINT "CommissionCalculation_summaryId_fkey" FOREIGN KEY ("summaryId") REFERENCES "CommissionSummary"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionSummary" ADD CONSTRAINT "CommissionSummary_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionSummary" ADD CONSTRAINT "CommissionSummary_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionSummary" ADD CONSTRAINT "CommissionSummary_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_summaryId_fkey" FOREIGN KEY ("summaryId") REFERENCES "CommissionSummary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionClawback" ADD CONSTRAINT "CommissionClawback_calculationId_fkey" FOREIGN KEY ("calculationId") REFERENCES "CommissionCalculation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionClawback" ADD CONSTRAINT "CommissionClawback_summaryId_fkey" FOREIGN KEY ("summaryId") REFERENCES "CommissionSummary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
