-- D26 (22-nov-2026): el aviso de Blumon que dijo que el banco RECHAZÓ la venta que esta solicitud tenía en la terminal (Testarudo:
-- el aviso llegó 1 s después del rechazo y nadie lo usó). Lo escribe sólo el receptor de Blumon; la venta se cierra BANK_DECLINED
-- cuando ya no puede haber otro intento en vuelo. Columna nula y aditiva: un proceso viejo no la lee ni la escribe.
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN "bankDeclineEventLogId" TEXT;
