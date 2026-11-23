-- D26 (22-nov-2026): cuándo pidió el POS cancelar esta solicitud por PRIMERA vez. Es el origen del techo a «sigo cobrando»
-- (`soltarRanuraPorTechoTrasCancelar`): con la terminal contestando ACTIVE sin señales de dinero, la RANURA se suelta 5 min
-- después. Columna nula y aditiva: un proceso viejo no la lee ni la escribe; las filas de hoy quedan en NULL (sin techo).
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);
