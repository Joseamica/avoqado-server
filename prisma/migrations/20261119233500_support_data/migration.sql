-- CreateEnum
CREATE TYPE "SupportDataResult" AS ENUM ('ANSWERED', 'NO_PERMISSION', 'PLAN_REQUIRED', 'NEEDS_UNLOCK', 'PARAM_INVALID', 'NOT_OFFERED', 'OVER_CAP', 'QUERY_FAILED', 'CHECK_FAILED');

-- AlterEnum
ALTER TYPE "SupportPurpose" ADD VALUE 'DATA';

-- AlterTable
ALTER TABLE "SupportMessage" ADD COLUMN     "dataCapability" TEXT;

-- CreateTable
CREATE TABLE "SupportDataAcceptance" (
    "staffId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "noticeHash" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportDataAcceptance_pkey" PRIMARY KEY ("staffId")
);

-- CreateTable
CREATE TABLE "SupportDataUnlock" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportDataUnlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportDataQuery" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "paramsHmac" TEXT NOT NULL,
    "result" "SupportDataResult" NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportDataQuery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportDataUnlock_createdAt_id_idx" ON "SupportDataUnlock"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupportDataUnlock_staffId_venueId_day_key" ON "SupportDataUnlock"("staffId", "venueId", "day");

-- CreateIndex
CREATE INDEX "SupportDataQuery_staffId_day_idx" ON "SupportDataQuery"("staffId", "day");

-- CreateIndex
CREATE INDEX "SupportDataQuery_createdAt_id_idx" ON "SupportDataQuery"("createdAt", "id");

