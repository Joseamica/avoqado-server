-- CreateEnum
CREATE TYPE "public"."CsdStatus" AS ENUM ('NONE', 'UPLOADED', 'ACTIVE', 'EXPIRED', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "public"."GlobalPeriodicity" AS ENUM ('DIARIO', 'SEMANAL', 'QUINCENAL', 'MENSUAL', 'BIMESTRAL');

-- CreateEnum
CREATE TYPE "public"."FiscalProviderType" AS ENUM ('FACTURAPI', 'FACTURAMA', 'ALEGRA');

-- CreateEnum
CREATE TYPE "public"."CfdiType" AS ENUM ('INGRESO', 'EGRESO', 'PAGO');

-- CreateEnum
CREATE TYPE "public"."CfdiStatus" AS ENUM ('DRAFT', 'VALIDATING', 'VALIDATION_FAILED', 'STAMPING', 'STAMPED', 'STAMP_FAILED', 'CANCEL_REQUESTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."CfdiFlow" AS ENUM ('STAFF_B', 'AUTOFACTURA_A', 'GLOBAL_C');

-- CreateEnum
CREATE TYPE "public"."CfdiCancelStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."FiscalValidationStatus" AS ENUM ('UNVALIDATED', 'VALID', 'INVALID');

-- AlterTable
ALTER TABLE "public"."MenuCategory" ADD COLUMN     "defaultSatProductKey" TEXT,
ADD COLUMN     "defaultSatUnitKey" TEXT;

-- AlterTable
ALTER TABLE "public"."Product" ADD COLUMN     "objetoImp" TEXT NOT NULL DEFAULT '02',
ADD COLUMN     "satProductKey" TEXT,
ADD COLUMN     "satUnitKey" TEXT;

-- CreateTable
CREATE TABLE "public"."FiscalEmisor" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
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
    "serie" TEXT,
    "defaultUsoCfdi" TEXT NOT NULL DEFAULT 'G03',
    "globalPeriodicity" "public"."GlobalPeriodicity" NOT NULL DEFAULT 'MENSUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalEmisor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MerchantFiscalConfig" (
    "id" TEXT NOT NULL,
    "merchantAccountId" TEXT,
    "ecommerceMerchantId" TEXT,
    "fiscalEmisorId" TEXT NOT NULL,
    "facturacionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autofacturaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "includeInGlobal" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantFiscalConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Cfdi" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "fiscalEmisorId" TEXT NOT NULL,
    "type" "public"."CfdiType" NOT NULL DEFAULT 'INGRESO',
    "status" "public"."CfdiStatus" NOT NULL DEFAULT 'DRAFT',
    "flow" "public"."CfdiFlow" NOT NULL,
    "orderId" TEXT,
    "isGlobal" BOOLEAN NOT NULL DEFAULT false,
    "globalPeriod" JSONB,
    "receptorRfc" TEXT NOT NULL,
    "receptorNombre" TEXT NOT NULL,
    "receptorRegimen" TEXT NOT NULL,
    "receptorCp" TEXT NOT NULL,
    "usoCfdi" TEXT NOT NULL,
    "formaPago" TEXT NOT NULL,
    "metodoPago" TEXT NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "taxBreakdown" JSONB,
    "facturapiId" TEXT,
    "uuid" TEXT,
    "serie" TEXT,
    "folio" TEXT,
    "stampedAt" TIMESTAMP(3),
    "xmlUrl" TEXT,
    "pdfUrl" TEXT,
    "acuseUrl" TEXT,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "cancelMotivo" TEXT,
    "cancelSubstituteUuid" TEXT,
    "cancelStatus" "public"."CfdiCancelStatus",
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cfdi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CustomerTaxProfile" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "customerId" TEXT,
    "rfc" TEXT NOT NULL,
    "razonSocial" TEXT NOT NULL,
    "regimenFiscal" TEXT NOT NULL,
    "codigoPostal" TEXT NOT NULL,
    "defaultUsoCfdi" TEXT NOT NULL DEFAULT 'G03',
    "email" TEXT,
    "validationStatus" "public"."FiscalValidationStatus" NOT NULL DEFAULT 'UNVALIDATED',
    "validatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerTaxProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FiscalEmisor_venueId_idx" ON "public"."FiscalEmisor"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalEmisor_venueId_rfc_key" ON "public"."FiscalEmisor"("venueId", "rfc");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantFiscalConfig_merchantAccountId_key" ON "public"."MerchantFiscalConfig"("merchantAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantFiscalConfig_ecommerceMerchantId_key" ON "public"."MerchantFiscalConfig"("ecommerceMerchantId");

-- CreateIndex
CREATE INDEX "MerchantFiscalConfig_fiscalEmisorId_idx" ON "public"."MerchantFiscalConfig"("fiscalEmisorId");

-- CreateIndex
CREATE UNIQUE INDEX "Cfdi_uuid_key" ON "public"."Cfdi"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "Cfdi_idempotencyKey_key" ON "public"."Cfdi"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Cfdi_venueId_status_idx" ON "public"."Cfdi"("venueId", "status");

-- CreateIndex
CREATE INDEX "Cfdi_fiscalEmisorId_isGlobal_createdAt_idx" ON "public"."Cfdi"("fiscalEmisorId", "isGlobal", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerTaxProfile_venueId_rfc_idx" ON "public"."CustomerTaxProfile"("venueId", "rfc");

-- AddForeignKey
ALTER TABLE "public"."FiscalEmisor" ADD CONSTRAINT "FiscalEmisor_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MerchantFiscalConfig" ADD CONSTRAINT "MerchantFiscalConfig_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MerchantFiscalConfig" ADD CONSTRAINT "MerchantFiscalConfig_ecommerceMerchantId_fkey" FOREIGN KEY ("ecommerceMerchantId") REFERENCES "public"."EcommerceMerchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MerchantFiscalConfig" ADD CONSTRAINT "MerchantFiscalConfig_fiscalEmisorId_fkey" FOREIGN KEY ("fiscalEmisorId") REFERENCES "public"."FiscalEmisor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Cfdi" ADD CONSTRAINT "Cfdi_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Cfdi" ADD CONSTRAINT "Cfdi_fiscalEmisorId_fkey" FOREIGN KEY ("fiscalEmisorId") REFERENCES "public"."FiscalEmisor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Cfdi" ADD CONSTRAINT "Cfdi_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerTaxProfile" ADD CONSTRAINT "CustomerTaxProfile_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
