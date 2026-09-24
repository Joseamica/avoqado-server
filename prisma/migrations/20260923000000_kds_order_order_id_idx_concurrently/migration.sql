-- KDS de Uber, tarea 15: las comandas de una venta (cancelar un pedido, el barrido del KDS).
-- Es el `@@index([orderId])` de KdsOrder en schema.prisma (salida de `prisma migrate diff`), pero
-- CONCURRENTLY: KdsOrder se escribe en cada comanda y un índice normal pausaría la cocina mientras
-- Render corre migrate deploy. Una sola sentencia, porque PostgreSQL rechaza CONCURRENTLY dentro de
-- un bloque de transacción. Si se interrumpe, borra sólo la copia inválida con
-- DROP INDEX CONCURRENTLY y reintenta la migración.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "KdsOrder_orderId_idx" ON "KdsOrder"("orderId");
