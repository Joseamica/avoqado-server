-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "productId" TEXT,
ALTER COLUMN "rawMaterialId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_productId_idx" ON "PurchaseOrderItem"("productId");

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
