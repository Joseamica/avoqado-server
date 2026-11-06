-- El consecutivo PO<fecha>-NNN es de cada negocio, pero el índice era de toda la base: el segundo
-- negocio del día chocaba. Lo que ya es único en toda la base también lo es por negocio, así que
-- crear este índice no puede fallar con los datos existentes.

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_venueId_orderNumber_key" ON "PurchaseOrder"("venueId", "orderNumber");

-- DropIndex
DROP INDEX "PurchaseOrder_orderNumber_key";
