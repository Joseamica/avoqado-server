-- avoqado-server/prisma/migrations/20260908000000_stock_count_cancelled/migration.sql
--
-- Un conteo físico que nadie va a terminar se queda «En progreso» para siempre:
-- el enum sólo tenía IN_PROGRESS · APPLYING · COMPLETED, y la guía de cliente
-- prometía «retomarlo o dejarlo ir» sin que «dejarlo ir» existiera. Mindform
-- tiene dos borradores así (3 y 7 de septiembre de 2026, 0 líneas contadas).
--
-- Puramente aditivo: no toca ninguna fila existente ni cambia defaults.
-- `IF NOT EXISTS` lo hace idempotente — en PostgreSQL 12+ `ADD VALUE` puede
-- correr dentro de la transacción de la migración mientras el valor nuevo no se
-- USE aquí mismo.
ALTER TYPE "StockCountStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TABLE "StockCount" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
