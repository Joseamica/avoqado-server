-- CreateEnum
CREATE TYPE "public"."JournalEntryType" AS ENUM ('INGRESO', 'EGRESO', 'DIARIO');

-- CreateEnum
CREATE TYPE "public"."JournalEntrySource" AS ENUM ('MANUAL', 'PAYMENT', 'REFUND', 'CFDI', 'COGS', 'ADJUSTMENT', 'OPENING');

-- CreateEnum
CREATE TYPE "public"."JournalEntryStatus" AS ENUM ('POSTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."JournalEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rfc" TEXT NOT NULL,
    "venueId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "period" TEXT NOT NULL,
    "folio" INTEGER NOT NULL,
    "type" "public"."JournalEntryType" NOT NULL DEFAULT 'DIARIO',
    "source" "public"."JournalEntrySource" NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "idempotencyKey" TEXT,
    "status" "public"."JournalEntryStatus" NOT NULL DEFAULT 'POSTED',
    "concept" TEXT NOT NULL,
    "totalDebitCents" INTEGER NOT NULL,
    "totalCreditCents" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JournalLine" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "ledgerAccountId" TEXT NOT NULL,
    "debitCents" INTEGER NOT NULL DEFAULT 0,
    "creditCents" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JournalEntry_organizationId_rfc_period_idx" ON "public"."JournalEntry"("organizationId", "rfc", "period");

-- CreateIndex
CREATE INDEX "JournalEntry_organizationId_rfc_date_idx" ON "public"."JournalEntry"("organizationId", "rfc", "date");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_organizationId_rfc_idempotencyKey_key" ON "public"."JournalEntry"("organizationId", "rfc", "idempotencyKey");

-- CreateIndex
CREATE INDEX "JournalLine_journalEntryId_idx" ON "public"."JournalLine"("journalEntryId");

-- CreateIndex
CREATE INDEX "JournalLine_ledgerAccountId_idx" ON "public"."JournalLine"("ledgerAccountId");

-- AddForeignKey
ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalLine" ADD CONSTRAINT "JournalLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "public"."JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalLine" ADD CONSTRAINT "JournalLine_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "public"."LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
