-- «Por cobrar» (spec 2026-11-02-por-cobrar-superadmin §4): recordatorios manuales de cobro con factura, en SUPERADMIN.
-- Migración ADITIVA y sin datos: tres enums, tres tablas, y una columna opcional nueva en "PlatformCfdi" (nadie más se entera).
-- Escrita a mano a partir de `prisma migrate diff`; sólo lleva lo de este cambio (los índices con los nombres que genera Prisma).
-- El diff contra el schema también trae diferencias viejas de otras tablas (Customer_tags_gin_idx, defaults de PaymentEffect,
-- BirthdayAutomation y VenueFeature, y el nombre truncado de un índice de DocumentRequestDelivery): NO son de este trabajo y
-- no se arreglan aquí.

-- CreateEnum
CREATE TYPE "PlatformChargeFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "PlatformChargeInvoiceMode" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "PlatformChargeOccurrenceStatus" AS ENUM ('PENDING', 'PAID', 'SKIPPED');

-- AlterTable
ALTER TABLE "PlatformCfdi" ADD COLUMN     "platformChargeOccurrenceId" TEXT;

-- CreateTable
CREATE TABLE "PlatformCharge" (
    "id" TEXT NOT NULL,
    "customerType" "BillingCustomerType" NOT NULL,
    "organizationId" TEXT,
    "venueId" TEXT,
    "customerName" TEXT NOT NULL,
    "billingTaxProfileId" TEXT,
    "frequency" "PlatformChargeFrequency" NOT NULL,
    "anchorDate" DATE NOT NULL,
    "concepts" JSONB NOT NULL,
    "invoiceMode" "PlatformChargeInvoiceMode" NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformChargeOccurrence" (
    "id" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "concepts" JSONB NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "invoiceMode" "PlatformChargeInvoiceMode" NOT NULL,
    "status" "PlatformChargeOccurrenceStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "skippedAt" TIMESTAMP(3),
    "skippedById" TEXT,
    "invoiceSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformChargeOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformChargeDigest" (
    "day" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformChargeDigest_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE INDEX "PlatformCharge_pausedAt_id_idx" ON "PlatformCharge"("pausedAt", "id");

-- CreateIndex
CREATE INDEX "PlatformChargeOccurrence_status_dueDate_id_idx" ON "PlatformChargeOccurrence"("status", "dueDate", "id");

-- CreateIndex
CREATE INDEX "PlatformChargeOccurrence_status_paidAt_id_idx" ON "PlatformChargeOccurrence"("status", "paidAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformChargeOccurrence_chargeId_dueDate_key" ON "PlatformChargeOccurrence"("chargeId", "dueDate");

-- CreateIndex
CREATE INDEX "PlatformCfdi_platformChargeOccurrenceId_idx" ON "PlatformCfdi"("platformChargeOccurrenceId");

-- AddForeignKey
ALTER TABLE "PlatformCfdi" ADD CONSTRAINT "PlatformCfdi_platformChargeOccurrenceId_fkey" FOREIGN KEY ("platformChargeOccurrenceId") REFERENCES "PlatformChargeOccurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformChargeOccurrence" ADD CONSTRAINT "PlatformChargeOccurrence_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "PlatformCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
