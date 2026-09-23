-- KDS de Uber, revisión final (I-1): el barrido alerta cada minuto las órdenes cuya reconciliación
-- quedó bloqueada esperando a una persona, y el MCP las lista por negocio. Índice PARCIAL sobre las
-- filas bloqueadas, casi siempre ninguna: ninguna de las dos búsquedas recorre Order.
-- Order recibe escrituras en cada cobro, así que CONCURRENTLY y en una sola sentencia; si se
-- interrumpe, DROP INDEX CONCURRENTLY de la copia inválida y reintenta.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_deliveryReconcileBlocked_idx"
  ON "Order"("venueId")
  WHERE "deliveryReconcileBlocked" IS NOT NULL;
