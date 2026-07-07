-- Configurable accounting scope:
--  · MerchantFiscalConfig.includeInAccounting (default true, opt-out): exclude a merchant's payments
--    from the fiscal books (pólizas / IVA / ISR / reportes). Multi-merchant venues that don't want a
--    given account in their contabilidad.
--  · FiscalEmisor.includeCashInAccounting (default false, opt-in): whether CASH-paid sales count in the
--    fiscal numbers. The gerencial "¿cuánto gané?" always shows the full total; this only governs the
--    fiscal books. Off by default → cash is not declared unless the venue opts in.
ALTER TABLE "MerchantFiscalConfig" ADD COLUMN "includeInAccounting" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "FiscalEmisor" ADD COLUMN "includeCashInAccounting" BOOLEAN NOT NULL DEFAULT false;
