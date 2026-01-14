/*
  Warnings:

  - A unique constraint covering the columns `[milestoneId,staffId,periodStart]` on the table `MilestoneAchievement` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `period` to the `CommissionMilestone` table without a default value. This is not possible if the table is not empty.
  - Added the required column `staffId` to the `CommissionPayout` table without a default value. This is not possible if the table is not empty.
  - Added the required column `periodEnd` to the `MilestoneAchievement` table without a default value. This is not possible if the table is not empty.
  - Added the required column `periodStart` to the `MilestoneAchievement` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "MilestoneAchievement_milestoneId_staffId_key";

-- AlterTable
ALTER TABLE "CommissionClawback" ADD COLUMN     "refundPaymentId" TEXT;

-- AlterTable
ALTER TABLE "CommissionMilestone" ADD COLUMN     "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "effectiveTo" TIMESTAMP(3),
ADD COLUMN     "period" "TierPeriod" NOT NULL;

-- AlterTable
ALTER TABLE "CommissionOverride" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "excludeFromCommissions" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "CommissionPayout" ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentReference" TEXT,
ADD COLUMN     "staffId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "CommissionSummary" ADD COLUMN     "deductionAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "grossAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "netAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CommissionTier" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "MilestoneAchievement" ADD COLUMN     "achievedValue" DECIMAL(12,2),
ADD COLUMN     "includedInSummaryId" TEXT,
ADD COLUMN     "periodEnd" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "periodStart" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "CommissionClawback_refundPaymentId_idx" ON "CommissionClawback"("refundPaymentId");

-- CreateIndex
CREATE INDEX "CommissionOverride_active_idx" ON "CommissionOverride"("active");

-- CreateIndex
CREATE INDEX "CommissionPayout_staffId_idx" ON "CommissionPayout"("staffId");

-- CreateIndex
CREATE INDEX "CommissionPayout_paidAt_idx" ON "CommissionPayout"("paidAt");

-- CreateIndex
CREATE INDEX "CommissionTier_active_idx" ON "CommissionTier"("active");

-- CreateIndex
CREATE INDEX "MilestoneAchievement_includedInSummaryId_idx" ON "MilestoneAchievement"("includedInSummaryId");

-- CreateIndex
CREATE INDEX "MilestoneAchievement_periodStart_periodEnd_idx" ON "MilestoneAchievement"("periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneAchievement_milestoneId_staffId_periodStart_key" ON "MilestoneAchievement"("milestoneId", "staffId", "periodStart");

-- AddForeignKey
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionClawback" ADD CONSTRAINT "CommissionClawback_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
