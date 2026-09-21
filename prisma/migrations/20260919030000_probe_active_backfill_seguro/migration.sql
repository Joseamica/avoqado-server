-- Rehace el traslado de las marcas ACTIVE con una conversión SEGURA (Codex r4, P2).
--
-- 🔴 La migración anterior filtraba con `~ '^\d{4}-\d{2}-\d{2}T'`, que es un PREFIJO, no una fecha: un valor
-- como `2026-99-99Tbasura` pasaba el filtro, llegaba al `::timestamp` y ABORTABA LA MIGRACIÓN ENTERA. El
-- comentario decía que un valor ilegible «se deja como está»; no era cierto.
--
-- Aquí la conversión va fila a fila dentro de un bloque que atrapa el error: lo convertible se traslada y lo
-- ilegible se queda sin columna — que es el lado seguro, porque el lector trata la marca ilegible del sobre
-- como veto. Idempotente: sólo toca filas con la columna vacía.
--
-- ⚠️ Esta migración NO protege a la anterior: en un despliegue limpio `020000` corre ANTES y, si abortara, ésta
-- no llegaría a ejecutarse. No hace falta: medido el 19-sep, la feature entera está SIN PUSHEAR (ningún commit
-- en `origin/develop`), así que en producción no existe una sola fila con `resultJson.probeActiveAt` — la escribe
-- código que allá nunca ha corrido — y el UPDATE de `020000` alcanza 0 filas. Reescribir `020000` en sitio
-- rompería el checksum de Prisma en `av-db-25`, que es UNA base para todas las sesiones.
DO $$
DECLARE
  fila RECORD;
BEGIN
  FOR fila IN
    SELECT "id", "resultJson"->>'probeActiveAt' AS marca
    FROM "TerminalPaymentRequest"
    WHERE "probeActiveAt" IS NULL AND "resultJson" ? 'probeActiveAt'
  LOOP
    BEGIN
      UPDATE "TerminalPaymentRequest" SET "probeActiveAt" = fila.marca::timestamp WHERE "id" = fila."id";
    EXCEPTION WHEN others THEN
      -- Valor no convertible: se conserva tal cual en el sobre y el lector lo trata como veto.
      NULL;
    END;
  END LOOP;
END $$;
