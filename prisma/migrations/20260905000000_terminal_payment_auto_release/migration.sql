-- UNKNOWN ya no es un callejón sin salida (Testarudo, 2026-09-04: una PAX quedó bloqueada 3 h).
-- El watchdog marca cuándo volvió la terminal (primer latido posterior a expiresAt) y libera el
-- slot 2 minutos después si no apareció ningún pago con tarjeta. Aditiva y nullable.
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN "terminalReturnedAt" TIMESTAMP(3);
