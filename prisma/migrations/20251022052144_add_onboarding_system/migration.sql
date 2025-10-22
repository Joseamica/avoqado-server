-- CreateEnum
CREATE TYPE "public"."OnboardingType" AS ENUM ('DEMO', 'REAL');

-- CreateEnum
CREATE TYPE "public"."PremiumFeature" AS ENUM ('INVENTORY', 'ADVANCED_REPORTS', 'AI_ASSISTANT', 'ONLINE_ORDERING');

-- DropIndex
DROP INDEX "public"."Product_inventoryMethod_idx";

-- AlterTable
ALTER TABLE "public"."Organization" ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingStep" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."Venue" ADD COLUMN     "demoExpiresAt" TIMESTAMP(3),
ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "public"."OnboardingProgress" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "completedSteps" JSONB NOT NULL,
    "step1_userInfo" JSONB,
    "step2_onboardingType" "public"."OnboardingType",
    "step3_businessInfo" JSONB,
    "step4_menuData" JSONB,
    "step5_teamInvites" JSONB[],
    "step6_selectedFeatures" TEXT[],
    "step7_paymentInfo" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingProgress_organizationId_key" ON "public"."OnboardingProgress"("organizationId");

-- CreateIndex
CREATE INDEX "OnboardingProgress_organizationId_idx" ON "public"."OnboardingProgress"("organizationId");

-- CreateIndex
CREATE INDEX "OnboardingProgress_currentStep_idx" ON "public"."OnboardingProgress"("currentStep");

-- CreateIndex
CREATE INDEX "OnboardingProgress_completedAt_idx" ON "public"."OnboardingProgress"("completedAt");

-- AddForeignKey
ALTER TABLE "public"."OnboardingProgress" ADD CONSTRAINT "OnboardingProgress_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
