-- La B (soporte por WhatsApp), C8 «quién abrió o cerró la caja»: lee las cajas de una sucursal que se abrieron o se cerraron en un
-- día, o que siguen abiertas. Uno de los dos índices de las ramas con fecha (el @@index de CashDrawerSession en schema.prisma), pero
-- CONCURRENTLY: la tabla recibe una escritura en cada apertura, cierre y cobro en efectivo, y un CREATE INDEX normal frenaría esas
-- escrituras mientras se construye. Una sola sentencia por archivo: Prisma manda el archivo como un lote, y PostgreSQL rechaza
-- CONCURRENTLY dentro de la transacción implícita de un lote de varias sentencias. Si se interrumpe (p. ej. el lock_timeout de
-- migrate:deploy:bounded), el índice queda INVÁLIDO e IF NOT EXISTS lo saltaría al reintentar: revisa pg_index.indisvalid, borra
-- sólo esa copia con DROP INDEX CONCURRENTLY "CashDrawerSession_venueId_closedAt_idx", marca la migración como revertida
-- (prisma migrate resolve --rolled-back) y vuelve a desplegar. Mientras éste no sea válido, la capacidad sigue apagada.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CashDrawerSession_venueId_closedAt_idx" ON "public"."CashDrawerSession"("venueId", "closedAt");
