-- El consecutivo EST-<fecha>-NNN es de cada negocio, pero el índice era de toda la base: el segundo
-- negocio del día no podía cotizar. Lo que ya es único en toda la base también lo es por negocio, así que
-- crear este índice no puede fallar con los datos existentes.

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_venueId_estimateNumber_key" ON "Estimate"("venueId", "estimateNumber");

-- DropIndex
DROP INDEX "Estimate_estimateNumber_key";
