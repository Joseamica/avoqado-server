-- CreateEnum
CREATE TYPE "SaleVerificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "VenueType" ADD VALUE 'TELECOMUNICACIONES';

-- CreateTable
CREATE TABLE "SaleVerification" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "photos" TEXT[],
    "scannedProducts" JSONB NOT NULL DEFAULT '[]',
    "status" "SaleVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "inventoryDeducted" BOOLEAN NOT NULL DEFAULT false,
    "deviceId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaleVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaleVerification_paymentId_key" ON "SaleVerification"("paymentId");

-- CreateIndex
CREATE INDEX "SaleVerification_venueId_idx" ON "SaleVerification"("venueId");

-- CreateIndex
CREATE INDEX "SaleVerification_paymentId_idx" ON "SaleVerification"("paymentId");

-- CreateIndex
CREATE INDEX "SaleVerification_staffId_idx" ON "SaleVerification"("staffId");

-- CreateIndex
CREATE INDEX "SaleVerification_status_idx" ON "SaleVerification"("status");

-- CreateIndex
CREATE INDEX "SaleVerification_createdAt_idx" ON "SaleVerification"("createdAt");

-- AddForeignKey
ALTER TABLE "SaleVerification" ADD CONSTRAINT "SaleVerification_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleVerification" ADD CONSTRAINT "SaleVerification_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleVerification" ADD CONSTRAINT "SaleVerification_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
