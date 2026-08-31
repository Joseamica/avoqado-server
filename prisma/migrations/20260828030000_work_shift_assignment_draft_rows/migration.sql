-- Turnos rotativos (Codex, 2ª auditoría, P1): un borrador NO puede despublicar el horario vigente.
-- Antes había UNA fila por persona+fecha; ahora conviven una PUBLISHED y una DRAFT por celda.
-- 🔴 DROP + CREATE en un solo bloque `DO` = una transacción (Codex, 3ª auditoría): sin la restricción vieja y
-- sin la nueva no puede haber ni un instante en el que entren duplicados.
DO $$
BEGIN
  EXECUTE 'DROP INDEX IF EXISTS "WorkShiftAssignment_staffVenueId_date_key"';
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "WorkShiftAssignment_staffVenueId_date_status_key" ON "WorkShiftAssignment"("staffVenueId", "date", "status")';
END $$;
