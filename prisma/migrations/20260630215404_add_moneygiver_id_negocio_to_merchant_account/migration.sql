-- Moneygiver/QPay `idNegocio` for this venue's sub-merchant, so a single
-- shared Moneygiver login can know which negocio's balance to pull.
ALTER TABLE "MerchantAccount" ADD COLUMN "moneygiverIdNegocio" TEXT;
