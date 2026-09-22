-- 🔴 Codex r5-7 (22-sep-2026): índice funcional para la búsqueda de dinero por llave NORMALIZADA.
--
-- El veto de la declaración y la consulta S6 comparan `idempotencyKey` con la llave canónica recortada — la misma
-- regla que usa `String.trim()` en la aplicación (`PATRON_SQL_TRIM_COMO_JS`). Ese predicado funcional no puede usar
-- el índice de igualdad exacta, así que para DEMOSTRAR que ningún pago coincide hay que recorrer las llaves; y desde
-- la ventana de confirmación eso corre en el sondeo interactivo cada 5 s, no sólo al declarar.
--
-- `regexp_replace(text, text, text, text)` es IMMUTABLE, así que se puede indexar. El índice sólo cubre las filas
-- con llave (las demás no participan nunca en esta búsqueda).
--
-- ⚠️ EN PRODUCCIÓN, SI "Payment" ES GRANDE: un `CREATE INDEX` normal toma un lock que BLOQUEA las escrituras de la
-- tabla mientras construye. Si eso no es aceptable en la ventana de despliegue, NO se corre esta migración tal cual:
-- se marca como aplicada (`prisma migrate resolve --applied`) y se crea a mano, fuera de transacción, con:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Payment_idempotencyKey_trimmed_idx"
--     ON "Payment" (regexp_replace("idempotencyKey", '^[\t\n\v\f\r    -     　﻿]+|[\t\n\v\f\r    -     　﻿]+$', '', 'g'))
--     WHERE "idempotencyKey" IS NOT NULL;
--
-- (`CONCURRENTLY` no puede ir dentro de una transacción, y Prisma envuelve cada migración en una.)
CREATE INDEX IF NOT EXISTS "Payment_idempotencyKey_trimmed_idx"
  ON "Payment" (regexp_replace("idempotencyKey", '^[\t\n\v\f\r    -     　﻿]+|[\t\n\v\f\r    -     　﻿]+$', '', 'g'))
  WHERE "idempotencyKey" IS NOT NULL;
