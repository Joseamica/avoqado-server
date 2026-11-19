-- D662 (founder, 18-nov): la tienda en línea se pausa sola tras 2 pedidos de «Mi equipo» vencidos seguidos. Aditiva.
-- `missedOrdersSince` sin default: la hora la escribe siempre la app (en UTC, como `expiredAt`); NULL = el primer vencido empieza.
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN "missedOrdersSince" TIMESTAMP(3);
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN "autoPausedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "OnlineOrder_venueId_requiresAcceptance_status_expiredAt_idx" ON "OnlineOrder"("venueId", "requiresAcceptance", "status", "expiredAt");
