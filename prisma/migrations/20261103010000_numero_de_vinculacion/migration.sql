-- Número de vinculación (PlayTelecom): campos en SaleVerification, tabla de histórico, y "approve" separado de "review" sin quitarle nada a nadie.
-- CreateEnum
CREATE TYPE "SaleVerificationNumberSource" AS ENUM ('TPV', 'BACKOFFICE', 'EXTERNAL_SALE', 'IMPORT');

-- AlterTable
ALTER TABLE "SaleVerification" ADD COLUMN     "appliedCaptureSeqs" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "linkingNumber" TEXT,
ADD COLUMN     "linkingNumberSetAt" TIMESTAMP(3),
ADD COLUMN     "linkingNumberSource" "SaleVerificationNumberSource",
ADD COLUMN     "portedNumber" TEXT,
ADD COLUMN     "portedNumberSetAt" TIMESTAMP(3),
ADD COLUMN     "portedNumberSource" "SaleVerificationNumberSource";

-- CreateTable
CREATE TABLE "HistoricalLinkingNumber" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "iccid" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "saleDate" TIMESTAMP(3),
    "sourceStatus" TEXT,
    "importBatch" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoricalLinkingNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HistoricalLinkingNumber_organizationId_number_idx" ON "HistoricalLinkingNumber"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalLinkingNumber_organizationId_iccid_number_key" ON "HistoricalLinkingNumber"("organizationId", "iccid", "number");

-- CreateIndex
CREATE INDEX "SaleVerification_linkingNumber_idx" ON "SaleVerification"("linkingNumber");

-- CreateIndex
CREATE INDEX "SaleVerification_portedNumber_idx" ON "SaleVerification"("portedNumber");

-- AddForeignKey
ALTER TABLE "HistoricalLinkingNumber" ADD CONSTRAINT "HistoricalLinkingNumber_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Conservar permisos: quien tenía "review" conserva "approve" (idempotente; sólo agrega).
UPDATE "VenueRolePermission"
SET "permissions" = array_append("permissions", 'sale-verifications:approve')
WHERE 'sale-verifications:review' = ANY("permissions")
  AND NOT ('sale-verifications:approve' = ANY("permissions"));

-- Quien tenía "review" negado, también tiene "approve" negado.
UPDATE "VenueRolePermission"
SET "deniedPermissions" = array_append("deniedPermissions", 'sale-verifications:approve')
WHERE 'sale-verifications:review' = ANY("deniedPermissions")
  AND NOT ('sale-verifications:approve' = ANY("deniedPermissions"));

UPDATE "PermissionSet"
SET "permissions" = array_append("permissions", 'sale-verifications:approve')
WHERE 'sale-verifications:review' = ANY("permissions")
  AND NOT ('sale-verifications:approve' = ANY("permissions"));
