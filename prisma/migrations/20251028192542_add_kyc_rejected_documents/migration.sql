-- AlterTable
ALTER TABLE "public"."Venue" ADD COLUMN     "kycRejectedDocuments" TEXT[] DEFAULT ARRAY[]::TEXT[];
