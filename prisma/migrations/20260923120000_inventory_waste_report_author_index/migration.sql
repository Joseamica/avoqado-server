-- Historial de mermas del POS: el mesero pide SUS folios aplicados, más recientes primero.
-- La tabla nace en 20260921190000 (mismo despliegue): el índice se crea sobre una tabla vacía
-- o casi, así que un CREATE INDEX normal no retiene nada que importe.
-- Nombre corto explícito (`map:` en el esquema): el automático pasa de 63 caracteres y Postgres lo recorta.
CREATE INDEX IF NOT EXISTS "InventoryWasteReport_author_history_idx"
  ON "InventoryWasteReport"("venueId", "status", "reportedByStaffId", "createdAt" DESC, "id" DESC);
