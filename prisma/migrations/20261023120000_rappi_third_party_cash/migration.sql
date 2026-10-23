-- Rappi 2b (efectivo con repartidor propio): tarifa de Rappi cobrada por cuenta de la plataforma y propina contractual.
-- Columnas nuevas, opcionales y sin valor por omisión: no tocan filas existentes.
ALTER TABLE "Order" ADD COLUMN "thirdPartyCashDue" DECIMAL(12,2);
ALTER TABLE "Order" ADD COLUMN "cashTipDue" DECIMAL(12,2);
ALTER TABLE "Payment" ADD COLUMN "thirdPartyCashAmount" DECIMAL(12,2);
