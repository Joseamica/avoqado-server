-- F1 · bloque 1 (18-nov-2026): la PAX nueva (`terminalPaymentExecutionVersion >= 2`) acredita, junto con el cese, si ESTA solicitud
-- se puede declarar «no se cobró». Aditiva y sin valor por omisión: las filas de hoy quedan en NULL («sin certificado») y sólo se
-- exige a las solicitudes entregadas a una terminal v2. Un proceso viejo no la lee ni la escribe.
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN "executionDeclarable" BOOLEAN;
