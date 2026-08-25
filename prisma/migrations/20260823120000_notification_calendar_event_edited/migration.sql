-- Aviso al venue cuando edita en Google un evento que Avoqado empujó.
-- Fase 2 del plan docs/plans/2026-08-22-buffer-y-ediciones-gcal.md
--
-- Va en su PROPIA migración a propósito: Postgres no permite USAR un valor de
-- enum recién agregado dentro de la misma transacción que lo agrega. Separarlo
-- evita ese error el día que alguien añada aquí un INSERT que lo referencie.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CALENDAR_EVENT_EDITED';
