-- AlterTable
ALTER TABLE "WalletPass" ADD COLUMN     "googleObjectId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WalletPass_googleObjectId_key" ON "WalletPass"("googleObjectId");
