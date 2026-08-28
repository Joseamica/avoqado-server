-- Preflight de la fase 4 (P1 de la auditoría de Codex, 27-ago): la migración 20260827151634 crea
-- un índice único parcial sobre CashDrawerSession(venueId) WHERE status='OPEN'. Si producción ya
-- traía DOS sesiones OPEN del mismo venue (la carrera que ese índice viene a cerrar), el CREATE
-- UNIQUE INDEX revienta por duplicados y detiene el deploy. Este archivo lleva timestamp ANTERIOR
-- para correr antes, y resuelve los duplicados de forma DETERMINISTA: por venue sobrevive la caja
-- abierta más reciente; las demás se cierran como administrativas, SIN conteo (actualAmount y
-- overShort NULL — nunca "cuadró"), con nota que deja rastro. Idempotente: sin duplicados, no toca nada.
UPDATE "CashDrawerSession" s
SET "status" = 'CLOSED',
    "closedAt" = NOW(),
    "closingNote" = COALESCE("closingNote" || ' · ', '') || 'Cerrada automáticamente: doble apertura (migración 2026-08-27)',
    "updatedAt" = NOW()
WHERE s."status" = 'OPEN'
  AND EXISTS (
    SELECT 1 FROM "CashDrawerSession" newer
    WHERE newer."venueId" = s."venueId"
      AND newer."status" = 'OPEN'
      AND (newer."openedAt" > s."openedAt" OR (newer."openedAt" = s."openedAt" AND newer."id" > s."id"))
  );
