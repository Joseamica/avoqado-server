-- Traslada las observaciones ACTIVE que la versión anterior escribió dentro de `resultJson` (Codex r3, P1-2).
--
-- 🔴 Sin esto, una fila que YA tenía la marca en el sobre se queda con las columnas en NULL, el lector nuevo
-- devuelve «no hay sonda activa» y la declaración pasa sobre un cobro que la terminal dijo estar ejecutando.
-- Es el defecto exacto que la prueba anterior estaba consolidando al exigir que el formato viejo no vetara.
--
-- Conservador: sólo rellena lo que está vacío y sólo cuando el texto es una fecha válida. Una marca ilegible
-- se deja como está — el lector la trata como veto por el camino de respaldo, que es el lado seguro.
UPDATE "TerminalPaymentRequest"
SET "probeActiveAt" = ("resultJson"->>'probeActiveAt')::timestamp
WHERE "probeActiveAt" IS NULL
  AND "resultJson" ? 'probeActiveAt'
  AND ("resultJson"->>'probeActiveAt') ~ '^\d{4}-\d{2}-\d{2}T';
