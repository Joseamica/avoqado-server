-- CreateEnum
CREATE TYPE "public"."CostingMethod" AS ENUM ('FIFO', 'WEIGHTED_AVERAGE', 'STANDARD_COST');

-- AlterTable
ALTER TABLE "public"."VenueSettings" ADD COLUMN     "costingMethod" "public"."CostingMethod" NOT NULL DEFAULT 'FIFO';
