-- CreateEnum
CREATE TYPE "AccountingPeriodStatus" AS ENUM ('CLOSED', 'OPEN');

-- CreateTable
CREATE TABLE "AccountingPeriodLock" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rfc" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" "AccountingPeriodStatus" NOT NULL DEFAULT 'CLOSED',
    "reason" TEXT,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reopenedById" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingPeriodLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountingPeriodLock_organizationId_rfc_status_idx" ON "AccountingPeriodLock"("organizationId", "rfc", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingPeriodLock_organizationId_rfc_period_key" ON "AccountingPeriodLock"("organizationId", "rfc", "period");
