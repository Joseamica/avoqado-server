-- AlterTable
-- Add merchantAccountId column to Payment table (nullable for backward compatibility)
ALTER TABLE "Payment" ADD COLUMN "merchantAccountId" TEXT;

-- AddForeignKey
-- Create foreign key constraint from Payment to MerchantAccount
-- onDelete: RESTRICT prevents deleting merchant accounts with existing payments
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
-- Add index on merchantAccountId for efficient queries
CREATE INDEX "Payment_merchantAccountId_idx" ON "Payment"("merchantAccountId");
