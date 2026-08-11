-- CreateEnum
CREATE TYPE "AreaSettlementRoute" AS ENUM ('AVOQADO', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "ExternalConfirmationMode" AS ENUM ('MANUAL', 'ASSUME_ON_PRINT');

-- CreateEnum
CREATE TYPE "ExternalOfflinePolicy" AS ENUM ('ALLOW', 'BLOCK');

-- CreateEnum
CREATE TYPE "ExternalDeliveryTracking" AS ENUM ('TRACKED', 'UNTRACKED');

-- CreateEnum
CREATE TYPE "AreaTicketExternalSettlementStatus" AS ENUM ('PENDING', 'ASSUMED', 'CONFIRMED', 'DISCREPANCY', 'NOT_CHARGED');

-- CreateEnum
CREATE TYPE "AreaTicketExternalHandoffState" AS ENUM ('PENDING', 'HANDED_OFF', 'RETURNED');

-- CreateEnum
CREATE TYPE "AreaTicketExternalIncidentKind" AS ENUM ('UNCONFIRMED_CHARGE', 'AMOUNT_VARIANCE', 'NEGATIVE_STOCK', 'CODE_MISMATCH', 'REPRINT_RISK');

-- CreateEnum
CREATE TYPE "AreaTicketExternalIncidentStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- AlterTable
ALTER TABLE "AreaTicket" ADD COLUMN     "settlementRoute" "AreaSettlementRoute" NOT NULL DEFAULT 'AVOQADO';

-- AlterTable
ALTER TABLE "AreaTicketInventoryReservation" ADD COLUMN     "reversalMovementId" TEXT;

-- AlterTable
ALTER TABLE "FulfillmentArea" ADD COLUMN     "externalConfirmationMode" "ExternalConfirmationMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "externalDeliveryTracking" "ExternalDeliveryTracking" NOT NULL DEFAULT 'TRACKED',
ADD COLUMN     "externalOfflinePolicy" "ExternalOfflinePolicy" NOT NULL DEFAULT 'BLOCK',
ADD COLUMN     "settlementRoute" "AreaSettlementRoute" NOT NULL DEFAULT 'AVOQADO';

-- CreateTable
CREATE TABLE "AreaTicketExternalSettlement" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "areaTicketId" TEXT NOT NULL,
    "status" "AreaTicketExternalSettlementStatus" NOT NULL DEFAULT 'PENDING',
    "handoffState" "AreaTicketExternalHandoffState" NOT NULL DEFAULT 'PENDING',
    "confirmationMode" "ExternalConfirmationMode" NOT NULL,
    "referenceAmount" DECIMAL(12,2) NOT NULL,
    "externalAmount" DECIMAL(12,2),
    "externalReference" TEXT,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "confirmedByStaffId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "terminalId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AreaTicketExternalSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaTicketExternalIncident" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "areaTicketId" TEXT,
    "kind" "AreaTicketExternalIncidentKind" NOT NULL,
    "status" "AreaTicketExternalIncidentStatus" NOT NULL DEFAULT 'OPEN',
    "detail" JSONB NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByStaffId" TEXT,
    "resolution" TEXT,

    CONSTRAINT "AreaTicketExternalIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketExternalSettlement_areaTicketId_key" ON "AreaTicketExternalSettlement"("areaTicketId");

-- CreateIndex
CREATE INDEX "AreaTicketExternalSettlement_venueId_status_createdAt_idx" ON "AreaTicketExternalSettlement"("venueId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketExternalSettlement_areaTicketId_idempotencyKey_key" ON "AreaTicketExternalSettlement"("areaTicketId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AreaTicketExternalIncident_venueId_status_kind_openedAt_idx" ON "AreaTicketExternalIncident"("venueId", "status", "kind", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketExternalIncident_areaTicketId_kind_key" ON "AreaTicketExternalIncident"("areaTicketId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketInventoryReservation_reversalMovementId_key" ON "AreaTicketInventoryReservation"("reversalMovementId");

-- AddForeignKey
ALTER TABLE "AreaTicketExternalSettlement" ADD CONSTRAINT "AreaTicketExternalSettlement_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketExternalSettlement" ADD CONSTRAINT "AreaTicketExternalSettlement_areaTicketId_fkey" FOREIGN KEY ("areaTicketId") REFERENCES "AreaTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketExternalSettlement" ADD CONSTRAINT "AreaTicketExternalSettlement_confirmedByStaffId_fkey" FOREIGN KEY ("confirmedByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketExternalSettlement" ADD CONSTRAINT "AreaTicketExternalSettlement_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketExternalIncident" ADD CONSTRAINT "AreaTicketExternalIncident_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketExternalIncident" ADD CONSTRAINT "AreaTicketExternalIncident_areaTicketId_fkey" FOREIGN KEY ("areaTicketId") REFERENCES "AreaTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketExternalIncident" ADD CONSTRAINT "AreaTicketExternalIncident_resolvedByStaffId_fkey" FOREIGN KEY ("resolvedByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

