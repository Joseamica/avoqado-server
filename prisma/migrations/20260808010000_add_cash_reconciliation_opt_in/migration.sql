-- PITS H0.6: additive, default-off venue opt-in. No current venue is activated.
ALTER TABLE "VenueSettings"
ADD COLUMN "cashReconciliationEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Register the paid Feature so explicit VenueFeature grants are possible. PRO/PREMIUM blanket
-- entitlement remains in basePlan.service; this creates no VenueFeature row and has price 0 because
-- the capability is bundled with the base plan rather than sold à la carte by this migration.
INSERT INTO "Feature" ("id", "code", "name", "description", "category", "monthlyPrice", "active")
VALUES (
  'feature_cash_reconciliation_v1',
  'CASH_RECONCILIATION',
  'Conciliación de efectivo por turno',
  'Conteo ciego y cálculo de caja cuadrada, faltante o sobrante al cerrar un turno.',
  'OPERATIONS',
  0.00,
  true
)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "active" = true;
