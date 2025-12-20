-- CreateEnum
CREATE TYPE "CreditGrade" AS ENUM ('A', 'B', 'C', 'D');

-- CreateEnum
CREATE TYPE "CreditEligibility" AS ENUM ('ELIGIBLE', 'REVIEW_REQUIRED', 'INELIGIBLE', 'OFFER_PENDING', 'ACTIVE_LOAN');

-- CreateEnum
CREATE TYPE "TrendDirection" AS ENUM ('GROWING', 'FLAT', 'DECLINING');

-- CreateEnum
CREATE TYPE "CreditOfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "VenueCreditAssessment" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "creditScore" INTEGER NOT NULL DEFAULT 0,
    "creditGrade" "CreditGrade" NOT NULL DEFAULT 'D',
    "eligibilityStatus" "CreditEligibility" NOT NULL DEFAULT 'INELIGIBLE',
    "annualVolume" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "monthlyAverage" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currentMonthVolume" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "transactionCount12m" INTEGER NOT NULL DEFAULT 0,
    "yoyGrowthPercent" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "momGrowthPercent" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "trendDirection" "TrendDirection" NOT NULL DEFAULT 'FLAT',
    "revenueVariance" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "consistencyScore" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "daysSinceLastTx" INTEGER NOT NULL DEFAULT 0,
    "operatingDaysRatio" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "averageTicket" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "chargebackRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "refundRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "chargebackCount" INTEGER NOT NULL DEFAULT 0,
    "paymentMethodMix" JSONB,
    "recommendedCreditLimit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "suggestedFactorRate" DECIMAL(4,2) NOT NULL DEFAULT 1.15,
    "maxRepaymentPercent" DECIMAL(4,2) NOT NULL DEFAULT 0.15,
    "alerts" TEXT[],
    "flags" JSONB,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAsOf" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueCreditAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditAssessmentHistory" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "creditScore" INTEGER NOT NULL,
    "creditGrade" "CreditGrade" NOT NULL,
    "annualVolume" DECIMAL(14,2) NOT NULL,
    "monthlyVolume" DECIMAL(12,2) NOT NULL,
    "growthPercent" DECIMAL(6,2) NOT NULL,
    "snapshotDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditAssessmentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditOffer" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "offerAmount" DECIMAL(12,2) NOT NULL,
    "factorRate" DECIMAL(4,2) NOT NULL,
    "totalRepayment" DECIMAL(12,2) NOT NULL,
    "repaymentPercent" DECIMAL(4,2) NOT NULL,
    "estimatedTermDays" INTEGER NOT NULL,
    "status" "CreditOfferStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VenueCreditAssessment_venueId_key" ON "VenueCreditAssessment"("venueId");

-- CreateIndex
CREATE INDEX "VenueCreditAssessment_creditScore_idx" ON "VenueCreditAssessment"("creditScore");

-- CreateIndex
CREATE INDEX "VenueCreditAssessment_eligibilityStatus_idx" ON "VenueCreditAssessment"("eligibilityStatus");

-- CreateIndex
CREATE INDEX "VenueCreditAssessment_creditGrade_idx" ON "VenueCreditAssessment"("creditGrade");

-- CreateIndex
CREATE INDEX "CreditAssessmentHistory_assessmentId_idx" ON "CreditAssessmentHistory"("assessmentId");

-- CreateIndex
CREATE INDEX "CreditAssessmentHistory_snapshotDate_idx" ON "CreditAssessmentHistory"("snapshotDate");

-- CreateIndex
CREATE INDEX "CreditOffer_venueId_idx" ON "CreditOffer"("venueId");

-- CreateIndex
CREATE INDEX "CreditOffer_assessmentId_idx" ON "CreditOffer"("assessmentId");

-- CreateIndex
CREATE INDEX "CreditOffer_status_idx" ON "CreditOffer"("status");

-- AddForeignKey
ALTER TABLE "VenueCreditAssessment" ADD CONSTRAINT "VenueCreditAssessment_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditAssessmentHistory" ADD CONSTRAINT "CreditAssessmentHistory_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "VenueCreditAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditOffer" ADD CONSTRAINT "CreditOffer_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "VenueCreditAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditOffer" ADD CONSTRAINT "CreditOffer_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditOffer" ADD CONSTRAINT "CreditOffer_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditOffer" ADD CONSTRAINT "CreditOffer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
