-- IVA por producto, M-5 (pendiente de C3/F6): índice de `Cfdi.orderId`. Emisión, extracción de la global, notas de crédito y
-- devoluciones buscan las facturas de una orden por `orderId`; sin índice cada búsqueda recorre la tabla. Sólo lectura más rápida:
-- no cambia datos ni conducta. Medido en producción (sólo lectura, 14-oct): 54 filas, 328 kB, el índice no existe.
--
-- ONE statement per file, on purpose (precedent: 20261013090000_activity_log_extraccion_emitida_unica). Prisma sends a migration file
-- as a single multi-statement batch inside an implicit transaction, where CREATE INDEX CONCURRENTLY is rejected (SQLSTATE 25001); a file
-- with exactly one statement is not wrapped, so CONCURRENTLY works and writes to "Cfdi" are never blocked while it builds.
-- IF NOT EXISTS: an environment that already built it by hand skips it. The name is Prisma's default for `@@index([orderId])`.
-- Recovery: if pg_index.indisvalid is false, DROP INDEX CONCURRENTLY "Cfdi_orderId_idx" and retry this migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Cfdi_orderId_idx" ON "Cfdi"("orderId");
