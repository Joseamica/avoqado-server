/*
  Warnings:

  - A unique constraint covering the columns `[orderId,externalId]` on the table `OrderItem` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `OrderItem` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "sequence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "syncStatus" "SyncStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "OrderItem_externalId_idx" ON "OrderItem"("externalId");

-- CreateIndex
CREATE INDEX "OrderItem_syncStatus_idx" ON "OrderItem"("syncStatus");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_orderId_externalId_key" ON "OrderItem"("orderId", "externalId");

-- CreateIndex
CREATE INDEX "Product_syncStatus_idx" ON "Product"("syncStatus");
