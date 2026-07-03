-- CreateEnum
CREATE TYPE "public"."FinancialConnectionAccountKind" AS ENUM ('MERCHANT', 'CLIENT');

-- AlterTable
ALTER TABLE "public"."FinancialConnection" ADD COLUMN     "accountKind" "public"."FinancialConnectionAccountKind" NOT NULL DEFAULT 'MERCHANT',
ADD COLUMN     "externalClientId" TEXT;
