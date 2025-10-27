-- CreateEnum
CREATE TYPE "public"."WebhookEventStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'RETRYING');

-- CreateTable
CREATE TABLE "public"."WebhookEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "public"."WebhookEventStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "processingTime" INTEGER,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "venueId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_stripeEventId_key" ON "public"."WebhookEvent"("stripeEventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_stripeEventId_idx" ON "public"."WebhookEvent"("stripeEventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_eventType_idx" ON "public"."WebhookEvent"("eventType");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_idx" ON "public"."WebhookEvent"("status");

-- CreateIndex
CREATE INDEX "WebhookEvent_venueId_idx" ON "public"."WebhookEvent"("venueId");

-- CreateIndex
CREATE INDEX "WebhookEvent_createdAt_idx" ON "public"."WebhookEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."WebhookEvent" ADD CONSTRAINT "WebhookEvent_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
