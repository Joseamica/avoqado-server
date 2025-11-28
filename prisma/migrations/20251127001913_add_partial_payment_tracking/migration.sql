-- AlterTable
ALTER TABLE "public"."Order" ADD COLUMN     "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "remainingBalance" DECIMAL(12,2) NOT NULL DEFAULT 0;
