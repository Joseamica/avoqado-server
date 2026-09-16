-- Codex R12-2 (checkpoint 1 del webhook como primer confirmador, 14-sep-2026): una afiliación ocupa UN solo slot de la
-- configuración de pagos. Los escritores lo validan en el servicio (`slotsDeAfiliacion.ts`); este CHECK es el respaldo contra dos
-- ediciones parciales CONCURRENTES que, cada una válida por separado, dejarían la misma cuenta en dos slots.
-- `NOT VALID`: no se revisan las filas existentes (una configuración ambigua histórica NO tumba el deploy: el cobro la declara
-- «captura fallida por configuración ambigua» y su costo queda pendiente y visible); toda escritura nueva sí queda sujeta.
ALTER TABLE "VenuePaymentConfig"
  ADD CONSTRAINT "VenuePaymentConfig_slots_distintos" CHECK (
    ("secondaryAccountId" IS NULL OR "secondaryAccountId" <> "primaryAccountId")
    AND ("tertiaryAccountId" IS NULL OR "tertiaryAccountId" <> "primaryAccountId")
    AND ("secondaryAccountId" IS NULL OR "tertiaryAccountId" IS NULL OR "secondaryAccountId" <> "tertiaryAccountId")
  ) NOT VALID;

ALTER TABLE "OrganizationPaymentConfig"
  ADD CONSTRAINT "OrganizationPaymentConfig_slots_distintos" CHECK (
    ("secondaryAccountId" IS NULL OR "secondaryAccountId" <> "primaryAccountId")
    AND ("tertiaryAccountId" IS NULL OR "tertiaryAccountId" <> "primaryAccountId")
    AND ("secondaryAccountId" IS NULL OR "tertiaryAccountId" IS NULL OR "secondaryAccountId" <> "tertiaryAccountId")
  ) NOT VALID;
