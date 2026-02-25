-- AlterTable
ALTER TABLE "public"."Product" ADD COLUMN     "layoutConfig" JSONB;

-- AlterTable
ALTER TABLE "public"."Reservation" ADD COLUMN     "spotIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
