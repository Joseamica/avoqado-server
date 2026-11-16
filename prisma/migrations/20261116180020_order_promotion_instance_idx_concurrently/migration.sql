-- D7: ¿una ronda con combos ya se guardó en alguna cuenta del negocio (aunque la hayan separado o movido)? Se busca por la
-- instancia del combo; sólo existía el índice (orderId, instanceId). CONCURRENTLY: cada venta con combo escribe aquí.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "OrderPromotion_instanceId_idx" ON "OrderPromotion"("instanceId");
