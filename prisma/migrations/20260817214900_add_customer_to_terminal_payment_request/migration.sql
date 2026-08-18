-- AlterTable
-- Nullable, sin default y sin FK: en PostgreSQL es instantánea (no reescribe la tabla),
-- y la ausencia de FK es deliberada — igual que "orderId"/"paymentId" en esta misma
-- tabla, que es un registro de INTENCIÓN dentro del camino del dinero.
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN "customerId" TEXT;
