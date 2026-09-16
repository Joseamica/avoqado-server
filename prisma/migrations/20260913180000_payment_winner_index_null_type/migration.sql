-- Revisión de diseño de Codex (S0, 13-sep-2026, P2): `Payment.type` es NULLABLE y `"type" <> 'REFUND'` deja FUERA del
-- índice a las filas con type NULL — dos COMPLETED con type NULL y la misma solicitud cabrían las dos. `IS DISTINCT
-- FROM` las incluye. DROP + CREATE en un solo bloque DO (una transacción): entre los dos no cabe otra escritura.
DO $$
BEGIN
  EXECUTE 'DROP INDEX IF EXISTS "Payment_terminal_request_winner_key"';
  EXECUTE 'CREATE UNIQUE INDEX "Payment_terminal_request_winner_key" ON "Payment"("terminalPaymentRequestId") WHERE "status" = ''COMPLETED'' AND "type" IS DISTINCT FROM ''REFUND''';
END $$;
