-- Etapa 3 del KDS (docs/superpowers/specs/2026-09-27-kds-etapa-3-design.md §1). A mano, aditiva e
-- idempotente: la base local av-db-25 es COMPARTIDA entre sesiones.
ALTER TABLE "KdsOrder" ADD COLUMN IF NOT EXISTS "printStationId" TEXT;
ALTER TABLE "KdsOrder" ADD COLUMN IF NOT EXISTS "sourceKey" TEXT;
ALTER TABLE "KdsOrder" ADD COLUMN IF NOT EXISTS "fallbackPrintedAt" TIMESTAMP(3);
ALTER TABLE "PrintStation" ADD COLUMN IF NOT EXISTS "kitchenDisplaySince" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "kitchenPendingAt" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KdsOrder_printStationId_fkey') THEN
    -- NOT VALID + VALIDATE: la columna es nueva (toda NULL), así que validar no recorre nada pesado.
    ALTER TABLE "KdsOrder" ADD CONSTRAINT "KdsOrder_printStationId_fkey"
      FOREIGN KEY ("printStationId") REFERENCES "PrintStation"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
    ALTER TABLE "KdsOrder" VALIDATE CONSTRAINT "KdsOrder_printStationId_fkey";
  END IF;
END $$;

-- Relleno: las estaciones que la etapa 1 ya prendió empiezan su «cuenta nueva» cuando se prendieron (último
-- registro del cambio en la bitácora) o, si no hay registro, ahora.
UPDATE "PrintStation" ps
SET "kitchenDisplaySince" = COALESCE(
  (SELECT MAX(a."createdAt") FROM "ActivityLog" a
    WHERE a."entity" = 'PrintStation' AND a."entityId" = ps."id" AND a."action" = 'PRINT_STATION_KITCHEN_DISPLAY_SET'),
  NOW())
WHERE ps."hasKitchenDisplay" = true AND ps."kitchenDisplaySince" IS NULL;
