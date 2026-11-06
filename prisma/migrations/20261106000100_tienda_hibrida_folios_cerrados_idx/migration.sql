-- Tienda híbrida T9 (R4): `syncPaidClosedFolios` lee sólo los folios cerrados (vencidos, cancelados o rechazados) de los últimos
-- 7 días en todos los negocios; este índice evita recorrer todo el historial cerrado. Aditivo.
-- CreateIndex
CREATE INDEX "OnlineOrder_requiresAcceptance_status_updatedAt_idx" ON "OnlineOrder"("requiresAcceptance", "status", "updatedAt");
