-- AlterTable
ALTER TABLE "public"."Shift" ADD COLUMN     "inventoryConsumed" JSONB,
ADD COLUMN     "reportData" JSONB,
ADD COLUMN     "totalCardPayments" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalCashPayments" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalOtherPayments" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalProductsSold" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalVoucherPayments" DECIMAL(12,2) NOT NULL DEFAULT 0;
