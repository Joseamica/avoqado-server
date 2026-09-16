-- Checkpoint 1 del webhook como primer confirmador (Codex gpt-6-astra, 13-sep-2026) — paso S9.
-- TODO ADITIVO E IDEMPOTENTE: ninguna fila existente cambia de significado; NULL en las columnas nuevas de las
-- filas históricas significa «anterior a esta migración», nunca un valor deducido.
--
-- 1) Vínculo intento → solicitud (S1). Una solicitud tiene VARIOS intentos (un reintento tras rechazo abre uno
--    nuevo); un intento pertenece a UNA solicitud para siempre: `attemptId` único GLOBAL = dueño inmutable.
CREATE TABLE IF NOT EXISTS "TerminalPaymentAttemptLink" (
  "id"         TEXT NOT NULL,
  "requestId"  TEXT NOT NULL,
  "attemptId"  TEXT NOT NULL,
  "venueId"    TEXT NOT NULL,
  "terminalId" TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TerminalPaymentAttemptLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TerminalPaymentAttemptLink_attemptId_key"
  ON "TerminalPaymentAttemptLink"("attemptId");
CREATE INDEX IF NOT EXISTS "TerminalPaymentAttemptLink_requestId_createdAt_idx"
  ON "TerminalPaymentAttemptLink"("requestId", "createdAt");
CREATE INDEX IF NOT EXISTS "TerminalPaymentAttemptLink_venueId_terminalId_createdAt_idx"
  ON "TerminalPaymentAttemptLink"("venueId", "terminalId", "createdAt");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TerminalPaymentAttemptLink_requestId_fkey') THEN
    ALTER TABLE "TerminalPaymentAttemptLink"
      ADD CONSTRAINT "TerminalPaymentAttemptLink_requestId_fkey"
      FOREIGN KEY ("requestId") REFERENCES "TerminalPaymentRequest"("requestId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 2) Quién cerró la solicitud (S8): 'terminal' | 'webhook'. Se escribe UNA vez y conserva al ganador original.
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN IF NOT EXISTS "closedVia" TEXT;

-- 3) UN ganador financiero canónico por solicitud (S0), garantizado en la BASE y no sólo en el servicio.
--    `Payment.terminalPaymentRequestId` es la columna indexable de lo que hoy sólo vive en
--    `processorData.terminalPaymentRequestId` (el JSON se conserva para los lectores actuales). El índice único
--    es PARCIAL a propósito: sólo un COMPLETED que no sea reembolso puede ser el ganador; una POSIBLE SEGUNDA
--    CAPTURA cabe como PENDING (evidencia + conciliación) y los cobros sin solicitud no se restringen entre sí.
--    Mismo patrón que "CashDrawerSession_venueId_open_key".
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "terminalPaymentRequestId" TEXT;
CREATE INDEX IF NOT EXISTS "Payment_terminalPaymentRequestId_idx" ON "Payment"("terminalPaymentRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_terminal_request_winner_key"
  ON "Payment"("terminalPaymentRequestId")
  WHERE "status" = 'COMPLETED' AND "type" <> 'REFUND';

-- 4) Evidencia por intento (S7) y lease del worker propio (S4), mismo vocabulario que "PaymentEffect".
ALTER TABLE "ProviderEventLog" ADD COLUMN IF NOT EXISTS "attemptId" TEXT;
ALTER TABLE "ProviderEventLog" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProviderEventLog" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "ProviderEventLog" ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3);
ALTER TABLE "ProviderEventLog" ADD COLUMN IF NOT EXISTS "claimToken" TEXT;
ALTER TABLE "ProviderEventLog" ADD COLUMN IF NOT EXISTS "lastError" VARCHAR(500);
CREATE INDEX IF NOT EXISTS "ProviderEventLog_attemptId_idx" ON "ProviderEventLog"("attemptId");
CREATE INDEX IF NOT EXISTS "ProviderEventLog_status_nextAttemptAt_id_idx" ON "ProviderEventLog"("status", "nextAttemptAt", "id");
CREATE INDEX IF NOT EXISTS "ProviderEventLog_status_leaseUntil_id_idx" ON "ProviderEventLog"("status", "leaseUntil", "id");
