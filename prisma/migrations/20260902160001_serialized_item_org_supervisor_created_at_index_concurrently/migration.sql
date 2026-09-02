-- Control de Stock (PlayTelecom): las consultas de summary/items/bulk-groups se acotan por
-- organización y se ordenan por createdAt; sin este índice cada página seguía ordenando el
-- inventario serializado completo de la organización.
-- UN solo CREATE INDEX CONCURRENTLY por migración: Postgres envuelve un script de varias
-- sentencias en una transacción implícita y CONCURRENTLY no puede correr dentro de una
-- (SQLSTATE 25001; lo reprobó el CI el 2026-09-02). Mismo precedente que los índices de
-- ActivityLog del 2026-08-08.
-- Recovery: inspect pg_index.indisvalid/indisready; if invalid, run a separate
-- DROP INDEX CONCURRENTLY for this exact name, then retry this migration.
CREATE INDEX CONCURRENTLY "SerializedItem_organizationId_assignedSupervisorId_createdAt_id_idx" ON "SerializedItem"("organizationId", "assignedSupervisorId", "createdAt" DESC, "id" DESC);
