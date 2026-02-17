-- AlterTable
ALTER TABLE "public"."training_modules" ADD COLUMN     "venueIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
