-- CreateEnum
CREATE TYPE "PaymentFundsFlow" AS ENUM ('AVOQADO_PROCESSED', 'CASH_DRAWER', 'EXTERNAL_RECORDED');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "fundsFlow" "PaymentFundsFlow";

