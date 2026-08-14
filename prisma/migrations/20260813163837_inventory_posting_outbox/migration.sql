-- CreateEnum
CREATE TYPE "InventoryPostingSourceKind" AS ENUM ('ORDER', 'CHECKOUT_SESSION', 'DELIVERY_ORDER', 'REFUND_PAYMENT');

-- CreateEnum
CREATE TYPE "InventoryPostingEffectKind" AS ENUM ('SALE', 'CUSTOMER_RETURN', 'CANCELLATION');

-- CreateEnum
CREATE TYPE "InventoryPostingStatus" AS ENUM ('PENDING', 'APPLYING', 'APPLIED', 'PARTIAL_FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "InventoryPostingLineStatus" AS ENUM ('PENDING', 'APPLIED', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "InventoryMovement" ADD COLUMN     "postingLineId" TEXT;

-- CreateTable
CREATE TABLE "InventoryPosting" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "sourceKind" "InventoryPostingSourceKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "effectKind" "InventoryPostingEffectKind" NOT NULL,
    "orderId" TEXT,
    "status" "InventoryPostingStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "payloadSnapshot" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryPostingLine" (
    "id" TEXT NOT NULL,
    "postingId" TEXT NOT NULL,
    "effectKey" TEXT NOT NULL,
    "orderItemId" TEXT,
    "productId" TEXT,
    "status" "InventoryPostingLineStatus" NOT NULL DEFAULT 'PENDING',
    "expectedQuantityBase" DECIMAL(12,3) NOT NULL,
    "appliedQuantityBase" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryPostingLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryPosting_venueId_status_idx" ON "InventoryPosting"("venueId", "status");

-- CreateIndex
CREATE INDEX "InventoryPosting_status_createdAt_idx" ON "InventoryPosting"("status", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryPosting_orderId_idx" ON "InventoryPosting"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPosting_venueId_sourceKind_sourceId_effectKind_key" ON "InventoryPosting"("venueId", "sourceKind", "sourceId", "effectKind");

-- CreateIndex
CREATE INDEX "InventoryPostingLine_productId_idx" ON "InventoryPostingLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPostingLine_postingId_effectKey_key" ON "InventoryPostingLine"("postingId", "effectKey");

-- CreateIndex
CREATE INDEX "InventoryMovement_postingLineId_idx" ON "InventoryMovement"("postingLineId");

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_postingLineId_fkey" FOREIGN KEY ("postingLineId") REFERENCES "InventoryPostingLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPostingLine" ADD CONSTRAINT "InventoryPostingLine_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "InventoryPosting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
