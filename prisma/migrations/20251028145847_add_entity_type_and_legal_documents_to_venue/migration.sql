-- CreateEnum
CREATE TYPE "public"."EntityType" AS ENUM ('PERSONA_FISICA', 'PERSONA_MORAL');

-- AlterTable
ALTER TABLE "public"."Venue" ADD COLUMN     "entityType" "public"."EntityType",
ADD COLUMN     "legalDocuments" JSONB;
