-- D662 parte 2 (v3): la lectura de la pausa sola recorre los pedidos de «Mi equipo» de un negocio por hora límite y `id`, desde el
-- corte (el @@index de OnlineOrder en schema.prisma). CONCURRENTLY: la tabla recibe una escritura en cada pedido en línea y un CREATE
-- INDEX normal frenaría esas escrituras mientras se construye (Codex p2-r2 #7). Una sola sentencia por archivo: Prisma manda el archivo
-- como un lote, y PostgreSQL rechaza CONCURRENTLY dentro de la transacción implícita de un lote de varias sentencias. Si se interrumpe
-- (p. ej. el lock_timeout de migrate:deploy:bounded), el índice queda INVÁLIDO e IF NOT EXISTS lo saltaría al reintentar: revisa
-- pg_index.indisvalid, borra sólo esa copia con DROP INDEX CONCURRENTLY "OnlineOrder_venueId_requiresAcceptance_acceptDeadlineAt_id_idx",
-- marca la migración como revertida (prisma migrate resolve --rolled-back) y vuelve a desplegar. Sin el índice la lectura sigue siendo
-- correcta (usa el de venueId), sólo más lenta.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "OnlineOrder_venueId_requiresAcceptance_acceptDeadlineAt_id_idx" ON "public"."OnlineOrder"("venueId", "requiresAcceptance", "acceptDeadlineAt", "id");
