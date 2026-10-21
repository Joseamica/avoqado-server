import { z } from 'zod'
import { MAX_CART_LINES, MAX_LINE_QUANTITY, NOTE_MAX_LENGTH } from '@/services/online-ordering/constants'
import { TRACKING_TOKEN_PATTERN } from '@/services/online-ordering/trackingToken'

/* eslint-disable no-control-regex -- 🔴 ESC/POS: el nombre y las notas acaban impresos en la comanda, y un byte de control ahí
   es un COMANDO para la impresora (`ESC p` abre el cajón). Se borran al validar: C0, DEL y C1, siempre escritos como \uXXXX
   (como en `receiptLayout/sanitizeText.ts`). Las notas conservan el salto de línea; el nombre, no. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g
const CONTROL_SALVO_SALTO = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g
/** A9: un id o un slug viajan a una consulta: sin bytes de control (un `\u0000` revienta en Postgres = 500) ni espacios. */
const ID_SEGURO = /^[^\s\u0000-\u001F\u007F-\u009F]+$/
/** A9: además, sin diagonales: un slug es UN segmento de la ruta. */
const SLUG_SEGURO = /^[^\s\u0000-\u001F\u007F-\u009F/\\]+$/
/* eslint-enable no-control-regex */
const sinControl = <T extends z.ZodTypeAny>(re: RegExp, schema: T) =>
  z.preprocess(v => (typeof v === 'string' ? v.replace(re, '') : v), schema)

const note = sinControl(
  CONTROL_SALVO_SALTO,
  z.string().trim().max(NOTE_MAX_LENGTH, `La nota admite hasta ${NOTE_MAX_LENGTH} caracteres`),
).optional()

/**
 * A9: un id de producto, opción, categoría… — hasta 40 caracteres (un cuid son 25, un UUID heredado 36), sin bytes de control ni
 * espacios. Rechazo 400 con el mensaje en español, nunca un 500 de la base. También lo usan los ids de disponibilidad del panel.
 */
export const safeId = (mensaje: string) => z.string().min(1, mensaje).max(40, mensaje).regex(ID_SEGURO, mensaje)

/** A9: el slug de los negocios de la casa (hasta 200 caracteres: los de la casa llegan a 100 más un sufijo de unicidad); se valida ANTES de buscar el negocio. */
export const venueSlug = z.string().min(1, 'Negocio inválido').max(200, 'Negocio inválido').regex(SLUG_SEGURO, 'Negocio inválido')

const slugParams = z.object({ venueSlug })
/** Para la puerta de la API pública: sólo revisa el slug y deja pasar los demás parámetros (p. ej. el token de seguimiento). */
export const venueSlugGateSchema = z.object({ params: slugParams.passthrough() })

const cartItem = z.object({
  productId: safeId('Producto inválido'),
  quantity: z
    .number()
    .int('La cantidad debe ser un número entero')
    .min(1, 'La cantidad mínima es 1')
    .max(MAX_LINE_QUANTITY, `La cantidad máxima por platillo es ${MAX_LINE_QUANTITY}`),
  modifiers: z
    .array(
      z.object({
        modifierId: safeId('Opción inválida'),
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
  note,
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
      name: sinControl(CONTROL, z.string().trim().min(2, 'Escribe tu nombre').max(80, 'Nombre demasiado largo')),
      phone: z.string().trim().min(8, 'Teléfono inválido').max(20, 'Teléfono inválido'),
      email: z.string().trim().email('Correo inválido').max(120, 'Correo demasiado largo').optional(),
    }),
    note,
    whatsappConsent: z.boolean().optional(),
  }),
})

export const trackingSchema = z.object({
  params: slugParams.extend({ trackingToken: z.string().regex(TRACKING_TOKEN_PATTERN, 'Seguimiento inválido') }),
})
