-- POS de WINDOWS (hz:a5fa2439:D1): cómo dibuja la PC, tal como lo reporta el aparato. Nula, sin valor por defecto y sin
-- índice: aditiva, un proceso viejo no la lee ni la escribe. El cliente de Prisma la omite por defecto (`serverOnlyOmit`),
-- así que ninguna respuesta existente la devuelve.
ALTER TABLE "Terminal" ADD COLUMN "deviceDiagnostics" JSONB;
