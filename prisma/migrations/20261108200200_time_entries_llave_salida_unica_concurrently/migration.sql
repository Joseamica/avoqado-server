-- App de campo, bloque 0 (Codex C4): el único de "llaveSalida" en "time_entries", para que la misma llave de checada del celular
-- nunca deje dos filas. Las dos columnas nacen en 20261108200000, nullable: las checadas de hoy (PAX, POS) quedan en NULL y no chocan.
--
-- ONE statement per file, on purpose (precedent: 20261014180000_cfdi_order_id_index). Prisma sends a migration file as a single
-- multi-statement batch inside an implicit transaction, where CREATE INDEX CONCURRENTLY is rejected (SQLSTATE 25001); a file with
-- exactly one statement is not wrapped, so CONCURRENTLY works and writes to "time_entries" (clock-ins and clock-outs of every app)
-- are never blocked while it builds. IF NOT EXISTS: an environment that already built it by hand skips it. The name is Prisma's
-- default for `@@unique([staffId, llaveSalida])`.
-- Recovery: if pg_index.indisvalid is false, DROP INDEX CONCURRENTLY "time_entries_staffId_llaveSalida_key" and retry this migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "time_entries_staffId_llaveSalida_key" ON "time_entries"("staffId", "llaveSalida");
