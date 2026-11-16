-- D7: la pareja (cuenta de la que salió, aparato) es única: una ronda tardía nunca abre dos cuentas aparte para lo mismo, ni con
-- dos peticiones a la vez. CONCURRENTLY porque "Order" se escribe en cada venta; las filas viejas tienen NULL (no chocan).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Order_rondaTardiaDeId_rondaTardiaAparato_key" ON "Order"("rondaTardiaDeId", "rondaTardiaAparato");
