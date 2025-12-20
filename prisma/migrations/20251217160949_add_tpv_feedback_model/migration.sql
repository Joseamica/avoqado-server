-- CreateEnum
CREATE TYPE "TpvFeedbackType" AS ENUM ('BUG', 'FEATURE');

-- CreateTable
CREATE TABLE "TpvFeedback" (
    "id" TEXT NOT NULL,
    "feedbackType" "TpvFeedbackType" NOT NULL,
    "message" TEXT NOT NULL,
    "venueSlug" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "buildVersion" TEXT NOT NULL,
    "androidVersion" TEXT NOT NULL,
    "deviceModel" TEXT NOT NULL,
    "deviceManufacturer" TEXT NOT NULL,
    "emailSent" BOOLEAN NOT NULL DEFAULT false,
    "emailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TpvFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TpvFeedback_venueSlug_idx" ON "TpvFeedback"("venueSlug");

-- CreateIndex
CREATE INDEX "TpvFeedback_feedbackType_idx" ON "TpvFeedback"("feedbackType");

-- CreateIndex
CREATE INDEX "TpvFeedback_createdAt_idx" ON "TpvFeedback"("createdAt");
