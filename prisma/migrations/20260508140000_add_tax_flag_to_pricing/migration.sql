-- Adds explicit tax (IVA) semantics to pricing structures.
--
-- `includesTax` (nullable) indicates whether the rate columns already include tax:
--   true  → rate is final (no tax added at calc time)
--   false → rate is base (calc multiplies by 1 + taxRate)
--   null  → legacy / unknown. Treated as `true` for backward compatibility
--           (current calc has never added tax). Audit each venue's contract
--           and update to true/false as you confirm them.
--
-- `taxRate` defaults to 16% (Mexican IVA) and is per-row so different
-- jurisdictions or future tax changes can be modeled without code changes.
-- Same pattern and default as `Product.taxRate` / `Order.taxRate`.

ALTER TABLE "ProviderCostStructure"
  ADD COLUMN "includesTax" BOOLEAN,
  ADD COLUMN "taxRate"     DECIMAL(5,4) NOT NULL DEFAULT 0.16;

ALTER TABLE "VenuePricingStructure"
  ADD COLUMN "includesTax" BOOLEAN,
  ADD COLUMN "taxRate"     DECIMAL(5,4) NOT NULL DEFAULT 0.16;

ALTER TABLE "OrganizationPricingStructure"
  ADD COLUMN "includesTax" BOOLEAN,
  ADD COLUMN "taxRate"     DECIMAL(5,4) NOT NULL DEFAULT 0.16;
