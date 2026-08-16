-- CreateEnum
CREATE TYPE "TenderSection" AS ENUM ('PRIMARY', 'MORE');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "tenderCaptureTip" BOOLEAN,
ADD COLUMN     "tenderCommissionAmount" DECIMAL(10,2),
ADD COLUMN     "tenderCommissionPercent" DECIMAL(5,2),
ADD COLUMN     "tenderCountsAsCash" BOOLEAN,
ADD COLUMN     "tenderLabel" VARCHAR(80),
ADD COLUMN     "tenderRevision" INTEGER,
ADD COLUMN     "tenderSatFormaPago" VARCHAR(2),
ADD COLUMN     "tenderTypeId" TEXT;

-- CreateTable
CREATE TABLE "VenueTenderType" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "normalizedName" VARCHAR(80) NOT NULL,
    "baseMethod" "PaymentMethod" NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "countsAsPhysicalCash" BOOLEAN NOT NULL DEFAULT false,
    "captureTip" BOOLEAN NOT NULL DEFAULT true,
    "showOnPos" BOOLEAN NOT NULL DEFAULT true,
    "posSection" "TenderSection" NOT NULL DEFAULT 'MORE',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "commissionPercent" DECIMAL(5,2),
    "satFormaPago" VARCHAR(2),
    "linkedOrderSource" "OrderSource",
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueTenderType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueTenderTypeRevision" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "tenderTypeId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "countsAsPhysicalCash" BOOLEAN NOT NULL,
    "captureTip" BOOLEAN NOT NULL,
    "commissionPercent" DECIMAL(5,2),
    "satFormaPago" VARCHAR(2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "VenueTenderTypeRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VenueTenderType_venueId_active_idx" ON "VenueTenderType"("venueId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "VenueTenderType_venueId_normalizedName_key" ON "VenueTenderType"("venueId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "VenueTenderType_venueId_id_key" ON "VenueTenderType"("venueId", "id");

-- CreateIndex
CREATE INDEX "VenueTenderTypeRevision_venueId_tenderTypeId_idx" ON "VenueTenderTypeRevision"("venueId", "tenderTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueTenderTypeRevision_tenderTypeId_revision_key" ON "VenueTenderTypeRevision"("tenderTypeId", "revision");

-- CreateIndex
CREATE INDEX "Payment_venueId_tenderTypeId_idx" ON "Payment"("venueId", "tenderTypeId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_venueId_tenderTypeId_fkey" FOREIGN KEY ("venueId", "tenderTypeId") REFERENCES "VenueTenderType"("venueId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueTenderType" ADD CONSTRAINT "VenueTenderType_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueTenderTypeRevision" ADD CONSTRAINT "VenueTenderTypeRevision_venueId_tenderTypeId_fkey" FOREIGN KEY ("venueId", "tenderTypeId") REFERENCES "VenueTenderType"("venueId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

