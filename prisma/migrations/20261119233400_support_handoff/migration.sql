-- CreateEnum
CREATE TYPE "SupportOutcome" AS ENUM ('ANSWERED', 'LITERAL', 'JUDGE_LITERAL', 'UNKNOWN', 'CLARIFIED', 'FIXED', 'ASKED', 'OLD_VERSION', 'HANDOFF');

-- CreateEnum
CREATE TYPE "SupportNoticeKind" AS ENUM ('HANDOFF', 'DAILY_DIGEST', 'WEEKLY_REPORT');

-- CreateEnum
CREATE TYPE "SupportNoticeStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'HELD', 'UNCERTAIN');

-- AlterTable
ALTER TABLE "SupportMessage" ADD COLUMN     "handoffOffered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "outcome" "SupportOutcome";

-- CreateTable
CREATE TABLE "SupportNotice" (
    "id" TEXT NOT NULL,
    "kind" "SupportNoticeKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "SupportNoticeStatus" NOT NULL DEFAULT 'PENDING',
    "day" TEXT NOT NULL,
    "app" TEXT,
    "reason" TEXT,
    "conversationId" TEXT,
    "generation" INTEGER,
    "staffId" TEXT,
    "linkId" TEXT,
    "venueId" TEXT,
    "phoneHash" TEXT,
    "meta" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "firstAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reservedAt" TIMESTAMP(3),
    "resendId" TEXT,
    "errorCode" TEXT,
    "digestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SupportNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportEvent" (
    "id" TEXT NOT NULL,
    "kind" "SupportOutcome" NOT NULL,
    "app" TEXT,
    "guideIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conversationId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportNotice_dedupeKey_key" ON "SupportNotice"("dedupeKey");

-- CreateIndex
CREATE INDEX "SupportNotice_status_nextAttemptAt_id_idx" ON "SupportNotice"("status", "nextAttemptAt", "id");

-- CreateIndex
CREATE INDEX "SupportNotice_kind_day_status_idx" ON "SupportNotice"("kind", "day", "status");

-- CreateIndex
CREATE INDEX "SupportNotice_createdAt_id_idx" ON "SupportNotice"("createdAt", "id");

-- CreateIndex
CREATE INDEX "SupportEvent_createdAt_id_idx" ON "SupportEvent"("createdAt", "id");

-- CreateIndex
CREATE INDEX "SupportEvent_conversationId_generation_sequence_idx" ON "SupportEvent"("conversationId", "generation", "sequence");

