-- CreateEnum
CREATE TYPE "public"."VenueChatDirection" AS ENUM ('INBOUND_FROM_CUSTOMER', 'INBOUND_FROM_VENUE', 'OUTBOUND_TO_CUSTOMER_EMAIL');

-- CreateEnum
CREATE TYPE "public"."WhatsappTransport" AS ENUM ('TEMPLATE', 'SERVICE');

-- CreateEnum
CREATE TYPE "public"."RelayStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'SENT', 'SENT_NO_WAMID', 'FAILED');

-- CreateTable
CREATE TABLE "public"."VenueChatMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "direction" "public"."VenueChatDirection" NOT NULL,
    "body" TEXT NOT NULL,
    "whatsappMessageId" TEXT,
    "whatsappContextId" TEXT,
    "emailMessageId" TEXT,
    "whatsappTransport" "public"."WhatsappTransport",
    "relayStatus" "public"."RelayStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "sendAttemptedAt" TIMESTAMP(3),
    "sendErrorCode" TEXT,
    "sendErrorMessage" TEXT,
    "clientMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VenueChatMessage_whatsappMessageId_key" ON "public"."VenueChatMessage"("whatsappMessageId");

-- CreateIndex
CREATE INDEX "VenueChatMessage_sessionId_createdAt_id_idx" ON "public"."VenueChatMessage"("sessionId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "VenueChatMessage_whatsappContextId_idx" ON "public"."VenueChatMessage"("whatsappContextId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueChatMessage_sessionId_clientMessageId_key" ON "public"."VenueChatMessage"("sessionId", "clientMessageId");

-- AddForeignKey
ALTER TABLE "public"."VenueChatMessage" ADD CONSTRAINT "VenueChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."VenueChatSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
