-- Fase 4 de la unificación de caja: UNA caja abierta por negocio, garantizada en la BASE.
--
-- `openSession` hacía check-then-create sin candado: dos requests simultáneos pasaban el findFirst antes
-- de que ninguno creara, y el venue quedaba con DOS sesiones OPEN.
--
-- 🔴 PREFLIGHT + ÍNDICE EN UN SOLO BLOQUE `DO` = UNA transacción (Codex, 3ª auditoría): Prisma no garantiza
-- que el archivo entero corra en una transacción, y entre el UPDATE y el CREATE INDEX cabía otra doble
-- apertura. Dentro del bloque no cabe nada. El preflight es DETERMINISTA (sobrevive la abierta más
-- reciente; las demás se cierran como administrativas, SIN conteo — nunca "cuadró") e idempotente.
-- `NOW() AT TIME ZONE 'UTC'`: las columnas son timestamp sin zona y Prisma escribe UTC.
-- Índice único PARCIAL (sólo restringe las OPEN), igual que `PrintStation_venueId_packing_key`.
DO $$
BEGIN
  UPDATE "CashDrawerSession" s
  SET "status" = 'CLOSED',
      "closedAt" = (NOW() AT TIME ZONE 'UTC'),
      "closingNote" = COALESCE("closingNote" || ' · ', '') || 'Cerrada automáticamente: doble apertura (migración 2026-08-27)',
      "updatedAt" = (NOW() AT TIME ZONE 'UTC')
  WHERE s."status" = 'OPEN'
    AND EXISTS (
      SELECT 1 FROM "CashDrawerSession" newer
      WHERE newer."venueId" = s."venueId"
        AND newer."status" = 'OPEN'
        AND (newer."openedAt" > s."openedAt" OR (newer."openedAt" = s."openedAt" AND newer."id" > s."id"))
    );
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "CashDrawerSession_venueId_open_key" ON "CashDrawerSession"("venueId") WHERE "status" = ''OPEN''';
END $$;
