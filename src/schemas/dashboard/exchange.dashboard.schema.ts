import { z } from 'zod'

export const exchangeReviewNoteSchema = z
  .string({ required_error: 'Escribe una nota de revisión', invalid_type_error: 'La nota debe ser texto' })
  .trim()
  .min(3, 'La nota debe tener al menos 3 caracteres')
  .max(500, 'La nota no puede superar 500 caracteres')

const venueParams = z.object({
  venueId: z
    .string({ required_error: 'Indica la sucursal', invalid_type_error: 'La sucursal debe ser texto' })
    .min(1, 'Indica la sucursal'),
})
export const listExchangesSchema = z.object({
  params: venueParams,
  query: z.object({
    pendingReview: z
      .enum(['true', 'false'], { errorMap: () => ({ message: 'Indica true o false para filtrar por revisar' }) })
      .transform(v => v === 'true')
      .optional(),
    limit: z.coerce
      .number({ invalid_type_error: 'El límite debe ser numérico' })
      .int('El límite debe ser entero')
      .positive('El límite debe ser positivo')
      .transform(v => Math.min(v, 100))
      .default(25),
    offset: z.coerce
      .number({ invalid_type_error: 'El desplazamiento debe ser numérico' })
      .int('El desplazamiento debe ser entero')
      .min(0, 'El desplazamiento no puede ser negativo')
      .max(2147483647, 'El desplazamiento es demasiado grande')
      .default(0),
  }),
})

export const reviewExchangeSchema = z.object({
  params: venueParams.extend({
    exchangeId: z.string({ required_error: 'Indica el cambio', invalid_type_error: 'El cambio debe ser texto' }).min(1, 'Indica el cambio'),
  }),
  body: z.object({ note: exchangeReviewNoteSchema }),
})
