-- «Ninguna terminal muerta» (22-sep-2026), pieza B.
-- La declaración del cajero «el cliente no presentó tarjeta» sobre un intento SIN solicitud del POS (un Pago rápido).
-- ADITIVA e IDEMPOTENTE: crea una tabla nueva y no toca ninguna existente. No hay migración de datos.
--
-- Por qué una tabla propia y no `requestId` nullable en "TerminalPaymentAttemptLink": de esa columna cuelgan una FK,
-- el trigger `preserve_no_instrument_resolution`, un conteo de unicidad por solicitud y el despertador del POS.
--
-- Sin FK a "TerminalPaymentRequest" A PROPÓSITO: un cobro local no tiene solicitud, y ésa es justamente la razón de
-- que esta tabla exista. El `attemptId` único es lo que vuelve la declaración irrepetible.
CREATE TABLE IF NOT EXISTS "TerminalAttemptResolution" (
    "id"         TEXT NOT NULL,
    "attemptId"  TEXT NOT NULL,
    "venueId"    TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "resolution" JSONB NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TerminalAttemptResolution_pkey" PRIMARY KEY ("id")
);

-- Un intento se declara UNA sola vez: la inmutabilidad sale de aquí, no de un trigger.
CREATE UNIQUE INDEX IF NOT EXISTS "TerminalAttemptResolution_attemptId_key"
    ON "TerminalAttemptResolution"("attemptId");

CREATE INDEX IF NOT EXISTS "TerminalAttemptResolution_venueId_terminalId_createdAt_idx"
    ON "TerminalAttemptResolution"("venueId", "terminalId", "createdAt");
