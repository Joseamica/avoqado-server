-- D662 parte 2 (v3): la pausa sola busca si una PERSONA contestó a tiempo algún pedido entre dos vencimientos (`EXISTS` sobre
-- `staffAnsweredAt` de un negocio; el @@index de OnlineOrder en schema.prisma). CONCURRENTLY y una sola sentencia por archivo, por lo
-- mismo que 20261120120001. Si se interrumpe, el índice queda INVÁLIDO: revisa pg_index.indisvalid, borra sólo esa copia con
-- DROP INDEX CONCURRENTLY "OnlineOrder_venueId_staffAnsweredAt_idx", marca la migración como revertida (prisma migrate resolve
-- --rolled-back) y vuelve a desplegar. Sin el índice la lectura sigue siendo correcta, sólo más lenta.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "OnlineOrder_venueId_staffAnsweredAt_idx" ON "public"."OnlineOrder"("venueId", "staffAnsweredAt");
