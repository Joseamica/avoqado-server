-- CreateEnum
CREATE TYPE "public"."PlatformCfdiStatus" AS ENUM ('DRAFT', 'STAMPING', 'STAMPED', 'STAMP_FAILED', 'CANCEL_REQUESTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."PlatformCfdiType" AS ENUM ('INGRESO', 'PAGO');

-- CreateEnum
CREATE TYPE "public"."BillingCustomerType" AS ENUM ('ORGANIZATION', 'VENUE', 'STANDALONE');

-- CreateTable
CREATE TABLE "public"."PlatformEmisor" (
    "id" TEXT NOT NULL,
    "rfc" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "regimenFiscal" TEXT NOT NULL,
    "lugarExpedicion" TEXT NOT NULL,
    "provider" "public"."FiscalProviderType" NOT NULL DEFAULT 'FACTURAPI',
    "providerOrgId" TEXT,
    "providerKeyEnc" TEXT,
    "csdStatus" "public"."CsdStatus" NOT NULL DEFAULT 'NONE',
    "csdExpiresAt" TIMESTAMP(3),
    "csdLastCheckedAt" TIMESTAMP(3),
    "serie" TEXT NOT NULL DEFAULT 'A',
    "defaultUsoCfdi" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformEmisor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BillingTaxProfile" (
    "id" TEXT NOT NULL,
    "customerType" "public"."BillingCustomerType" NOT NULL,
    "organizationId" TEXT,
    "venueId" TEXT,
    "displayName" TEXT,
    "rfc" TEXT NOT NULL,
    "razonSocial" TEXT NOT NULL,
    "regimenFiscal" TEXT NOT NULL,
    "codigoPostal" TEXT NOT NULL,
    "defaultUsoCfdi" TEXT NOT NULL DEFAULT 'G03',
    "email" TEXT,
    "constanciaUrl" TEXT,
    "validationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "validatedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingTaxProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlatformCfdi" (
    "id" TEXT NOT NULL,
    "platformEmisorId" TEXT NOT NULL,
    "billingTaxProfileId" TEXT,
    "type" "public"."PlatformCfdiType" NOT NULL DEFAULT 'INGRESO',
    "parentPlatformCfdiId" TEXT,
    "organizationId" TEXT,
    "venueId" TEXT,
    "receptorRfc" TEXT NOT NULL,
    "receptorNombre" TEXT NOT NULL,
    "receptorRegimen" TEXT NOT NULL,
    "receptorCp" TEXT NOT NULL,
    "usoCfdi" TEXT NOT NULL,
    "lines" JSONB,
    "formaPago" TEXT NOT NULL,
    "metodoPago" TEXT NOT NULL DEFAULT 'PUE',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "taxBreakdown" JSONB,
    "amountPaidCents" INTEGER NOT NULL DEFAULT 0,
    "paymentInfo" JSONB,
    "status" "public"."PlatformCfdiStatus" NOT NULL DEFAULT 'DRAFT',
    "facturapiId" TEXT,
    "uuid" TEXT,
    "serie" TEXT,
    "folio" TEXT,
    "stampedAt" TIMESTAMP(3),
    "xmlUrl" TEXT,
    "pdfUrl" TEXT,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "cancelMotivo" TEXT,
    "cancelSubstituteUuid" TEXT,
    "cancelStatus" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "emailSentAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformCfdi_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformEmisor_isActive_idx" ON "public"."PlatformEmisor"("isActive");

-- CreateIndex
CREATE INDEX "BillingTaxProfile_rfc_idx" ON "public"."BillingTaxProfile"("rfc");

-- CreateIndex
CREATE UNIQUE INDEX "BillingTaxProfile_organizationId_key" ON "public"."BillingTaxProfile"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingTaxProfile_venueId_key" ON "public"."BillingTaxProfile"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformCfdi_uuid_key" ON "public"."PlatformCfdi"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformCfdi_idempotencyKey_key" ON "public"."PlatformCfdi"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PlatformCfdi_organizationId_idx" ON "public"."PlatformCfdi"("organizationId");

-- CreateIndex
CREATE INDEX "PlatformCfdi_venueId_idx" ON "public"."PlatformCfdi"("venueId");

-- CreateIndex
CREATE INDEX "PlatformCfdi_status_idx" ON "public"."PlatformCfdi"("status");

-- CreateIndex
CREATE INDEX "PlatformCfdi_type_idx" ON "public"."PlatformCfdi"("type");

-- CreateIndex
CREATE INDEX "PlatformCfdi_parentPlatformCfdiId_idx" ON "public"."PlatformCfdi"("parentPlatformCfdiId");

-- CreateIndex
CREATE INDEX "PlatformCfdi_createdAt_idx" ON "public"."PlatformCfdi"("createdAt");

