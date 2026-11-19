-- CreateEnum
CREATE TYPE "SupportMode" AS ENUM ('PUBLIC', 'PERSONAL', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportPurpose" AS ENUM ('HELP', 'LINK_CODE');

-- CreateEnum
CREATE TYPE "SupportMessageStatus" AS ENUM ('QUEUED', 'CLAIMED', 'ANSWER_READY', 'AI_UNKNOWN', 'SEND_UNKNOWN', 'SENT', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SupportAttemptKind" AS ENUM ('AI', 'SEND');

-- CreateEnum
CREATE TYPE "SupportAttemptState" AS ENUM ('RESERVED', 'STARTED', 'SUCCEEDED', 'DEFINITIVE_FAILURE', 'UNKNOWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WhatsappInboundRouting" ADD VALUE 'SUPPORT_QUEUED';
ALTER TYPE "WhatsappInboundRouting" ADD VALUE 'SUPPORT_IGNORED';

-- AlterTable
ALTER TABLE "WhatsappInboundEvent" ADD COLUMN     "receiverId" TEXT,
ADD COLUMN     "supportTombstoneUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "strongAuthAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SupportWhatsappLink" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportWhatsappLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportLinkChallenge" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportLinkChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportConversation" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "linkId" TEXT,
    "staffId" TEXT,
    "orgId" TEXT,
    "venueId" TEXT,
    "app" TEXT,
    "appVersion" TEXT,
    "deviceFamily" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "nextSequence" INTEGER NOT NULL DEFAULT 0,
    "mode" "SupportMode" NOT NULL DEFAULT 'PUBLIC',
    "pendingSelection" TEXT,
    "selectionOptions" JSONB,
    "selectionExpiresAt" TIMESTAMP(3),
    "noticeAcceptedAt" TIMESTAMP(3),
    "lastUserMessageAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "inboundEventId" TEXT,
    "challengeId" TEXT,
    "purpose" "SupportPurpose" NOT NULL DEFAULT 'HELP',
    "conversationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "status" "SupportMessageStatus" NOT NULL DEFAULT 'QUEUED',
    "answer" TEXT,
    "answerCipher" TEXT,
    "accessFingerprint" TEXT,
    "sourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outboundWamid" TEXT,
    "claimToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retryOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAttempt" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "kind" "SupportAttemptKind" NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "claimToken" TEXT NOT NULL,
    "state" "SupportAttemptState" NOT NULL DEFAULT 'RESERVED',
    "requestId" TEXT,
    "reservedUsd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "actualUsd" DECIMAL(18,8),
    "usage" JSONB,
    "pricingVersion" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SupportAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportBudget" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "heldUsd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "spentUsd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportBudget_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportWhatsappLink_staffId_key" ON "SupportWhatsappLink"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportWhatsappLink_phone_key" ON "SupportWhatsappLink"("phone");

-- CreateIndex
CREATE INDEX "SupportLinkChallenge_staffId_createdAt_idx" ON "SupportLinkChallenge"("staffId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportLinkChallenge_phone_createdAt_idx" ON "SupportLinkChallenge"("phone", "createdAt");

-- CreateIndex
CREATE INDEX "SupportLinkChallenge_expiresAt_id_idx" ON "SupportLinkChallenge"("expiresAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupportLinkChallenge_staffId_operationKey_key" ON "SupportLinkChallenge"("staffId", "operationKey");

-- CreateIndex
CREATE INDEX "SupportConversation_receiverId_phone_mode_idx" ON "SupportConversation"("receiverId", "phone", "mode");

-- CreateIndex
CREATE INDEX "SupportConversation_lastActivityAt_id_idx" ON "SupportConversation"("lastActivityAt", "id");

-- CreateIndex
CREATE INDEX "SupportConversation_staffId_orgId_venueId_generation_idx" ON "SupportConversation"("staffId", "orgId", "venueId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "SupportMessage_inboundEventId_key" ON "SupportMessage"("inboundEventId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportMessage_challengeId_key" ON "SupportMessage"("challengeId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportMessage_outboundWamid_key" ON "SupportMessage"("outboundWamid");

-- CreateIndex
CREATE UNIQUE INDEX "SupportMessage_retryOfId_key" ON "SupportMessage"("retryOfId");

-- CreateIndex
CREATE INDEX "SupportMessage_status_nextAttemptAt_id_idx" ON "SupportMessage"("status", "nextAttemptAt", "id");

-- CreateIndex
CREATE INDEX "SupportMessage_expiresAt_id_idx" ON "SupportMessage"("expiresAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupportMessage_conversationId_sequence_key" ON "SupportMessage"("conversationId", "sequence");

-- CreateIndex
CREATE INDEX "SupportAttempt_state_kind_startedAt_idx" ON "SupportAttempt"("state", "kind", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportAttempt_messageId_kind_ordinal_key" ON "SupportAttempt"("messageId", "kind", "ordinal");

-- AddForeignKey
ALTER TABLE "SupportLinkChallenge" ADD CONSTRAINT "SupportLinkChallenge_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportConversation" ADD CONSTRAINT "SupportConversation_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "SupportWhatsappLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_inboundEventId_fkey" FOREIGN KEY ("inboundEventId") REFERENCES "WhatsappInboundEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "SupportLinkChallenge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAttempt" ADD CONSTRAINT "SupportAttempt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SupportMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Only one open chat for a receiver and phone; closed history stays closed.
CREATE UNIQUE INDEX "SupportConversation_active_receiver_phone_key" ON "SupportConversation" ("receiverId", "phone") WHERE mode <> 'CLOSED';

ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_purpose_check" CHECK (
  (purpose = 'HELP' AND "challengeId" IS NULL AND ("inboundEventId" IS NOT NULL OR status = 'EXPIRED')) OR
  (purpose = 'LINK_CODE' AND body = '' AND answer IS NULL AND ("challengeId" IS NOT NULL OR status = 'EXPIRED')
    AND (status NOT IN ('QUEUED', 'CLAIMED', 'ANSWER_READY') OR "answerCipher" IS NOT NULL))
);
