-- Buffer post-servicio + fin de bloque de agenda.
-- Plan: docs/plans/2026-08-22-buffer-y-ediciones-gcal.md
--
-- El ORDEN de los pasos es la parte crítica de esta migración, no el SQL.
-- "blockedEndsAt" pasa a ser lo que la disponibilidad consulta para detectar
-- solapamientos. Una sola fila que se quede sin el dato deja de bloquear su
-- propio horario -> se podría vender encima de una cita existente, que es peor
-- que el bug que este trabajo arregla. Por eso: agregar vacía, llenar TODAS, y
-- sólo entonces exigirla.

-- Paso 1 — las columnas nacen vacías y nadie las consulta todavía.
ALTER TABLE "Product" ADD COLUMN "bufferAfterMin" INTEGER;
ALTER TABLE "Reservation" ADD COLUMN "blockedEndsAt" TIMESTAMP(3);

-- Paso 2 — backfill: toda cita existente bloquea exactamente hasta donde
-- termina, que es el comportamiento actual. Idempotente por el WHERE.
UPDATE "Reservation" SET "blockedEndsAt" = "endsAt" WHERE "blockedEndsAt" IS NULL;

-- Paso 3 — recién ahora es obligatoria.
ALTER TABLE "Reservation" ALTER COLUMN "blockedEndsAt" SET NOT NULL;

-- Espejos de los dos índices de solapamiento existentes
-- ("venueId, startsAt, endsAt" y "assignedStaffId, startsAt, endsAt"), ahora
-- sobre el fin de bloque. Sin ellos la disponibilidad pierde el índice.
CREATE INDEX "Reservation_venueId_startsAt_blockedEndsAt_idx" ON "Reservation"("venueId", "startsAt", "blockedEndsAt");
CREATE INDEX "Reservation_assignedStaffId_startsAt_blockedEndsAt_idx" ON "Reservation"("assignedStaffId", "startsAt", "blockedEndsAt");
