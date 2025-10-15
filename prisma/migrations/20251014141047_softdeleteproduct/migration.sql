-- AlterTable
ALTER TABLE "public"."Product" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT;
