-- AlterTable
ALTER TABLE "PaymentLink" ADD COLUMN     "discount" JSONB,
ADD COLUMN     "discountId" TEXT;

-- CreateIndex
CREATE INDEX "PaymentLink_discountId_status_idx" ON "PaymentLink"("discountId", "status");

-- AddForeignKey
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "Discount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
