-- D4 (5-nov): llave de la entrega de un paquete vendido en el POS. Aditiva: las filas de hoy quedan en NULL y un índice único
-- de Postgres no compara NULL, así que las apps viejas (sin llave) siguen creando una compra por llamada.
ALTER TABLE "CreditPackPurchase" ADD COLUMN "deliveryKey" TEXT;

CREATE UNIQUE INDEX "CreditPackPurchase_venueId_deliveryKey_key" ON "CreditPackPurchase"("venueId", "deliveryKey");
