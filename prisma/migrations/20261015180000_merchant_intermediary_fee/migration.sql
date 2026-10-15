ALTER TABLE "MerchantRevenueShare"
ADD COLUMN "intermediaryFeeRate" DECIMAL(7,6) NOT NULL DEFAULT 0;

ALTER TABLE "MerchantRevenueShare"
ADD CONSTRAINT "MerchantRevenueShare_intermediaryFeeRate_check"
CHECK ("intermediaryFeeRate" >= 0 AND "intermediaryFeeRate" <= 1);
