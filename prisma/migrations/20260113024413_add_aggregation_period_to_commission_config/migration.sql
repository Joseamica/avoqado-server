-- AlterTable
ALTER TABLE "CommissionConfig" ADD COLUMN     "aggregationPeriod" "TierPeriod" NOT NULL DEFAULT 'MONTHLY';
