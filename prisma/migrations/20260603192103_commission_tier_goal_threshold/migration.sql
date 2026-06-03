-- CreateEnum
CREATE TYPE "public"."ThresholdType" AS ENUM ('FIXED', 'STAFF_GOAL');

-- AlterTable
ALTER TABLE "public"."CommissionTier" ADD COLUMN     "maxThresholdType" "public"."ThresholdType" NOT NULL DEFAULT 'FIXED',
ADD COLUMN     "minThresholdType" "public"."ThresholdType" NOT NULL DEFAULT 'FIXED';
