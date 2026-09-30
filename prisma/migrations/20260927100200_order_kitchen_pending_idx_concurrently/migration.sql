-- El barrido de comandas busca cada minuto órdenes con la marca puesta (casi nunca hay ninguna). Índice PARCIAL:
-- la búsqueda no recorre Order. Order recibe escrituras en cada cobro: CONCURRENTLY y en una sola sentencia.
-- Mismo patrón que 20260901204000_order_loyalty_pending_index_concurrently.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_kitchenPendingAt_pending_idx"
  ON "Order"("kitchenPendingAt")
  WHERE "kitchenPendingAt" IS NOT NULL;
