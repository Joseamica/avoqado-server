import { z } from 'zod'

export const promotionVenueParamsSchema = z.object({
  venueId: z.string().min(1, 'El establecimiento es requerido'),
})

export const promotionParamsSchema = z.object({
  venueId: z.string().min(1, 'El establecimiento es requerido'),
  promotionId: z.string().min(1, 'La promoción es requerida'),
})

export const getPromotionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  search: z.string().trim().max(120).optional(),
})

const optionBodySchema = z.object({
  productId: z.string().min(1, 'Cada opción necesita un producto'),
  /** Unidades que ENTRAN al carrito. 2 en un 2x1. */
  quantity: z.coerce.number().int().min(1, 'Cada opción entrega al menos una unidad'),
  /** Unidades que se COBRAN. 1 en un 2x1. */
  chargedQuantity: z.coerce.number().int().min(0, 'La cantidad cobrada no puede ser negativa'),
  /** Sobreprecio en PESOS (sólo FIXED_TOTAL). */
  priceDelta: z.coerce
    .number()
    .min(0, 'El sobreprecio no puede ser negativo')
    .max(999999.99, 'El sobreprecio es demasiado grande')
    .refine(v => /^\d+(\.\d{1,2})?$/.test(String(v)), 'El sobreprecio lleva máximo dos decimales')
    .default(0),
})

const groupBodySchema = z.object({
  name: z.string().trim().min(1, 'El grupo necesita un nombre').max(80),
  options: z.array(optionBodySchema).min(1, 'El grupo necesita al menos una opción'),
})

// La vigencia tiene la MISMA forma que Discount (el POS la evalúa con el mismo
// predicado). daysOfWeek: 0=domingo..6=sábado. timeFrom/Until "HH:mm" local del venue.
const scheduleShape = {
  validFrom: z.coerce.date({ invalid_type_error: 'Fecha inválida' }).nullable().optional(),
  validUntil: z.coerce.date({ invalid_type_error: 'Fecha inválida' }).nullable().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  timeFrom: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'La hora debe tener formato HH:mm')
    .nullable()
    .optional(),
  timeUntil: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'La hora debe tener formato HH:mm')
    .nullable()
    .optional(),
}

export const createPromotionBodySchema = z.object({
  name: z.string().trim().min(1, 'La promoción necesita un nombre').max(120),
  description: z.string().trim().max(500).nullable().optional(),
  imageUrl: z.string().url('La imagen debe ser una URL válida').nullable().optional(),
  type: z.enum(['BUNDLE', 'COMBO']),
  pricingMode: z.enum(['FIXED_TOTAL', 'PER_UNIT']),
  /** Precio en PESOS. 0 en PER_UNIT. Tope y 2 decimales: 30M de pesos se
   * volverían 3e9 centavos y desbordan el Int de Prisma; 99.999 se redondearía
   * en silencio. */
  price: z.coerce
    .number()
    .min(0, 'El precio no puede ser negativo')
    .max(999999.99, 'El precio es demasiado grande')
    .refine(v => /^\d+(\.\d{1,2})?$/.test(String(v)), 'El precio lleva máximo dos decimales')
    .default(0),
  groups: z.array(groupBodySchema).min(1, 'La promoción necesita al menos un grupo de productos'),
  displayOrder: z.coerce.number().int().min(0).default(0),
  ...scheduleShape,
})

// El update permite mandar sólo lo que cambió; si vienen groups, REEMPLAZAN a
// los existentes (el editor siempre manda la estructura completa).
export const updatePromotionBodySchema = createPromotionBodySchema.partial()

export type CreatePromotionRequest = z.infer<typeof createPromotionBodySchema>
export type UpdatePromotionRequest = z.infer<typeof updatePromotionBodySchema>
