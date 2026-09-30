-- El folio único por negocio (spec 2026-09-27 §1). KdsOrder se escribe en cada comanda: CONCURRENTLY y en una
-- sola sentencia. Si se interrumpe, DROP INDEX CONCURRENTLY de la copia inválida y reintenta.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "KdsOrder_venueId_sourceKey_key" ON "KdsOrder"("venueId", "sourceKey");
