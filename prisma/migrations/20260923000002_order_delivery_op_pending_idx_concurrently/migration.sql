-- KDS de Uber, tarea 15: el barrido busca cada minuto reservas de pedido huérfanas (spec §3.2).
-- Índice PARCIAL sobre las filas con reserva, casi siempre ninguna: la búsqueda no recorre Order.
-- Order recibe escrituras en cada cobro, así que CONCURRENTLY y en una sola sentencia; si se
-- interrumpe, DROP INDEX CONCURRENTLY de la copia inválida y reintenta.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_deliveryOpInFlightAt_pending_idx"
  ON "Order"("deliveryOpInFlightAt")
  WHERE "deliveryOpToken" IS NOT NULL;
