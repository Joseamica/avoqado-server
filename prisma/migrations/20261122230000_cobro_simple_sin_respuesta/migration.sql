-- Cobro simple · S1 (22-nov-2026): «sin respuesta ⇒ 10 s ⇒ no cobrado».
-- 1) Cuándo entró la solicitud a «sin respuesta». Nula y aditiva: un proceso viejo no la lee ni la escribe.
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN "noResponseAt" TIMESTAMP(3);

-- 2) La RANURA de la terminal sólo existe mientras el cobro está EN VUELO. Antes el índice parcial también apartaba la terminal con
--    una fila UNKNOWN (la duda): la quitaba sólo una persona o el reloj de 20 min. El nuevo WHERE es MÁS permisivo que el viejo, así
--    que recrearlo nunca falla con los datos de hoy. La tabla es chica (miles de filas): sin CONCURRENTLY, en la misma transacción.
DROP INDEX IF EXISTS "TerminalPaymentRequest_active_slot";
CREATE UNIQUE INDEX "TerminalPaymentRequest_active_slot" ON "TerminalPaymentRequest"("terminalId") WHERE "status" IN ('PENDING', 'SENT', 'CANCEL_REQUESTED');
