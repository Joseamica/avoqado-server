-- AlterTable
ALTER TABLE "RawMaterialMovement" ADD COLUMN     "postingLineId" TEXT;

-- CreateIndex
CREATE INDEX "RawMaterialMovement_postingLineId_idx" ON "RawMaterialMovement"("postingLineId");

-- AddForeignKey
ALTER TABLE "RawMaterialMovement" ADD CONSTRAINT "RawMaterialMovement_postingLineId_fkey" FOREIGN KEY ("postingLineId") REFERENCES "InventoryPostingLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
