-- Exactly ONE of merchantAccountId / ecommerceMerchantId must be set on a MerchantFiscalConfig.
ALTER TABLE "MerchantFiscalConfig"
  ADD CONSTRAINT "merchant_fiscal_config_exactly_one_merchant"
  CHECK (("merchantAccountId" IS NOT NULL) <> ("ecommerceMerchantId" IS NOT NULL));
