-- Máquina de efectivo (fase 1a, Codex servidor r2 #13): el MCP `cash_machine_closes` filtra, pagina y cuenta por la hora del
-- comprobante (`occurredAt`); sin este índice el conteo de un día recorría el historial de la sucursal.
-- CONCURRENTLY, como 20261120120001: no frena las escrituras mientras se construye. Una sola sentencia por archivo: Prisma manda el
-- archivo como un lote y PostgreSQL rechaza CONCURRENTLY dentro de la transacción implícita de un lote de varias sentencias. Si se
-- interrumpe, el índice queda INVÁLIDO e IF NOT EXISTS lo saltaría al reintentar: revisa pg_index.indisvalid, borra sólo esa copia con
-- DROP INDEX CONCURRENTLY "CashMachineClose_venueId_occurredAt_idx", marca la migración como revertida
-- (prisma migrate resolve --rolled-back) y vuelve a desplegar.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CashMachineClose_venueId_occurredAt_idx" ON "public"."CashMachineClose"("venueId", "occurredAt");
