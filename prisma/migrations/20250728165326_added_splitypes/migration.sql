/*
  Warnings:

  - Added the required column `splitType` to the `Payment` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "SplitType" AS ENUM ('PERPRODUCT', 'EQUALPARTS', 'CUSTOMAMOUNT', 'FULLPAYMENT');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "splitType" "SplitType";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "splitType" "SplitType" NOT NULL;
