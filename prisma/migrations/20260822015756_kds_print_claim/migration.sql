-- AlterTable
ALTER TABLE "KdsOrder" ADD COLUMN     "printClaimedAt" TIMESTAMP(3),
ADD COLUMN     "printClaimedBy" TEXT,
ADD COLUMN     "printedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "KdsOrder_venueId_printedAt_idx" ON "KdsOrder"("venueId", "printedAt");
