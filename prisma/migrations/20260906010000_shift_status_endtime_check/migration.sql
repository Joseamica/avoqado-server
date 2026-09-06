-- Turno de caja del NEGOCIO — el invariante estado ↔ `endTime` deja de vivir sólo en comentarios
-- (revisión del 5-sep-2026).
--
-- `Shift.status` y `Shift.endTime` dicen lo mismo de dos maneras: un turno CLOSED tiene hora de
-- cierre, un turno vivo (OPEN o CLOSING) no la tiene. Hasta hoy nada en la base lo garantizaba, y
-- las dos combinaciones imposibles ya aparecieron en bases reales:
--   · CLOSED con `endTime` nulo — invisible para `cobroSinTurnoPerteneceAlTurno`, y contado como
--     «turno vivo» por cualquier consulta que sólo mire `endTime`;
--   · OPEN con `endTime` — ocupa el índice único parcial `Shift_venueId_open_key` pero
--     `turnoVivoWhere` no lo ve, así que la siguiente apertura choca y el venue entero responde
--     409 `CASH_SHIFT_ALREADY_OPEN` para siempre (lo cazó `/full-testing` el 5-sep-2026).
-- Las dos las cura `abrirTurnoDeCaja` al abrir, pero curar después no evita el daño de en medio.
-- El CHECK las vuelve imposibles de escribir.
--
-- Escrita A MANO a propósito: la base local es compartida con ~20 sesiones y `migrate dev` puede
-- proponer un reset. Prisma no modela CHECKs, así que `schema.prisma` no cambia (igual que el
-- índice parcial de `20260903030000`).
--
-- 🔴 PREFLIGHT + CHECK EN UN SOLO BLOQUE `DO` = UNA transacción (mismo patrón que
-- `20260903030000_shift_one_open_per_venue`): entre sanear y restringir no puede colarse una
-- escritura que vuelva a producir la anomalía y haga fallar el ALTER.
--
-- Qué hace el preflight, y por qué en esa dirección:
--   · CLOSED sin `endTime`  → `endTime = COALESCE(updatedAt, NOW() AT TIME ZONE 'UTC')`. El
--     `updatedAt` es la última vez que alguien tocó la fila —para un turno que ya está CLOSED, la
--     mejor aproximación de cuándo cerró—; es la misma dirección que `sanarTurnosCerradosSinCierre`,
--     con un instante menos arbitrario que «ahora». No se inventa ningún conteo.
--   · OPEN o CLOSING con `endTime` → `status = CLOSED` conservando ese `endTime` (es el único dato
--     cierto: el turno TERMINÓ). Misma dirección que `sanarTurnosAbiertosConCierre`.
-- Todos los escritores de la app escriben `status` y `endTime` en la MISMA sentencia (verificado
-- el 5-sep-2026: `shift.tpv.service.ts`, `posSyncShift.service.ts`, `turnoDeCaja.ts`), así que el
-- CHECK no puede fallar por un escritor legítimo. El único que producía OPEN + `endTime` era el
-- sync de SoftRestaurant, corregido en el mismo cambio.
--
-- `NOW() AT TIME ZONE 'UTC'` porque las columnas son timestamp sin zona y Prisma escribe UTC.
DO $$
BEGIN
  UPDATE "Shift"
  SET "endTime" = COALESCE("updatedAt", (NOW() AT TIME ZONE 'UTC')),
      "updatedAt" = (NOW() AT TIME ZONE 'UTC')
  WHERE "status" = 'CLOSED' AND "endTime" IS NULL;

  UPDATE "Shift"
  SET "status" = 'CLOSED',
      "updatedAt" = (NOW() AT TIME ZONE 'UTC')
  WHERE "status" IN ('OPEN', 'CLOSING') AND "endTime" IS NOT NULL;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Shift_status_endTime_check') THEN
    ALTER TABLE "Shift"
      ADD CONSTRAINT "Shift_status_endTime_check"
      CHECK (("status" = 'CLOSED') = ("endTime" IS NOT NULL));
  END IF;
END $$;
