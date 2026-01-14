-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "terminalId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "terminalId" TEXT;

-- CreateIndex
CREATE INDEX "Order_terminalId_idx" ON "Order"("terminalId");

-- CreateIndex
CREATE INDEX "Payment_terminalId_idx" ON "Payment"("terminalId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
