-- AlterTable
ALTER TABLE "public"."Order" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
