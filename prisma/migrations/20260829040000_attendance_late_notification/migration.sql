-- Aviso EN VIVO de retardo: un tipo propio de notificación.
--
-- Se escribe a mano (no `prisma migrate dev`) porque la base local es COMPARTIDA entre sesiones
-- y `migrate dev` puede proponer un reset ante cualquier deriva ajena. Mismo criterio que las
-- migraciones 20260828010000 y 20260827151634.
--
-- `ADD VALUE IF NOT EXISTS` es idempotente y no bloquea la tabla: agregar un valor a un enum no
-- reescribe filas. Va en su propia transacción implícita — Postgres no permite usar un valor de
-- enum recién añadido dentro de la MISMA transacción que lo creó.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTENDANCE_LATE';
