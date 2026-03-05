-- AlterTable
ALTER TABLE "public"."CommissionConfig" ADD COLUMN     "categoryIds" TEXT[],
ADD COLUMN     "filterByCategories" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "goalBonusRate" DECIMAL(5,4),
ADD COLUMN     "useGoalAsTier" BOOLEAN NOT NULL DEFAULT false;
