import { z } from 'zod'
import { ValidationError } from '../../errors/AppError'
import { WASTE_REASON_CODES } from '../../services/shared/wasteReasons'

/**
 * Contrato de la merma en `/mobile` (spec §4.4). Lo espejan avoqado-android y avoqado-ios.
 *
 * Aquí sólo se valida la FORMA; los topes de cantidad (0.001 – 999 999.999, ≤ 3 decimales), los
 * motivos que ofrece el POS, la nota de «Otro» y el formato estricto del folio los decide
 * `prepareWaste`, que es la misma regla para POS, dashboard y MCP.
 *
 * 🔴 Todos los mensajes van en ESPAÑOL: el 422 los devuelve tal cual (`message` y `details`).
 */

const UUID_MSG = 'El folio (idempotencyKey) debe ser un UUID.'

/**
 * 🔴 `null` = ausente. El POS Android serializa con `encodeDefaults = true`: un opcional que no
 * aplica viaja como `"note": null`. `.optional()` a secas lo rechazaría y TODA merma sin nota
 * moriría con 422 (la familia del reembolso del 11-sep). Se normaliza a `undefined`, que el
 * controlador omite: el servicio nunca ve un `null`, y la huella del folio es la misma con el
 * campo en `null` que sin él.
 */
function nullComoAusente<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullish().transform(value => (value === null ? undefined : value))
}

/**
 * Cantidad: texto decimal ESTRICTO o número JSON.
 *
 * - Texto: sólo dígitos con punto decimal opcional (`2`, `2.5`, `0.001`). Sin signo, espacios,
 *   exponente, separador de miles, `0x`/`0b`/`0o`, `Infinity` ni `NaN`. `new Decimal()` del
 *   servicio acepta hexadecimal, binario, octal y exponencial (`'0x10'` → 16): el contrato del POS
 *   no los permite, así que se cortan aquí.
 * - Número: se acepta porque Swift codifica `Decimal` como número JSON y el POS iOS lo manda así;
 *   exigir texto rompería la app sin ganar nada, porque el servicio ya rechaza cualquier número con
 *   más de 3 decimales (0.1 + 0.2 no pasa) y fuera de rango. Aquí sólo se exige finito y no
 *   negativo.
 *
 * El valor llega intacto al servicio: ni se redondea ni se convierte.
 */
const DECIMAL_ESTRICTO = /^\d+(?:\.\d+)?$/
const CANTIDAD_MSG = 'La cantidad debe ser un número decimal positivo, como 2 o 2.5.'
const quantity = z.union(
  [
    z.string({ invalid_type_error: CANTIDAD_MSG }).max(40, 'La cantidad es demasiado larga.').regex(DECIMAL_ESTRICTO, CANTIDAD_MSG),
    z.number({ invalid_type_error: CANTIDAD_MSG }).finite(CANTIDAD_MSG).nonnegative(CANTIDAD_MSG),
  ],
  { errorMap: () => ({ message: CANTIDAD_MSG }) },
)

export const WasteBodySchema = z
  .object(
    {
      itemType: z.enum(['RAW_MATERIAL', 'PRODUCT'], {
        errorMap: () => ({ message: 'El tipo de artículo debe ser RAW_MATERIAL o PRODUCT.' }),
      }),
      itemId: z
        .string({ required_error: 'Falta el artículo (itemId).', invalid_type_error: 'El artículo (itemId) debe ser texto.' })
        .min(1, 'Falta el artículo (itemId).')
        .max(100, 'El identificador del artículo es demasiado largo.'),
      quantity,
      unit: z
        .string({ required_error: 'Falta la unidad.', invalid_type_error: 'La unidad debe ser texto.' })
        .min(1, 'Falta la unidad.')
        .max(64, 'La unidad es demasiado larga.'),
      reasonCode: z.enum(WASTE_REASON_CODES, { errorMap: () => ({ message: 'El motivo de la merma no es válido.' }) }),
      note: nullComoAusente(z.string({ invalid_type_error: 'La nota debe ser texto.' }).max(280, 'La nota admite hasta 280 caracteres.')),
      idempotencyKey: z.string({ required_error: 'Falta el folio (idempotencyKey).', invalid_type_error: UUID_MSG }).uuid(UUID_MSG),
      clientOccurredAt: nullComoAusente(
        z
          .string({ invalid_type_error: 'La fecha de la merma debe ser texto ISO 8601.' })
          .datetime({ offset: true, message: 'La fecha de la merma debe ser ISO 8601 con zona horaria.' }),
      ),
    },
    {
      required_error: 'Falta el cuerpo de la merma.',
      invalid_type_error: 'El cuerpo de la merma debe ser un objeto JSON.',
    },
  )
  .strict('El cuerpo de la merma trae campos que el contrato no admite.')

export const VoidWasteBodySchema = z
  .object(
    {
      idempotencyKey: z.string({ required_error: 'Falta el folio (idempotencyKey).', invalid_type_error: UUID_MSG }).uuid(UUID_MSG),
    },
    {
      required_error: 'Falta el cuerpo de la anulación.',
      invalid_type_error: 'El cuerpo de la anulación debe ser un objeto JSON.',
    },
  )
  .strict('El cuerpo de la anulación trae campos que el contrato no admite.')

const PAGE_MSG = 'La página debe ser un entero positivo.'
const PAGE_SIZE_MSG = 'El tamaño de página debe ser un entero positivo.'
const FECHA_MSG = 'La fecha debe ser ISO 8601 con hora y zona horaria.'

/**
 * Paginación de los lectores de merma (catálogo del POS y, en el dashboard, la lista de folios).
 * 🔴 Un `pageSize` hostil se RECORTA a 200, nunca se rechaza ni se obedece: el tope lo impone el
 * servidor (el lector vuelve a recortarlo). Parámetros desconocidos se ignoran.
 */
export const WasteQuerySchema = z
  .object({
    page: z.coerce
      .number({ invalid_type_error: PAGE_MSG })
      .int(PAGE_MSG)
      .positive(PAGE_MSG)
      .max(10_000_000, 'La página es demasiado grande.')
      .default(1),
    pageSize: z.coerce
      .number({ invalid_type_error: PAGE_SIZE_MSG })
      .int(PAGE_SIZE_MSG)
      .positive(PAGE_SIZE_MSG)
      .transform(value => Math.min(value, 200))
      .default(100),
    search: z.string({ invalid_type_error: 'La búsqueda debe ser texto.' }).max(200, 'La búsqueda admite hasta 200 caracteres.').optional(),
    startDate: z.string({ invalid_type_error: FECHA_MSG }).datetime({ offset: true, message: FECHA_MSG }).optional(),
    endDate: z.string({ invalid_type_error: FECHA_MSG }).datetime({ offset: true, message: FECHA_MSG }).optional(),
  })
  .refine(value => !value.startDate || !value.endDate || new Date(value.startDate) <= new Date(value.endDate), {
    message: 'El inicio debe ser anterior al final.',
  })

/** Valida y, si falla, lanza el 422 `INVALID_WASTE_PAYLOAD` con los mensajes (en español) a la vista. */
export function parseWasteSchema<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (!result.success) {
    const mensajes = Array.from(new Set(result.error.issues.map(issue => issue.message)))
    throw new ValidationError(`Datos de merma inválidos: ${mensajes.join(' ')}`, 'INVALID_WASTE_PAYLOAD', result.error.flatten())
  }
  return result.data
}
