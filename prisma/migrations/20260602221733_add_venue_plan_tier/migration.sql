-- CreateEnum
CREATE TYPE "public"."PlanTier" AS ENUM ('GRATIS', 'PRO', 'PREMIUM', 'ENTERPRISE');

-- AlterTable
ALTER TABLE "public"."Venue" ADD COLUMN     "planTier" "public"."PlanTier";
