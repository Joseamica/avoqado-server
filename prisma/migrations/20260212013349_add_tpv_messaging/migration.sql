-- CreateEnum
CREATE TYPE "public"."TpvMessageType" AS ENUM ('ANNOUNCEMENT', 'SURVEY', 'ACTION');

-- CreateEnum
CREATE TYPE "public"."TpvMessagePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "public"."TpvMessageTarget" AS ENUM ('ALL_TERMINALS', 'SPECIFIC_TERMINALS');

-- CreateEnum
CREATE TYPE "public"."TpvMessageStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."TpvMessageDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'DISMISSED');

-- CreateTable
CREATE TABLE "public"."tpv_messages" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "type" "public"."TpvMessageType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "priority" "public"."TpvMessagePriority" NOT NULL DEFAULT 'NORMAL',
    "requiresAck" BOOLEAN NOT NULL DEFAULT false,
    "surveyOptions" JSONB,
    "surveyMultiSelect" BOOLEAN NOT NULL DEFAULT false,
    "actionLabel" TEXT,
    "actionType" TEXT,
    "actionPayload" JSONB,
    "targetType" "public"."TpvMessageTarget" NOT NULL,
    "targetTerminalIds" TEXT[],
    "scheduledFor" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "status" "public"."TpvMessageStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tpv_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."tpv_message_deliveries" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "status" "public"."TpvMessageDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "deliveredAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tpv_message_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."tpv_message_responses" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "selectedOptions" TEXT[],
    "respondedBy" TEXT,
    "respondedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tpv_message_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tpv_messages_venueId_status_idx" ON "public"."tpv_messages"("venueId", "status");

-- CreateIndex
CREATE INDEX "tpv_messages_status_scheduledFor_idx" ON "public"."tpv_messages"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "tpv_messages_createdAt_idx" ON "public"."tpv_messages"("createdAt");

-- CreateIndex
CREATE INDEX "tpv_message_deliveries_terminalId_status_idx" ON "public"."tpv_message_deliveries"("terminalId", "status");

-- CreateIndex
CREATE INDEX "tpv_message_deliveries_messageId_status_idx" ON "public"."tpv_message_deliveries"("messageId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tpv_message_deliveries_messageId_terminalId_key" ON "public"."tpv_message_deliveries"("messageId", "terminalId");

-- CreateIndex
CREATE INDEX "tpv_message_responses_messageId_idx" ON "public"."tpv_message_responses"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "tpv_message_responses_messageId_terminalId_key" ON "public"."tpv_message_responses"("messageId", "terminalId");

-- AddForeignKey
ALTER TABLE "public"."tpv_messages" ADD CONSTRAINT "tpv_messages_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tpv_message_deliveries" ADD CONSTRAINT "tpv_message_deliveries_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."tpv_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tpv_message_deliveries" ADD CONSTRAINT "tpv_message_deliveries_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "public"."Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tpv_message_responses" ADD CONSTRAINT "tpv_message_responses_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."tpv_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tpv_message_responses" ADD CONSTRAINT "tpv_message_responses_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "public"."Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
