-- CreateEnum
CREATE TYPE "public"."SettlementDayType" AS ENUM ('BUSINESS_DAYS', 'CALENDAR_DAYS');

-- CreateEnum
CREATE TYPE "public"."SimulationType" AS ENUM ('MANUAL_TRANSACTION', 'HISTORICAL_PROJECTION');

-- AlterTable
ALTER TABLE "public"."VenueTransaction" ADD COLUMN     "actualSettlementDate" TIMESTAMP(3),
ADD COLUMN     "estimatedSettlementDate" TIMESTAMP(3),
ADD COLUMN     "netSettlementAmount" DECIMAL(12,2),
ADD COLUMN     "settlementConfigId" TEXT,
ADD COLUMN     "settlementNotes" TEXT;

-- CreateTable
CREATE TABLE "public"."SettlementConfiguration" (
    "id" TEXT NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "cardType" "public"."TransactionCardType" NOT NULL,
    "settlementDays" INTEGER NOT NULL,
    "settlementDayType" "public"."SettlementDayType" NOT NULL,
    "cutoffTime" TEXT NOT NULL,
    "cutoffTimezone" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SettlementSimulation" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "simulationType" "public"."SimulationType" NOT NULL,
    "simulatedAmount" DECIMAL(12,2) NOT NULL,
    "cardType" "public"."TransactionCardType",
    "simulatedDate" TIMESTAMP(3) NOT NULL,
    "simulatedTime" TEXT,
    "results" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementSimulation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementConfiguration_merchantAccountId_idx" ON "public"."SettlementConfiguration"("merchantAccountId");

-- CreateIndex
CREATE INDEX "SettlementConfiguration_cardType_idx" ON "public"."SettlementConfiguration"("cardType");

-- CreateIndex
CREATE INDEX "SettlementConfiguration_effectiveFrom_idx" ON "public"."SettlementConfiguration"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementConfiguration_merchantAccountId_cardType_effectiv_key" ON "public"."SettlementConfiguration"("merchantAccountId", "cardType", "effectiveFrom");

-- CreateIndex
CREATE INDEX "SettlementSimulation_venueId_idx" ON "public"."SettlementSimulation"("venueId");

-- CreateIndex
CREATE INDEX "SettlementSimulation_userId_idx" ON "public"."SettlementSimulation"("userId");

-- CreateIndex
CREATE INDEX "SettlementSimulation_simulationType_idx" ON "public"."SettlementSimulation"("simulationType");

-- CreateIndex
CREATE INDEX "SettlementSimulation_createdAt_idx" ON "public"."SettlementSimulation"("createdAt");

-- CreateIndex
CREATE INDEX "VenueTransaction_estimatedSettlementDate_idx" ON "public"."VenueTransaction"("estimatedSettlementDate");

-- AddForeignKey
ALTER TABLE "public"."SettlementConfiguration" ADD CONSTRAINT "SettlementConfiguration_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementSimulation" ADD CONSTRAINT "SettlementSimulation_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementSimulation" ADD CONSTRAINT "SettlementSimulation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
