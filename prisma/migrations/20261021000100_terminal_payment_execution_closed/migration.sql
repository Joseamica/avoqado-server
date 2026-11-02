-- Tarea A2 («ninguna duda de un cobro sin salida», 20-oct-2026): cuándo la TERMINAL acreditó que cerró la ejecución de
-- esta solicitud (sin ejecución viva). Columna nula y aditiva; la escriben A3–A5.
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN "executionClosedAt" TIMESTAMP(3);
