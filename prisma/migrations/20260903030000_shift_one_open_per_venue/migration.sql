-- Fase 2 del turno de caja del NEGOCIO (3-sep-2026). Dos cosas, en este orden:
--   1. `CashDrawerSession.shiftId` — la liga 1:1 entre el cajón físico y el turno.
--   2. UN turno abierto por negocio, garantizado en la BASE.
--
-- Escrita A MANO a propósito: la base local es compartida con ~20 sesiones y `migrate dev`
-- puede proponer un reset.

-- ============================================================================
-- 1. La liga cajón ↔ turno
-- ============================================================================
--
-- Hoy el negocio abre DOS cosas cada mañana con DOS fondos distintos: la Caja en la tablet y el
-- Turno en la PAX (Testarudo, 1-sep: caja 07:38 con $2,000, turno 08:12 con $0). Esta columna es
-- lo que permite que cualquiera de los dos gestos LIGUE en vez de duplicar, sin fusionar tablas.
--
-- Todas las filas existentes quedan en NULL: no se adivina la liga hacia atrás. `resolveShiftCashDrawer`
-- las sigue resolviendo por ventana de tiempo, que es lo único honesto con lo histórico.
-- Único (no índice normal) porque la relación es 1:1; Postgres admite varios NULL en un único.
ALTER TABLE "CashDrawerSession" ADD COLUMN IF NOT EXISTS "shiftId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "CashDrawerSession_shiftId_key" ON "CashDrawerSession"("shiftId");

-- `ON DELETE SET NULL`: borrar un turno jamás puede llevarse por delante el arqueo de un cajón
-- (es la única evidencia de cuánto dinero físico había). Es además el default de Prisma para una
-- relación opcional, así que el schema y la base dicen lo mismo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CashDrawerSession_shiftId_fkey') THEN
    ALTER TABLE "CashDrawerSession"
      ADD CONSTRAINT "CashDrawerSession_shiftId_fkey"
      FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ============================================================================
-- 2. UN turno abierto por negocio
-- ============================================================================
--
-- `openShiftForVenue` comprueba con un `findFirst` y CREA después, en operaciones separadas: dos
-- terminales que abren turno a la vez pasan las dos el check antes de que ninguna cree, y el venue
-- queda con DOS turnos OPEN. Eso no es sólo un registro de más — `turnoAbiertoDelNegocio` (el
-- ÚNICO sitio que resuelve a qué turno se ata cada cobro) elige «el más reciente», así que con dos
-- abiertos el dinero del negocio se parte entre ellos según el reloj.
--
-- 🔴 PREFLIGHT + ÍNDICE EN UN SOLO BLOQUE `DO` = UNA transacción, igual que
-- `20260827151634_cash_drawer_one_open_per_venue`: Prisma no garantiza que el archivo entero corra
-- en una transacción, y entre el UPDATE y el CREATE INDEX cabría otra doble apertura.
--
-- 🔴 QUÉ VA A PASAR EN PRODUCCIÓN — medido el 3-sep-2026, no supuesto:
--
--   · 33 turnos `OPEN` en total.
--   · **30 son de un solo venue, `Avoqado Full`**: el preflight cierra 29 y deja vivo el más
--     reciente. Ése es el duplicador, y es el único venue que esta migración toca.
--   · Los otros 3 son el ÚNICO turno abierto de su negocio, así que **el preflight NO los toca**
--     — incluido uno de medio año con **$745,268** acumulados. Un venue con un solo turno abierto
--     no cumple el `EXISTS` de abajo y sale intacto.
--   · **No se mueve ni un cobro.** Sólo cambian `status`, `endTime`, `notes` y `updatedAt` de los
--     29 sobrantes; ninguna fila de `Payment` ni de `Order` se toca.
--
-- (En la base local del 3-sep había 65 turnos OPEN con dos venues de 32 cada uno — datos de
-- semilla; el preflight los dejó en 3 sin inventar un solo conteo.)
--
-- El preflight es DETERMINISTA (sobrevive el más reciente por `startTime`, desempate por `id`) e
-- idempotente. 🔴 Y NO INVENTA UN CONTEO: `endingCash`, `cashDeclared` y `cashDifference` se quedan
-- como estén — normalmente NULL. Escribir un 0 diría «alguien contó y había cero» y le firmaría al
-- cajero un faltante del tamaño de las ventas del día. Es la misma regla dura del auto-cierre de
-- caja (`services/shared/cashDrawerAutoClose.ts`).
--
-- `endTime` sí se escribe: un turno CLOSED con `endTime` NULL sería un estado que ninguna consulta
-- del repo espera (`{ status: 'OPEN', endTime: null }` es el par que usan el claim de cierre y el
-- resolutor de turno). `NOW() AT TIME ZONE 'UTC'` porque las columnas son timestamp sin zona y
-- Prisma escribe UTC.
--
-- Índice único PARCIAL (sólo restringe las OPEN), igual que `CashDrawerSession_venueId_open_key`:
-- un turno en `CLOSING` (cierre en curso) no bloquea, y los CLOSED históricos tampoco.
DO $$
BEGIN
  UPDATE "Shift" s
  SET "status" = 'CLOSED',
      "endTime" = COALESCE(s."endTime", (NOW() AT TIME ZONE 'UTC')),
      "notes" = COALESCE(s."notes" || ' · ', '') || 'Cerrado automáticamente: doble apertura (migración 2026-09-03). Sin conteo.',
      "updatedAt" = (NOW() AT TIME ZONE 'UTC')
  WHERE s."status" = 'OPEN'
    AND EXISTS (
      SELECT 1 FROM "Shift" newer
      WHERE newer."venueId" = s."venueId"
        AND newer."status" = 'OPEN'
        AND (newer."startTime" > s."startTime" OR (newer."startTime" = s."startTime" AND newer."id" > s."id"))
    );
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "Shift_venueId_open_key" ON "Shift"("venueId") WHERE "status" = ''OPEN''';
END $$;
