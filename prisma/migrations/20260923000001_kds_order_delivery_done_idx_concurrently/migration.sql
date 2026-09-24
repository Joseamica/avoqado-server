-- KDS de Uber, tarea 15: el barrido busca cada minuto los «listos» de reparto que no llegaron al
-- proveedor, por la comanda marcada en las últimas 6 h. Índice PARCIAL: sólo comandas de reparto ya
-- listas o terminadas, así el costo sigue a esas 6 h y no al historial de la cocina. No se declara
-- en schema.prisma: Prisma no modela índices parciales (mismo patrón que el índice de lealtad de Order).
-- CONCURRENTLY y en una sola sentencia por la misma razón que el índice de `orderId`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "KdsOrder_delivery_done_updatedAt_idx"
  ON "KdsOrder"("updatedAt")
  WHERE "orderType" = 'DELIVERY' AND status IN ('READY', 'COMPLETED');
