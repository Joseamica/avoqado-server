/**
 * Codex R13-4 / R14-3 (checkpoint 1 del webhook): el ESTADO BANCARIO de un evento de AngelPay se clasifica EXPLÍCITAMENTE, en un
 * solo sitio y con UNA sola normalización, para el receptor (captura al ingreso), la confirmación por vínculo, el backfill del
 * REST, el rearme por vínculo, el selector de la primera evidencia y S6 (la agregación en SQL).
 *
 *  · APROBADO — cadena legible `approved` (AngelPay manda minúsculas; se toleran mayúsculas y los espacios que quita
 *    `String.prototype.trim`: tabulador, NBSP, BOM, separadores Unicode…).
 *  · RECHAZADO — cadena legible distinta de `approved` (`declined`, …): evidencia de rechazo, nunca MATCHED.
 *  · AUSENTE — el campo NO viene (`undefined`): la única compatibilidad LEGACY, delimitada aparte.
 *  · INVALIDO — el campo viene pero no es legible: `null` presente (Codex R14-3: `{"status": null}` CONTIENE el campo y no
 *    demuestra aprobación), número, objeto, arreglo, booleano, cadena vacía o sólo espacios. NO hay aprobación bancaria
 *    demostrada: la evidencia queda PENDIENTE con motivo `INVALID_STATUS` y no se estampa conciliación afirmativa.
 *
 * Antes, el backfill sólo rechazaba una cadena NO vacía distinta de `approved`: un `status: 123`, `{}` o `""` saltaba el
 * rechazo, llegaba al sello MATCHED y el propio sello guardaba ese estado ilegible; y `null` presente entraba por la
 * excepción de ausencia. La compatibilidad de un campo AUSENTE no justifica aceptar uno PRESENTE e ilegible.
 *
 * SQL: `estadoBancarioSql(expr)` clasifica un valor jsonb con EXACTAMENTE estas reglas — comprueba primero el tipo JSON
 * (`jsonb_typeof`) y recorta con `PATRON_SQL_TRIM_COMO_JS` (la clase de espacios de `trim()`; `btrim` sólo quita el espacio
 * ASCII). Hay una prueba de integración que compara JS y SQL sobre la misma matriz de valores.
 */
import { Prisma } from '@prisma/client'
import { PATRON_SQL_TRIM_COMO_JS } from '../../utils/terminalSerial'

export type EstadoBancario = 'APROBADO' | 'RECHAZADO' | 'AUSENTE' | 'INVALIDO'

export const MOTIVO_ESTADO_INVALIDO = 'INVALID_STATUS'

export function clasificarEstadoBancario(status: unknown): EstadoBancario {
  if (status === undefined) return 'AUSENTE'
  if (typeof status !== 'string') return 'INVALIDO'
  const legible = status.trim().toLowerCase()
  if (!legible) return 'INVALIDO'
  return legible === 'approved' ? 'APROBADO' : 'RECHAZADO'
}

/**
 * La MISMA clasificación, en SQL, sobre una expresión jsonb (p. ej. `e."payload"->'payload'->'status'`): devuelve el texto
 * `APROBADO` · `RECHAZADO` · `AUSENTE` (la expresión es NULL: la llave no existe) · `INVALIDO` (JSON `null`, número, objeto,
 * arreglo, booleano, cadena vacía o sólo espacios). `#>> '{}'` extrae la cadena JSON como texto sin comillas.
 */
export function estadoBancarioSql(expr: Prisma.Sql): Prisma.Sql {
  const recortado = Prisma.sql`lower(regexp_replace(${expr} #>> '{}', ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'))`
  return Prisma.sql`(CASE
    WHEN ${expr} IS NULL THEN 'AUSENTE'
    WHEN jsonb_typeof(${expr}) <> 'string' THEN 'INVALIDO'
    WHEN nullif(${recortado}, '') IS NULL THEN 'INVALIDO'
    WHEN ${recortado} = 'approved' THEN 'APROBADO'
    ELSE 'RECHAZADO'
  END)`
}
