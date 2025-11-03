-- CreateEnum
CREATE TYPE "public"."IncidentStatus" AS ENUM ('PENDING_CONFIRMATION', 'CONFIRMED_DELAY', 'RESOLVED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "public"."ConfidenceLevel" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "public"."HolidayType" AS ENUM ('FEDERAL', 'BANKING', 'GENERAL');

-- CreateEnum
CREATE TYPE "public"."ConfirmationMethod" AS ENUM ('AUTOMATIC', 'MANUAL', 'BANK_INTEGRATION');

-- AlterTable
ALTER TABLE "public"."VenueTransaction" ADD COLUMN     "confirmationMethod" "public"."ConfirmationMethod",
ADD COLUMN     "settlementVarianceDays" INTEGER;

-- CreateTable
CREATE TABLE "public"."SettlementIncident" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT,
    "venueId" TEXT NOT NULL,
    "estimatedSettlementDate" TIMESTAMP(3) NOT NULL,
    "actualSettlementDate" TIMESTAMP(3),
    "delayDays" INTEGER,
    "processorName" TEXT NOT NULL,
    "cardType" "public"."TransactionCardType" NOT NULL,
    "transactionDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "public"."IncidentStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "detectionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolutionDate" TIMESTAMP(3),
    "notes" TEXT,
    "alertedSOFOM" BOOLEAN NOT NULL DEFAULT false,
    "alertedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SettlementConfirmation" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT,
    "transactionId" TEXT,
    "venueId" TEXT NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "confirmationDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settlementArrived" BOOLEAN NOT NULL,
    "actualDate" TIMESTAMP(3),
    "notes" TEXT,
    "evidenceUrl" TEXT,
    "bankReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProcessorReliabilityMetric" (
    "id" TEXT NOT NULL,
    "processorName" TEXT NOT NULL,
    "cardType" "public"."TransactionCardType" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "totalTransactions" INTEGER NOT NULL,
    "totalAmount" DECIMAL(15,2) NOT NULL,
    "onTimeSettlements" INTEGER NOT NULL,
    "delayedSettlements" INTEGER NOT NULL,
    "failedSettlements" INTEGER NOT NULL DEFAULT 0,
    "averageDelayDays" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "maxDelayDays" INTEGER NOT NULL DEFAULT 0,
    "reliabilityScore" DECIMAL(5,2) NOT NULL,
    "confidence" "public"."ConfidenceLevel" NOT NULL DEFAULT 'LOW',
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessorReliabilityMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."HolidayCalendar" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "year" INTEGER NOT NULL,
    "holidayType" "public"."HolidayType" NOT NULL,
    "isBanking" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HolidayCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementIncident_venueId_idx" ON "public"."SettlementIncident"("venueId");

-- CreateIndex
CREATE INDEX "SettlementIncident_status_idx" ON "public"."SettlementIncident"("status");

-- CreateIndex
CREATE INDEX "SettlementIncident_estimatedSettlementDate_idx" ON "public"."SettlementIncident"("estimatedSettlementDate");

-- CreateIndex
CREATE INDEX "SettlementIncident_detectionDate_idx" ON "public"."SettlementIncident"("detectionDate");

-- CreateIndex
CREATE INDEX "SettlementIncident_processorName_idx" ON "public"."SettlementIncident"("processorName");

-- CreateIndex
CREATE INDEX "SettlementConfirmation_venueId_idx" ON "public"."SettlementConfirmation"("venueId");

-- CreateIndex
CREATE INDEX "SettlementConfirmation_incidentId_idx" ON "public"."SettlementConfirmation"("incidentId");

-- CreateIndex
CREATE INDEX "SettlementConfirmation_transactionId_idx" ON "public"."SettlementConfirmation"("transactionId");

-- CreateIndex
CREATE INDEX "SettlementConfirmation_confirmationDate_idx" ON "public"."SettlementConfirmation"("confirmationDate");

-- CreateIndex
CREATE INDEX "ProcessorReliabilityMetric_processorName_idx" ON "public"."ProcessorReliabilityMetric"("processorName");

-- CreateIndex
CREATE INDEX "ProcessorReliabilityMetric_cardType_idx" ON "public"."ProcessorReliabilityMetric"("cardType");

-- CreateIndex
CREATE INDEX "ProcessorReliabilityMetric_periodStart_idx" ON "public"."ProcessorReliabilityMetric"("periodStart");

-- CreateIndex
CREATE INDEX "ProcessorReliabilityMetric_reliabilityScore_idx" ON "public"."ProcessorReliabilityMetric"("reliabilityScore");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessorReliabilityMetric_processorName_cardType_periodSta_key" ON "public"."ProcessorReliabilityMetric"("processorName", "cardType", "periodStart");

-- CreateIndex
CREATE INDEX "HolidayCalendar_date_idx" ON "public"."HolidayCalendar"("date");

-- CreateIndex
CREATE INDEX "HolidayCalendar_year_idx" ON "public"."HolidayCalendar"("year");

-- CreateIndex
CREATE INDEX "HolidayCalendar_holidayType_idx" ON "public"."HolidayCalendar"("holidayType");

-- CreateIndex
CREATE INDEX "HolidayCalendar_isBanking_idx" ON "public"."HolidayCalendar"("isBanking");

-- CreateIndex
CREATE UNIQUE INDEX "HolidayCalendar_date_holidayType_key" ON "public"."HolidayCalendar"("date", "holidayType");

-- AddForeignKey
ALTER TABLE "public"."SettlementIncident" ADD CONSTRAINT "SettlementIncident_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."VenueTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementIncident" ADD CONSTRAINT "SettlementIncident_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementConfirmation" ADD CONSTRAINT "SettlementConfirmation_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "public"."SettlementIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementConfirmation" ADD CONSTRAINT "SettlementConfirmation_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."VenueTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementConfirmation" ADD CONSTRAINT "SettlementConfirmation_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
