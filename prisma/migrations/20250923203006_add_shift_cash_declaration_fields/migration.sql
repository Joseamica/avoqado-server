-- AlterTable
ALTER TABLE "public"."Shift" ADD COLUMN     "cardDeclared" DECIMAL(10,2),
ADD COLUMN     "cashDeclared" DECIMAL(10,2),
ADD COLUMN     "otherDeclared" DECIMAL(10,2),
ADD COLUMN     "vouchersDeclared" DECIMAL(10,2);
