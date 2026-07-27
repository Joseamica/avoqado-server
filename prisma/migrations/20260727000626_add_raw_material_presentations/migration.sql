-- CreateTable
CREATE TABLE "RawMaterialPresentation" (
    "id" TEXT NOT NULL,
    "rawMaterialId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "factorToBase" DECIMAL(14,6) NOT NULL,
    "isPurchase" BOOLEAN NOT NULL DEFAULT false,
    "isDefaultOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RawMaterialPresentation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RawMaterialPresentation_rawMaterialId_idx" ON "RawMaterialPresentation"("rawMaterialId");

-- CreateIndex
CREATE INDEX "RawMaterialPresentation_venueId_idx" ON "RawMaterialPresentation"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "RawMaterialPresentation_rawMaterialId_name_key" ON "RawMaterialPresentation"("rawMaterialId", "name");

-- AddForeignKey
ALTER TABLE "RawMaterialPresentation" ADD CONSTRAINT "RawMaterialPresentation_rawMaterialId_fkey" FOREIGN KEY ("rawMaterialId") REFERENCES "RawMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "InterVenueTransferItem_transferId_source_destination_key" RENAME TO "InterVenueTransferItem_transferId_sourceRawMaterialId_desti_key";

-- RenameIndex
ALTER INDEX "InterVenueTransferReceiptLine_receipt_allocation_key" RENAME TO "InterVenueTransferReceiptLine_receiptId_allocationId_key";

-- RenameIndex
ALTER INDEX "InterVenueTransferVarianceLine_resolution_item_key" RENAME TO "InterVenueTransferVarianceLine_resolutionId_itemId_key";

-- RenameIndex
ALTER INDEX "InterVenueTransferVariance_transfer_idempotency_key" RENAME TO "InterVenueTransferVarianceResolution_transferId_idempotency_key";

-- RenameIndex
ALTER INDEX "InterVenueTransferVariance_transfer_resolvedAt_idx" RENAME TO "InterVenueTransferVarianceResolution_transferId_resolvedAt_idx";
