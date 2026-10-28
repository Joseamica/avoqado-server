-- Índice de la llave foránea Modifier.groupId (pizarrón hz:12c781a4:D2). CONCURRENTLY para no bloquear las escrituras del
-- menú en producción; por eso va SOLO en este archivo (Prisma manda el archivo como un solo bloque). IF NOT EXISTS: un
-- entorno que ya lo creó a mano lo salta.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Modifier_groupId_idx" ON "Modifier"("groupId");
