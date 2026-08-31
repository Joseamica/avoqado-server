-- Huella de la jornada en la autorización de horas extra (hallazgo #4 de la auditoría de
-- Codex, 29-ago-2026).
--
-- Versionar sólo `minutesMeasured` dejaba un hueco: se autorizan 60 min, una corrección los
-- baja a cero, y una corrección posterior vuelve a producir 60 min con checadas COMPLETAMENTE
-- distintas. La autorización vieja revivía sin que nadie la mirara.
--
-- La columna es NULLABLE a propósito: las filas que ya existen no tienen huella y se tratan
-- como "hay que volver a revisarlas", que es el lado seguro.
--
-- Escrita a mano: la base local es COMPARTIDA y `prisma migrate dev` puede proponer un reset.

ALTER TABLE "OvertimeApproval" ADD COLUMN IF NOT EXISTS "sourceFingerprint" TEXT;
