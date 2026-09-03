-- Task 5 del turno de caja del NEGOCIO (3-sep-2026): QUIÉN cerró el turno.
--
-- El cajón físico ya lo guarda (`CashDrawerSession.closedByStaffId` / `closedByName`) y el `Shift`
-- no: hoy la única constancia de quién cerró un turno es la fila de `ActivityLog`, que es
-- best-effort y no se puede unir en una consulta. Con el cierre unificado eso importa más, porque
-- el gesto que cierra los dos registros puede venir de la tablet o de la PAX, y de personas
-- distintas: sin esta columna, los dos lados del MISMO cierre podrían no coincidir en el autor y
-- nadie sabría cuál mirar.
--
-- Escrita A MANO a propósito: la base local es compartida con ~20 sesiones y `migrate dev` puede
-- proponer un reset.
--
-- ADITIVA y NULABLE: todos los turnos anteriores se quedan en NULL. No se adivina hacia atrás —
-- `Shift.staffId` es quien ABRIÓ, y copiarlo aquí afirmaría que también cerró, que es justo el
-- supuesto que esta columna existe para dejar de hacer.
--
-- `ON DELETE SET NULL`: dar de baja a un empleado jamás puede llevarse por delante el cierre de un
-- turno (aunque el borrado de staff en este repo sea suave, la FK no puede depender de eso).
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "closedById" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Shift_closedById_fkey') THEN
    ALTER TABLE "Shift"
      ADD CONSTRAINT "Shift_closedById_fkey"
      FOREIGN KEY ("closedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Shift_closedById_idx" ON "Shift"("closedById");
