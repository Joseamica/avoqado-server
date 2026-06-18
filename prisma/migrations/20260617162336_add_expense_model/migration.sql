-- CreateEnum
CREATE TYPE "public"."DiotTipoTercero" AS ENUM ('NACIONAL', 'EXTRANJERO', 'GLOBAL');

-- CreateEnum
CREATE TYPE "public"."ReceivedComprobanteTipo" AS ENUM ('INGRESO', 'EGRESO', 'NOMINA', 'PAGO', 'TRASLADO');

-- CreateEnum
CREATE TYPE "public"."ExpenseMetodoPago" AS ENUM ('PUE', 'PPD');

-- CreateEnum
CREATE TYPE "public"."ExpensePaymentStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID');

-- CreateEnum
CREATE TYPE "public"."ExpenseSource" AS ENUM ('MANUAL', 'XML_UPLOAD', 'SAT_DESCARGA');

-- CreateEnum
CREATE TYPE "public"."ExpenseStatus" AS ENUM ('REGISTERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."ExpenseCategoria" AS ENUM ('COSTO_MERCANCIA', 'GASTO_GENERAL', 'ARRENDAMIENTO', 'COMBUSTIBLE', 'HONORARIOS', 'SERVICIOS', 'OTRO');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."AccountMovementType" ADD VALUE 'IVA_INPUT';
ALTER TYPE "public"."AccountMovementType" ADD VALUE 'IVA_INPUT_PENDING';
ALTER TYPE "public"."AccountMovementType" ADD VALUE 'IVA_WITHHELD';
ALTER TYPE "public"."AccountMovementType" ADD VALUE 'ISR_WITHHELD';
ALTER TYPE "public"."AccountMovementType" ADD VALUE 'EXPENSE_GENERAL';

-- AlterEnum
ALTER TYPE "public"."JournalEntrySource" ADD VALUE 'EXPENSE';

-- CreateTable
CREATE TABLE "public"."Expense" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rfc" TEXT NOT NULL,
    "venueId" TEXT,
    "proveedorRfc" TEXT NOT NULL,
    "proveedorNombre" TEXT NOT NULL,
    "proveedorRegimen" TEXT,
    "tipoTercero" "public"."DiotTipoTercero" NOT NULL DEFAULT 'NACIONAL',
    "comprobanteTipo" "public"."ReceivedComprobanteTipo" NOT NULL DEFAULT 'INGRESO',
    "usoCfdi" TEXT,
    "metodoPago" "public"."ExpenseMetodoPago" NOT NULL DEFAULT 'PUE',
    "formaPago" TEXT,
    "fechaEmision" TIMESTAMP(3) NOT NULL,
    "fechaPago" TIMESTAMP(3),
    "subtotalCents" INTEGER NOT NULL,
    "descuentoCents" INTEGER NOT NULL DEFAULT 0,
    "ivaCents" INTEGER NOT NULL DEFAULT 0,
    "iva16Cents" INTEGER NOT NULL DEFAULT 0,
    "iva8Cents" INTEGER NOT NULL DEFAULT 0,
    "iva0BaseCents" INTEGER NOT NULL DEFAULT 0,
    "exentoBaseCents" INTEGER NOT NULL DEFAULT 0,
    "iepsCents" INTEGER NOT NULL DEFAULT 0,
    "isrRetenidoCents" INTEGER NOT NULL DEFAULT 0,
    "ivaRetenidoCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "taxBreakdown" JSONB,
    "deducible" BOOLEAN NOT NULL DEFAULT true,
    "ivaAcreditable" BOOLEAN NOT NULL DEFAULT true,
    "expenseAccountCode" TEXT,
    "ledgerAccountId" TEXT,
    "categoria" "public"."ExpenseCategoria" NOT NULL DEFAULT 'GASTO_GENERAL',
    "journalEntryId" TEXT,
    "posted" BOOLEAN NOT NULL DEFAULT false,
    "paymentStatus" "public"."ExpensePaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "paidPeriod" TEXT,
    "uuid" TEXT,
    "serie" TEXT,
    "folio" TEXT,
    "source" "public"."ExpenseSource" NOT NULL DEFAULT 'MANUAL',
    "xmlUrl" TEXT,
    "pdfUrl" TEXT,
    "supplierId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "status" "public"."ExpenseStatus" NOT NULL DEFAULT 'REGISTERED',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Expense_journalEntryId_key" ON "public"."Expense"("journalEntryId");

-- CreateIndex
CREATE INDEX "Expense_organizationId_rfc_paidPeriod_idx" ON "public"."Expense"("organizationId", "rfc", "paidPeriod");

-- CreateIndex
CREATE INDEX "Expense_organizationId_rfc_proveedorRfc_idx" ON "public"."Expense"("organizationId", "rfc", "proveedorRfc");

-- CreateIndex
CREATE INDEX "Expense_organizationId_rfc_paymentStatus_idx" ON "public"."Expense"("organizationId", "rfc", "paymentStatus");

-- CreateIndex
CREATE INDEX "Expense_venueId_idx" ON "public"."Expense"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_organizationId_rfc_uuid_key" ON "public"."Expense"("organizationId", "rfc", "uuid");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_organizationId_rfc_dedupeKey_key" ON "public"."Expense"("organizationId", "rfc", "dedupeKey");

