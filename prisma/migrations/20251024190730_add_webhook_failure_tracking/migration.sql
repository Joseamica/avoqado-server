-- AlterTable
ALTER TABLE "public"."StripeWebhookEvent"
ADD COLUMN "failureReason" TEXT,
ADD COLUMN "failedAt" TIMESTAMP(3),
ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_retryCount_idx" ON "public"."StripeWebhookEvent"("retryCount");
