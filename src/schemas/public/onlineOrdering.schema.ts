import { z } from 'zod'
import { MAX_CART_LINES, MAX_LINE_QUANTITY, NOTE_MAX_LENGTH } from '@/services/online-ordering/constants'
import { TRACKING_TOKEN_PATTERN } from '@/services/online-ordering/trackingToken'

const slugParams = z.object({ venueSlug: z.string().min(1, 'Negocio inválido') })

const cartItem = z.object({
  productId: z.string().min(1, 'Producto inválido'),
  quantity: z
    .number()
    .int('La cantidad debe ser un número entero')
    .min(1, 'La cantidad mínima es 1')
    .max(MAX_LINE_QUANTITY, `La cantidad máxima por platillo es ${MAX_LINE_QUANTITY}`),
  modifiers: z
    .array(
      z.object({
        modifierId: z.string().min(1, 'Opción inválida'),
        quantity: z
          .number()
          .int('La cantidad debe ser un número entero')
          .min(1, 'La cantidad mínima es 1')
          .max(MAX_LINE_QUANTITY)
          .optional(),
      }),
    )
    .max(30, 'Demasiadas opciones en un platillo')
    .optional(),
  note: z.string().trim().max(NOTE_MAX_LENGTH, `La nota admite hasta ${NOTE_MAX_LENGTH} caracteres`).optional(),
})

const items = z.array(cartItem).min(1, 'Agrega al menos un platillo').max(MAX_CART_LINES, `Máximo ${MAX_CART_LINES} renglones por pedido`)

export const publicVenueSchema = z.object({ params: slugParams })

export const quoteSchema = z.object({ params: slugParams, body: z.object({ items }) })

export const createOrderSchema = z.object({
  params: slugParams,
  body: z.object({
    items,
    paymentMode: z.literal('PAY_AT_PICKUP', { errorMap: () => ({ message: 'Medio de pago no disponible' }) }),
    // R5: el total que el comensal vio y confirmó; si el del servidor difiere, 409 PRICE_CHANGED.
    expectedTotal: z.string().regex(/^\d{1,7}\.\d{2}$/, 'Total inválido: pesos con dos decimales, por ejemplo 206.00'),
    customer: z.object({
      name: z.string().trim().min(2, 'Escribe tu nombre').max(80, 'Nombre demasiado largo'),
      phone: z.string().trim().min(8, 'Teléfono inválido').max(20, 'Teléfono inválido'),
      email: z.string().trim().email('Correo inválido').max(120, 'Correo demasiado largo').optional(),
    }),
    note: z.string().trim().max(NOTE_MAX_LENGTH, `La nota admite hasta ${NOTE_MAX_LENGTH} caracteres`).optional(),
    whatsappConsent: z.boolean().optional(),
  }),
})

export const trackingSchema = z.object({
  params: slugParams.extend({ trackingToken: z.string().regex(TRACKING_TOKEN_PATTERN, 'Seguimiento inválido') }),
})
