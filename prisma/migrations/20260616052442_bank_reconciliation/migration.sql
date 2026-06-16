-- CreateEnum
CREATE TYPE "public"."BankStatementSource" AS ENUM ('CSV', 'PDF');

-- CreateEnum
CREATE TYPE "public"."BankStatementStatus" AS ENUM ('PARSED', 'RECONCILED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."BankLineDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "public"."ReconMatchStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'DUPLICATE', 'CONFIRMED');

-- CreateTable
CREATE TABLE "public"."BankStatement" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "source" "public"."BankStatementSource" NOT NULL DEFAULT 'CSV',
    "status" "public"."BankStatementStatus" NOT NULL DEFAULT 'PARSED',
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BankStatementLine" (
    "id" TEXT NOT NULL,
    "bankStatementId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "postedDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amountCents" INTEGER NOT NULL,
    "direction" "public"."BankLineDirection" NOT NULL DEFAULT 'CREDIT',
    "matchStatus" "public"."ReconMatchStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchScore" DECIMAL(4,3),
    "matchedKey" TEXT,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankStatement_venueId_idx" ON "public"."BankStatement"("venueId");

-- CreateIndex
CREATE INDEX "BankStatement_venueId_createdAt_idx" ON "public"."BankStatement"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "BankStatementLine_venueId_idx" ON "public"."BankStatementLine"("venueId");

-- CreateIndex
CREATE INDEX "BankStatementLine_bankStatementId_idx" ON "public"."BankStatementLine"("bankStatementId");

-- CreateIndex
CREATE INDEX "BankStatementLine_venueId_matchStatus_idx" ON "public"."BankStatementLine"("venueId", "matchStatus");

-- AddForeignKey
ALTER TABLE "public"."BankStatement" ADD CONSTRAINT "BankStatement_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankStatementLine" ADD CONSTRAINT "BankStatementLine_bankStatementId_fkey" FOREIGN KEY ("bankStatementId") REFERENCES "public"."BankStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
