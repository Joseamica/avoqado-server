-- POS de WINDOWS (hz:a5fa2439:D1): cómo dibuja la PC (lo reporta el aparato) y la orden de modo de dibujo (la manda el
-- dashboard). Nulas, sin valor por defecto y sin índice: aditivas, un proceso viejo no las lee ni las escribe. El cliente de
-- Prisma las omite por defecto (`serverOnlyOmit`), así que ninguna respuesta existente las devuelve.
ALTER TABLE "Terminal" ADD COLUMN "deviceDiagnostics" JSONB, ADD COLUMN "drawingModeOrder" JSONB;
