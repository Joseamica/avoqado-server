-- Fase 1 — desenlace SUPERSEDED para una entrega del outbox de aprobación.
--
-- Cuando una decisión más nueva ya salió (p.ej. "aprobado"), la entrega vieja ("en espera")
-- NO debe enviarse: llegaría después y contradiría a la nueva. Ese desenlace es NORMAL, no
-- una falla, así que no puede compartir estado con DEAD_LETTER — que es precisamente lo que
-- alguien tiene que ir a revisar.
--
-- Aditivo y sin bloqueo: en PostgreSQL 12+ `ADD VALUE` sobre un enum no reescribe la tabla.
-- `IF NOT EXISTS` lo hace re-ejecutable si la migración se repite en un entorno a medias.
ALTER TYPE "CustomerApprovalDeliveryStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';
