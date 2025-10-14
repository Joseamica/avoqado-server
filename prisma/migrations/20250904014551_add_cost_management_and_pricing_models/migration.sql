-- CreateEnum
CREATE TYPE "public"."AccountType" AS ENUM ('PRIMARY', 'SECONDARY', 'TERTIARY');

-- CreateEnum
CREATE TYPE "public"."TransactionCardType" AS ENUM ('DEBIT', 'CREDIT', 'AMEX', 'INTERNATIONAL', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."ProfitStatus" AS ENUM ('CALCULATED', 'VERIFIED', 'DISPUTED', 'FINALIZED');

-- CreateTable
CREATE TABLE "public"."ProviderCostStructure" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "debitRate" DECIMAL(5,4) NOT NULL,
    "creditRate" DECIMAL(5,4) NOT NULL,
    "amexRate" DECIMAL(5,4) NOT NULL,
    "internationalRate" DECIMAL(5,4) NOT NULL,
    "fixedCostPerTransaction" DECIMAL(8,4),
    "monthlyFee" DECIMAL(10,2),
    "minimumVolume" DECIMAL(12,2),
    "volumeDiscount" DECIMAL(5,4),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "proposalReference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCostStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."VenuePricingStructure" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "accountType" "public"."AccountType" NOT NULL,
    "debitRate" DECIMAL(5,4) NOT NULL,
    "creditRate" DECIMAL(5,4) NOT NULL,
    "amexRate" DECIMAL(5,4) NOT NULL,
    "internationalRate" DECIMAL(5,4) NOT NULL,
    "fixedFeePerTransaction" DECIMAL(8,4),
    "monthlyServiceFee" DECIMAL(10,2),
    "minimumMonthlyVolume" DECIMAL(12,2),
    "volumePenalty" DECIMAL(10,2),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "contractReference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenuePricingStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TransactionCost" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "transactionType" "public"."TransactionCardType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "providerRate" DECIMAL(5,4) NOT NULL,
    "providerCostAmount" DECIMAL(10,4) NOT NULL,
    "providerFixedFee" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "venueRate" DECIMAL(5,4) NOT NULL,
    "venueChargeAmount" DECIMAL(10,4) NOT NULL,
    "venueFixedFee" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "grossProfit" DECIMAL(10,4) NOT NULL,
    "profitMargin" DECIMAL(5,4) NOT NULL,
    "providerCostStructureId" TEXT,
    "venuePricingStructureId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MonthlyVenueProfit" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "totalTransactions" INTEGER NOT NULL,
    "totalVolume" DECIMAL(15,2) NOT NULL,
    "debitTransactions" INTEGER NOT NULL DEFAULT 0,
    "debitVolume" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "creditTransactions" INTEGER NOT NULL DEFAULT 0,
    "creditVolume" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "amexTransactions" INTEGER NOT NULL DEFAULT 0,
    "amexVolume" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "internationalTransactions" INTEGER NOT NULL DEFAULT 0,
    "internationalVolume" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "totalProviderCosts" DECIMAL(12,4) NOT NULL,
    "totalVenueCharges" DECIMAL(12,4) NOT NULL,
    "totalGrossProfit" DECIMAL(12,4) NOT NULL,
    "averageProfitMargin" DECIMAL(5,4) NOT NULL,
    "monthlyProviderFees" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "monthlyServiceFees" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" "public"."ProfitStatus" NOT NULL DEFAULT 'CALCULATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyVenueProfit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderCostStructure_providerId_idx" ON "public"."ProviderCostStructure"("providerId");

-- CreateIndex
CREATE INDEX "ProviderCostStructure_merchantAccountId_idx" ON "public"."ProviderCostStructure"("merchantAccountId");

-- CreateIndex
CREATE INDEX "ProviderCostStructure_effectiveFrom_idx" ON "public"."ProviderCostStructure"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCostStructure_merchantAccountId_effectiveFrom_key" ON "public"."ProviderCostStructure"("merchantAccountId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "VenuePricingStructure_venueId_idx" ON "public"."VenuePricingStructure"("venueId");

-- CreateIndex
CREATE INDEX "VenuePricingStructure_accountType_idx" ON "public"."VenuePricingStructure"("accountType");

-- CreateIndex
CREATE INDEX "VenuePricingStructure_effectiveFrom_idx" ON "public"."VenuePricingStructure"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "VenuePricingStructure_venueId_accountType_effectiveFrom_key" ON "public"."VenuePricingStructure"("venueId", "accountType", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionCost_paymentId_key" ON "public"."TransactionCost"("paymentId");

-- CreateIndex
CREATE INDEX "TransactionCost_paymentId_idx" ON "public"."TransactionCost"("paymentId");

-- CreateIndex
CREATE INDEX "TransactionCost_merchantAccountId_idx" ON "public"."TransactionCost"("merchantAccountId");

-- CreateIndex
CREATE INDEX "TransactionCost_transactionType_idx" ON "public"."TransactionCost"("transactionType");

-- CreateIndex
CREATE INDEX "TransactionCost_createdAt_idx" ON "public"."TransactionCost"("createdAt");

-- CreateIndex
CREATE INDEX "MonthlyVenueProfit_venueId_idx" ON "public"."MonthlyVenueProfit"("venueId");

-- CreateIndex
CREATE INDEX "MonthlyVenueProfit_year_month_idx" ON "public"."MonthlyVenueProfit"("year", "month");

-- CreateIndex
CREATE INDEX "MonthlyVenueProfit_status_idx" ON "public"."MonthlyVenueProfit"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyVenueProfit_venueId_year_month_key" ON "public"."MonthlyVenueProfit"("venueId", "year", "month");

-- AddForeignKey
ALTER TABLE "public"."ProviderCostStructure" ADD CONSTRAINT "ProviderCostStructure_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "public"."PaymentProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProviderCostStructure" ADD CONSTRAINT "ProviderCostStructure_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VenuePricingStructure" ADD CONSTRAINT "VenuePricingStructure_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TransactionCost" ADD CONSTRAINT "TransactionCost_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TransactionCost" ADD CONSTRAINT "TransactionCost_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TransactionCost" ADD CONSTRAINT "TransactionCost_providerCostStructureId_fkey" FOREIGN KEY ("providerCostStructureId") REFERENCES "public"."ProviderCostStructure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TransactionCost" ADD CONSTRAINT "TransactionCost_venuePricingStructureId_fkey" FOREIGN KEY ("venuePricingStructureId") REFERENCES "public"."VenuePricingStructure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MonthlyVenueProfit" ADD CONSTRAINT "MonthlyVenueProfit_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
