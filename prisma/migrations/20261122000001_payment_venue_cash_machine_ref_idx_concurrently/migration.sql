-- Máquina de efectivo (fase 1a): buscar el pago de la máquina por folio dentro de la sucursal (`Payment.cashMachineRef`).
-- CONCURRENTLY porque Payment recibe una escritura en cada cobro y un CREATE INDEX normal las frenaría mientras se construye.
-- Una sola sentencia por archivo: Prisma manda el archivo como un lote y PostgreSQL rechaza CONCURRENTLY dentro de la
-- transacción implícita de un lote de varias sentencias. Si se interrumpe, el índice queda INVÁLIDO e IF NOT EXISTS lo
-- saltaría al reintentar: revisa pg_index.indisvalid, borra sólo esa copia con
-- DROP INDEX CONCURRENTLY "Payment_venueId_cashMachineRef_idx", marca la migración como revertida
-- (prisma migrate resolve --rolled-back) y vuelve a desplegar.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Payment_venueId_cashMachineRef_idx" ON "public"."Payment"("venueId", "cashMachineRef");
