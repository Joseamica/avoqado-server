-- AlterEnum
ALTER TYPE "StockCountStatus" ADD VALUE 'APPLYING';

-- AlterTable
ALTER TABLE "StockCount" ADD COLUMN     "applyingAt" TIMESTAMP(3);
