-- AlterTable
ALTER TABLE "public"."OnboardingProgress" ADD COLUMN     "privacyAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsIpAddress" TEXT,
ADD COLUMN     "termsVersion" TEXT,
ADD COLUMN     "v2SetupData" JSONB,
ADD COLUMN     "wizardVersion" INTEGER NOT NULL DEFAULT 1;
