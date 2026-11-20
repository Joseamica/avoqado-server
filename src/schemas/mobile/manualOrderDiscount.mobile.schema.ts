import { z } from 'zod'

/**
 * Encargo 7133e3 (hz:0555ee15:D2): el descuento MANUAL de una cuenta de MESAS del POS (ANDROID y WINDOWS), como el de MOSTRADOR.
 * Sólo forma: el tope contra lo que la cuenta debe y las guardas de la cuenta las pone el servicio, bajo su candado.
 */
export const descuentoManualDeMesaSchema = z.object({
  type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT'], {
    errorMap: () => ({ message: 'El descuento manual es por porcentaje o por monto fijo' }),
  }),
  value: z
    .number({ required_error: 'El descuento es requerido', invalid_type_error: 'El descuento debe ser un número' })
    .finite('El descuento debe ser un número')
    .positive('El descuento debe ser mayor a cero'),
  name: z
    .string({ invalid_type_error: 'El nombre del descuento no es válido' })
    .trim()
    .max(80, 'El nombre del descuento es muy largo')
    .nullish(),
  // La llave del envío: la crea el POS al tocar y la repite el reintento y la cola. Obligatoria: sin ella, una respuesta perdida
  // daría el descuento dos veces (D21).
  llave: z
    .string({ required_error: 'La llave del descuento es requerida', invalid_type_error: 'La llave del descuento no es válida' })
    .uuid('La llave del descuento no es válida'),
})

export const manualOrderDiscountSchema = z.object({
  params: z.object({
    venueId: z.string().min(1, 'El negocio es requerido'),
    orderId: z.string().min(1, 'La cuenta es requerida'),
  }),
  body: descuentoManualDeMesaSchema
    .extend({
      // El POS manda `null` cuando no hay motivo (kotlinx con `explicitNulls`): vacío es «Sin motivo», nunca un 400.
      reason: z.string().nullish(),
      reasonComment: z.string().nullish(),
    })
    .refine(b => b.type !== 'PERCENTAGE' || b.value <= 100, {
      message: 'El porcentaje no puede ser mayor a 100',
      path: ['value'],
    }),
})
