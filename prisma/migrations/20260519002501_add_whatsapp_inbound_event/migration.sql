-- CreateEnum
CREATE TYPE "public"."WhatsappInboundRouting" AS ENUM ('ACTIVATION_CONSUMED', 'ACTIVATION_FAILED', 'DEACTIVATION_REDIRECT', 'VENUE_REPLY_ROUTED', 'VENUE_REPLY_ORPHAN', 'VENUE_REPLY_NO_CONTEXT', 'NON_TEXT_REJECTED', 'IGNORED');

-- CreateTable
CREATE TABLE "public"."WhatsappInboundEvent" (
    "id" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "fromPhone" TEXT NOT NULL,
    "messageType" TEXT NOT NULL,
    "rawBody" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "routedAs" "public"."WhatsappInboundRouting",
    "routedSessionId" TEXT,
    "processedAt" TIMESTAMP(3),
    "replyWamid" TEXT,
    "replySentAt" TIMESTAMP(3),

    CONSTRAINT "WhatsappInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappInboundEvent_wamid_key" ON "public"."WhatsappInboundEvent"("wamid");

-- CreateIndex
CREATE INDEX "WhatsappInboundEvent_fromPhone_receivedAt_idx" ON "public"."WhatsappInboundEvent"("fromPhone", "receivedAt");
