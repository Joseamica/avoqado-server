-- CreateEnum
CREATE TYPE "public"."PromoterSaleType" AS ENUM ('LINEA_NUEVA', 'PORTABILIDAD');

-- CreateEnum
CREATE TYPE "public"."CashOutEntryStatus" AS ENUM ('AVAILABLE', 'WITHDRAWN', 'CLAWED_BACK');

-- CreateEnum
CREATE TYPE "public"."CashOutWithdrawalStatus" AS ENUM ('REQUESTED', 'REPORTED', 'PAID', 'FAILED');

-- CreateTable
CREATE TABLE "public"."CashOutCommissionRate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "venueId" TEXT,
    "saleType" "public"."PromoterSaleType" NOT NULL,
    "minCount" INTEGER NOT NULL,
    "maxCount" INTEGER,
    "amount" DECIMAL(10,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashOutCommissionRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CashOutScheduleDay" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "venueId" TEXT,
    "day" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashOutScheduleDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PromoterBankAccount" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT,
    "orgId" TEXT,
    "clabe" TEXT NOT NULL,
    "holderName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoterBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PromoterCommissionEntry" (
    "id" TEXT NOT NULL,
    "saleVerificationId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "saleType" "public"."PromoterSaleType" NOT NULL,
    "businessDate" DATE NOT NULL,
    "weekStart" DATE NOT NULL,
    "tier" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "public"."CashOutEntryStatus" NOT NULL DEFAULT 'AVAILABLE',
    "withdrawalId" TEXT,
    "clawedBackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoterCommissionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CashOutWithdrawal" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "grossAmount" DECIMAL(12,2) NOT NULL,
    "feeMxn" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "clabe" TEXT,
    "folio" TEXT NOT NULL,
    "status" "public"."CashOutWithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT,
    "reportedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashOutWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashOutCommissionRate_orgId_saleType_active_idx" ON "public"."CashOutCommissionRate"("orgId", "saleType", "active");

-- CreateIndex
CREATE INDEX "CashOutCommissionRate_venueId_saleType_active_idx" ON "public"."CashOutCommissionRate"("venueId", "saleType", "active");

-- CreateIndex
CREATE INDEX "CashOutScheduleDay_orgId_day_idx" ON "public"."CashOutScheduleDay"("orgId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "CashOutScheduleDay_venueId_day_key" ON "public"."CashOutScheduleDay"("venueId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "PromoterBankAccount_staffId_key" ON "public"."PromoterBankAccount"("staffId");

-- CreateIndex
CREATE INDEX "PromoterBankAccount_venueId_idx" ON "public"."PromoterBankAccount"("venueId");

-- CreateIndex
CREATE INDEX "PromoterBankAccount_orgId_idx" ON "public"."PromoterBankAccount"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoterCommissionEntry_saleVerificationId_key" ON "public"."PromoterCommissionEntry"("saleVerificationId");

-- CreateIndex
CREATE INDEX "PromoterCommissionEntry_venueId_staffId_status_idx" ON "public"."PromoterCommissionEntry"("venueId", "staffId", "status");

-- CreateIndex
CREATE INDEX "PromoterCommissionEntry_venueId_businessDate_idx" ON "public"."PromoterCommissionEntry"("venueId", "businessDate");

-- CreateIndex
CREATE INDEX "PromoterCommissionEntry_staffId_weekStart_idx" ON "public"."PromoterCommissionEntry"("staffId", "weekStart");

-- CreateIndex
CREATE INDEX "PromoterCommissionEntry_withdrawalId_idx" ON "public"."PromoterCommissionEntry"("withdrawalId");

-- CreateIndex
CREATE UNIQUE INDEX "CashOutWithdrawal_folio_key" ON "public"."CashOutWithdrawal"("folio");

-- CreateIndex
CREATE INDEX "CashOutWithdrawal_venueId_businessDate_status_idx" ON "public"."CashOutWithdrawal"("venueId", "businessDate", "status");

-- CreateIndex
CREATE INDEX "CashOutWithdrawal_staffId_idx" ON "public"."CashOutWithdrawal"("staffId");

-- CreateIndex
CREATE INDEX "CashOutWithdrawal_status_idx" ON "public"."CashOutWithdrawal"("status");

-- AddForeignKey
ALTER TABLE "public"."PromoterCommissionEntry" ADD CONSTRAINT "PromoterCommissionEntry_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "public"."CashOutWithdrawal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

