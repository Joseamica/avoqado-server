-- MerchantFiscalConfig.includeInGlobal: default TRUE → FALSE (opt-in).
-- Prevents silently enrolling a venue in the month-end factura global (Flow C / cfdiGlobal.job)
-- the moment it finishes fiscal setup — which would double-invoice venues whose accountant already
-- issues the global for those same Avoqado sales. Existing rows are handled by a separate, explicit
-- data update (per-environment decision), NOT flipped blindly by this migration.
ALTER TABLE "MerchantFiscalConfig" ALTER COLUMN "includeInGlobal" SET DEFAULT false;
