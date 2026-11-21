-- D17: el archivado del día busca en todos los negocios las comandas sin archivar más viejas (archivedAt IS NULL + status +
-- createdAt). CONCURRENTLY: KdsOrder se escribe en cada comanda y un CREATE INDEX normal frenaría esas escrituras. Una sola
-- sentencia por archivo (Prisma manda el archivo como un lote y PostgreSQL rechaza CONCURRENTLY dentro de su transacción
-- implícita). Si se interrumpe, el índice queda INVÁLIDO e IF NOT EXISTS lo saltaría: revisa pg_index.indisvalid,
-- DROP INDEX CONCURRENTLY "KdsOrder_archivedAt_status_createdAt_idx", `prisma migrate resolve --rolled-back` y vuelve a
-- desplegar. Sin el índice el job funciona igual, sólo más lento.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "KdsOrder_archivedAt_status_createdAt_idx" ON "public"."KdsOrder"("archivedAt", "status", "createdAt");
