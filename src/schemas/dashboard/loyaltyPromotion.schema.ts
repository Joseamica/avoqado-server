/**
 * Promociones de lealtad del panel: sólo la FORMA. Los rangos (×2–×10, +1–9 sellos, +1–10,000 puntos), las fechas del negocio, el tope
 * de 10 y «activa = sólo fecha de fin» viven en `loyaltyPromotion.service.ts`, que también usa el MCP.
 */
import { z } from 'zod'

const Entero = (que: string) => z.number({ invalid_type_error: `${que} debe ser un número` }).int(`${que} debe ser un número entero`)
const Fecha = (que: string) =>
  z.string({ invalid_type_error: `${que} debe ser texto` }).regex(/^\d{4}-\d{2}-\d{2}$/, `${que} debe tener formato AAAA-MM-DD`)
const Hora = (que: string) =>
  z.string({ invalid_type_error: `${que} debe ser texto` }).regex(/^\d{2}:\d{2}$/, `${que} debe tener formato HH:mm`)
const Ids = (que: string) =>
  z.array(z.string({ invalid_type_error: `Cada id de ${que} debe ser texto` }), { invalid_type_error: `${que} debe ser una lista` })

const params = z.object({ venueId: z.string().cuid('El ID del negocio no es válido') })
const paramsConId = params.extend({ id: z.string().cuid('El ID de la promoción no es válido') })

const campos = {
  name: z.string({ required_error: 'El nombre es obligatorio', invalid_type_error: 'El nombre debe ser texto' }),
  kind: z.enum(['MULTIPLY', 'ADD'], { errorMap: () => ({ message: 'El tipo debe ser MULTIPLY (multiplica) o ADD (suma)' }) }),
  multiplier: Entero('El multiplicador').nullable().optional(),
  extraStamps: Entero('Los sellos extra').nullable().optional(),
  extraPoints: Entero('Los puntos extra').nullable().optional(),
  startDate: Fecha('La fecha de inicio'),
  endDate: Fecha('La fecha de fin').nullable().optional(),
  daysOfWeek: z.array(Entero('El día de la semana'), { invalid_type_error: 'Los días deben ser una lista' }).optional(),
  timeFrom: Hora('La hora de inicio').nullable().optional(),
  timeUntil: Hora('La hora de fin').nullable().optional(),
  productIds: Ids('productos').optional(),
  categoryIds: Ids('categorías').optional(),
  // Cota de Decimal(12,2) y centavos: sin esto, un monto enorme es un 500 de Prisma y uno de 3 decimales se redondea en silencio.
  // La misma cota está en el servicio (por ahí entra el MCP).
  minSpend: z
    .number({ invalid_type_error: 'El gasto mínimo debe ser un número' })
    .min(0, 'El gasto mínimo no puede ser negativo')
    .max(9_999_999.99, 'El gasto mínimo va hasta $9,999,999.99')
    .refine(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'El gasto mínimo admite hasta 2 decimales')
    .nullable()
    .optional(),
  limit: z
    .enum(['NONE', 'ONCE_PER_DAY', 'ONCE_PER_PROMOTION'], {
      errorMap: () => ({ message: 'El límite por clienta debe ser NONE, ONCE_PER_DAY u ONCE_PER_PROMOTION' }),
    })
    .optional(),
}

export const ListLoyaltyPromotionsSchema = z.object({
  params,
  query: z.object({
    status: z
      .enum(['ACTIVE', 'SCHEDULED', 'ENDED'], { errorMap: () => ({ message: 'El estado debe ser ACTIVE, SCHEDULED o ENDED' }) })
      .optional(),
    page: z.coerce
      .number()
      .int('La página debe ser un número entero')
      .positive('La página empieza en 1')
      .max(10_000, 'La página va hasta 10,000')
      .optional(),
    // Sin máximo aquí: el servicio recorta a 100 (pedir 500 devuelve 100, no un 400).
    pageSize: z.coerce
      .number()
      .int('El tamaño de página debe ser un número entero')
      .positive('El tamaño de página debe ser mayor a 0')
      .optional(),
  }),
})

export const CreateLoyaltyPromotionSchema = z.object({ params, body: z.object(campos) })

/** Programada: cualquier campo (ausente = se queda; `null`/`[]` lo limpia). Activa: sólo `endDate`. */
export const UpdateLoyaltyPromotionSchema = z.object({ params: paramsConId, body: z.object(campos).partial() })

export const LoyaltyPromotionParamsSchema = z.object({ params: paramsConId })
