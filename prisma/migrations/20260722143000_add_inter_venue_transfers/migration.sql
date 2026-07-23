-- Extend the existing movement ledger additively. The legacy TRANSFER value is preserved.
ALTER TYPE "RawMaterialMovementType" ADD VALUE 'TRANSFER_OUT';
ALTER TYPE "RawMaterialMovementType" ADD VALUE 'TRANSFER_IN';

CREATE TYPE "VenueOperationalRole" AS ENUM ('STORE', 'CEDIS', 'HYBRID');
CREATE TYPE "InterVenueTransferMode" AS ENUM ('PULL', 'PUSH');
CREATE TYPE "InterVenueTransferStatus" AS ENUM (
  'REQUESTED',
  'APPROVED',
  'IN_TRANSIT',
  'PARTIALLY_RECEIVED',
  'COMPLETED',
  'COMPLETED_WITH_VARIANCE',
  'REJECTED',
  'CANCELLED'
);
CREATE TYPE "InterVenueTransferVarianceReason" AS ENUM (
  'NOT_DISPATCHED',
  'DAMAGED',
  'LOST_IN_TRANSIT',
  'QUANTITY_ERROR',
  'OTHER'
);

ALTER TABLE "Venue"
  ADD COLUMN "operationalRole" "VenueOperationalRole" NOT NULL DEFAULT 'STORE',
  ADD COLUMN "salesEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "InterVenueTransfer" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "externalReference" TEXT,
  "mode" "InterVenueTransferMode" NOT NULL,
  "status" "InterVenueTransferStatus" NOT NULL DEFAULT 'REQUESTED',
  "sourceVenueId" TEXT NOT NULL,
  "destinationVenueId" TEXT NOT NULL,
  "notes" TEXT,
  "requestedByStaffId" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedByStaffId" TEXT,
  "approvedAt" TIMESTAMP(3),
  "rejectedByStaffId" TEXT,
  "rejectedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "cancelledByStaffId" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "cancellationReason" TEXT,
  "dispatchedByStaffId" TEXT,
  "dispatchedAt" TIMESTAMP(3),
  "dispatchIdempotencyKey" TEXT,
  "dispatchRequestHash" TEXT,
  "completedAt" TIMESTAMP(3),
  "fiscalUuid" TEXT,
  "fiscalReference" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InterVenueTransfer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InterVenueTransferItem" (
  "id" TEXT NOT NULL,
  "transferId" TEXT NOT NULL,
  "sourceRawMaterialId" TEXT NOT NULL,
  "destinationRawMaterialId" TEXT NOT NULL,
  "unit" "Unit" NOT NULL,
  "quantityRequested" DECIMAL(12,3) NOT NULL,
  "quantityDispatched" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "quantityReceived" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "quantityVarianceResolved" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "dispatchShortfallReason" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InterVenueTransferItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InterVenueTransferAllocation" (
  "id" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "sourceBatchId" TEXT NOT NULL,
  "destinationBatchId" TEXT,
  "quantityDispatched" DECIMAL(12,3) NOT NULL,
  "quantityReceived" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "costPerUnit" DECIMAL(10,4) NOT NULL,
  "sourceReceivedDate" TIMESTAMP(3) NOT NULL,
  "expirationDate" TIMESTAMP(3),
  "allocationOrder" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InterVenueTransferAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InterVenueTransferReceipt" (
  "id" TEXT NOT NULL,
  "transferId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "receivedByStaffId" TEXT NOT NULL,
  "notes" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InterVenueTransferReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InterVenueTransferReceiptLine" (
  "id" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "allocationId" TEXT NOT NULL,
  "quantity" DECIMAL(12,3) NOT NULL,

  CONSTRAINT "InterVenueTransferReceiptLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InterVenueTransferVarianceResolution" (
  "id" TEXT NOT NULL,
  "transferId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "resolvedByStaffId" TEXT NOT NULL,
  "notes" TEXT,
  "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InterVenueTransferVarianceResolution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InterVenueTransferVarianceLine" (
  "id" TEXT NOT NULL,
  "resolutionId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "quantity" DECIMAL(12,3) NOT NULL,
  "reason" "InterVenueTransferVarianceReason" NOT NULL,
  "costImpact" DECIMAL(14,4),
  "notes" TEXT,

  CONSTRAINT "InterVenueTransferVarianceLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InterVenueTransfer_organizationId_number_key"
  ON "InterVenueTransfer"("organizationId", "number");
CREATE UNIQUE INDEX "InterVenueTransfer_organizationId_externalReference_key"
  ON "InterVenueTransfer"("organizationId", "externalReference");
CREATE INDEX "InterVenueTransfer_sourceVenueId_status_idx"
  ON "InterVenueTransfer"("sourceVenueId", "status");
CREATE INDEX "InterVenueTransfer_destinationVenueId_status_idx"
  ON "InterVenueTransfer"("destinationVenueId", "status");
CREATE INDEX "InterVenueTransfer_organizationId_createdAt_idx"
  ON "InterVenueTransfer"("organizationId", "createdAt");

CREATE UNIQUE INDEX "InterVenueTransferItem_transferId_source_destination_key"
  ON "InterVenueTransferItem"("transferId", "sourceRawMaterialId", "destinationRawMaterialId");
CREATE INDEX "InterVenueTransferItem_sourceRawMaterialId_idx"
  ON "InterVenueTransferItem"("sourceRawMaterialId");
CREATE INDEX "InterVenueTransferItem_destinationRawMaterialId_idx"
  ON "InterVenueTransferItem"("destinationRawMaterialId");

CREATE UNIQUE INDEX "InterVenueTransferAllocation_itemId_sourceBatchId_key"
  ON "InterVenueTransferAllocation"("itemId", "sourceBatchId");
CREATE INDEX "InterVenueTransferAllocation_sourceBatchId_idx"
  ON "InterVenueTransferAllocation"("sourceBatchId");
CREATE INDEX "InterVenueTransferAllocation_destinationBatchId_idx"
  ON "InterVenueTransferAllocation"("destinationBatchId");

CREATE UNIQUE INDEX "InterVenueTransferReceipt_transferId_idempotencyKey_key"
  ON "InterVenueTransferReceipt"("transferId", "idempotencyKey");
CREATE INDEX "InterVenueTransferReceipt_transferId_receivedAt_idx"
  ON "InterVenueTransferReceipt"("transferId", "receivedAt");
CREATE UNIQUE INDEX "InterVenueTransferReceiptLine_receipt_allocation_key"
  ON "InterVenueTransferReceiptLine"("receiptId", "allocationId");
CREATE INDEX "InterVenueTransferReceiptLine_allocationId_idx"
  ON "InterVenueTransferReceiptLine"("allocationId");

CREATE UNIQUE INDEX "InterVenueTransferVariance_transfer_idempotency_key"
  ON "InterVenueTransferVarianceResolution"("transferId", "idempotencyKey");
CREATE INDEX "InterVenueTransferVariance_transfer_resolvedAt_idx"
  ON "InterVenueTransferVarianceResolution"("transferId", "resolvedAt");
CREATE UNIQUE INDEX "InterVenueTransferVarianceLine_resolution_item_key"
  ON "InterVenueTransferVarianceLine"("resolutionId", "itemId");
CREATE INDEX "InterVenueTransferVarianceLine_itemId_idx"
  ON "InterVenueTransferVarianceLine"("itemId");

ALTER TABLE "InterVenueTransfer"
  ADD CONSTRAINT "InterVenueTransfer_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterVenueTransfer"
  ADD CONSTRAINT "InterVenueTransfer_sourceVenueId_fkey"
  FOREIGN KEY ("sourceVenueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InterVenueTransfer"
  ADD CONSTRAINT "InterVenueTransfer_destinationVenueId_fkey"
  FOREIGN KEY ("destinationVenueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InterVenueTransferItem"
  ADD CONSTRAINT "InterVenueTransferItem_transferId_fkey"
  FOREIGN KEY ("transferId") REFERENCES "InterVenueTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterVenueTransferItem"
  ADD CONSTRAINT "InterVenueTransferItem_sourceRawMaterialId_fkey"
  FOREIGN KEY ("sourceRawMaterialId") REFERENCES "RawMaterial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InterVenueTransferItem"
  ADD CONSTRAINT "InterVenueTransferItem_destinationRawMaterialId_fkey"
  FOREIGN KEY ("destinationRawMaterialId") REFERENCES "RawMaterial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InterVenueTransferAllocation"
  ADD CONSTRAINT "InterVenueTransferAllocation_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "InterVenueTransferItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterVenueTransferAllocation"
  ADD CONSTRAINT "InterVenueTransferAllocation_sourceBatchId_fkey"
  FOREIGN KEY ("sourceBatchId") REFERENCES "StockBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InterVenueTransferAllocation"
  ADD CONSTRAINT "InterVenueTransferAllocation_destinationBatchId_fkey"
  FOREIGN KEY ("destinationBatchId") REFERENCES "StockBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InterVenueTransferReceipt"
  ADD CONSTRAINT "InterVenueTransferReceipt_transferId_fkey"
  FOREIGN KEY ("transferId") REFERENCES "InterVenueTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterVenueTransferReceiptLine"
  ADD CONSTRAINT "InterVenueTransferReceiptLine_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "InterVenueTransferReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterVenueTransferReceiptLine"
  ADD CONSTRAINT "InterVenueTransferReceiptLine_allocationId_fkey"
  FOREIGN KEY ("allocationId") REFERENCES "InterVenueTransferAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InterVenueTransferVarianceResolution"
  ADD CONSTRAINT "InterVenueTransferVarianceResolution_transferId_fkey"
  FOREIGN KEY ("transferId") REFERENCES "InterVenueTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterVenueTransferVarianceLine"
  ADD CONSTRAINT "InterVenueTransferVarianceLine_resolutionId_fkey"
  FOREIGN KEY ("resolutionId") REFERENCES "InterVenueTransferVarianceResolution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterVenueTransferVarianceLine"
  ADD CONSTRAINT "InterVenueTransferVarianceLine_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "InterVenueTransferItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
