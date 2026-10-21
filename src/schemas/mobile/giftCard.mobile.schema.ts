/**
 * Tarjetas de regalo — forma de las peticiones del POS (`/api/v1/mobile`). Los cuerpos NO son estrictos: una app más
 * nueva que el servidor puede mandar campos que éste todavía no conoce (se ignoran). Montos en PESOS, nunca centavos.
 */
import { z } from 'zod'
import { MAX_SOBRES_POR_CUENTA } from '@/services/giftCards/giftCardLimits'
import { PAGE_TOKEN_RE } from '@/services/giftCards/giftCardProof'
import { idempotencyKey, montoPositivo, ordenParams, pesos, pesosPositivos, venueParams } from '../common/giftCard.common.schema'

/** El mismo que valida A5 (`createGiftCardOrder`): 10 a 15 dígitos, con `+` opcional, sin espacios. */
const TELEFONO = /^\+?\d{10,15}$/
const DESTINOS = ['WHATSAPP', 'EMAIL', 'PRINTED', 'HANDED_TO_BUYER'] as const
/** Sin `POS` (C1 del cierre): con `externalId` es la marca de una integrada de SoftRestaurant. Ninguna app la mandaba. */
const FUENTES = ['AVOQADO_ANDROID', 'AVOQADO_IOS', 'TPV'] as const

const texto = (que: string, maximo: number) =>
  z
    .string({ invalid_type_error: `${que} debe ser texto` })
    .trim()
    .min(1, `${que} está vacío`)
    .max(maximo, `${que} no puede pasar de ${maximo} caracteres`)

const codigo = z
  .string({ required_error: 'Falta el código de la tarjeta', invalid_type_error: 'El código de la tarjeta debe ser texto' })
  .trim()
  .min(4, 'El código de la tarjeta está incompleto')
  .max(40, 'El código de la tarjeta es demasiado largo')

/** 1b S2: la liga de la tarjeta (`pageToken`), como la reconoce el escáner (Q12). */
const liga = z
  .string({ invalid_type_error: 'La liga de la tarjeta no es válida' })
  .trim()
  .regex(PAGE_TOKEN_RE, 'La liga de la tarjeta no es válida')

const SOLO_UNO = 'Manda el código o la liga de la tarjeta (sólo uno)'

/**
 * UNA sola unión de pruebas de posesión (A17/D4): la usan `payGiftCardSchema` y, en S2b, `payNewOrderSchema`; S5 le agrega
 * PHONE_OTP una vez.
 */
export const proofSchema = z.discriminatedUnion(
  'kind',
  [z.object({ kind: z.literal('CODE'), code: codigo }), z.object({ kind: z.literal('PAGE_TOKEN'), pageToken: liga })],
  { errorMap: () => ({ message: 'Falta cómo se identificó la tarjeta: código, liga o teléfono' }) },
)

/** Q110: quién EMPEZÓ un reenvío, según el aparato. Sólo nota de bitácora: nunca autor, ni comisión, ni huella. */
const segunElAparato = {
  iniciadoPor: z.string({ invalid_type_error: 'iniciadoPor debe ser texto' }).cuid('iniciadoPor no es un id válido').optional(),
  iniciadoPorNombre: z
    .string({ invalid_type_error: 'iniciadoPorNombre debe ser texto' })
    .trim()
    .max(120, 'iniciadoPorNombre no puede pasar de 120 caracteres')
    .optional(),
}

const sobre = z
  .object({
    amount: montoPositivo('el monto de la tarjeta'),
    deliveryChannel: z.enum(DESTINOS, {
      errorMap: () => ({ message: 'Elige a dónde va la tarjeta: WhatsApp, correo, imprimir o entregar al comprador' }),
    }),
    recipientName: texto('El nombre de quien la recibe', 80).optional(),
    recipientPhone: z.string().trim().regex(TELEFONO, 'El teléfono debe tener 10 dígitos, sin espacios (puedes anteponer +52)').optional(),
    recipientEmail: z
      .string()
      .trim()
      .email('El correo de quien la recibe no es válido')
      .max(120, 'El correo es demasiado largo')
      .optional(),
    message: z.string().trim().max(200, 'El mensaje no puede pasar de 200 caracteres').optional(),
  })
  .superRefine((s, ctx) => {
    if (s.deliveryChannel === 'WHATSAPP' && !s.recipientPhone)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recipientPhone'],
        message: 'Para mandarla por WhatsApp falta el teléfono de quien la recibe',
      })
    if (s.deliveryChannel === 'EMAIL' && !s.recipientEmail)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recipientEmail'],
        message: 'Para mandarla por correo falta el correo de quien la recibe',
      })
  })

/** La entrada de A5 (`CreateGiftCardOrderInput`) tal cual: el servicio vuelve a validar todo con sus propios textos. */
export const createGiftCardOrderSchema = z.object({
  params: venueParams,
  body: z.object({
    idempotencyKey,
    source: z.enum(FUENTES, { errorMap: () => ({ message: 'Origen de la venta no reconocido' }) }).optional(),
    purchaserName: texto('El nombre de quien la compra', 80).optional(),
    purchaserContact: texto('El contacto de quien la compra', 120).optional(),
    sobres: z
      .array(sobre, { required_error: 'Faltan las tarjetas', invalid_type_error: 'Las tarjetas deben ser una lista' })
      .min(1, 'Agrega al menos una tarjeta')
      .max(MAX_SOBRES_POR_CUENTA, `Máximo ${MAX_SOBRES_POR_CUENTA} tarjetas por cuenta`),
  }),
  query: z.any().optional(),
})

/** A3 (cierre): el código va en el CUERPO (`POST …/gift-cards/lookup`), nunca en la URL. 1b S2: o la liga (exactamente uno). */
export const lookupSchema = z.object({
  params: venueParams,
  body: z
    .object({ code: codigo.optional(), pageToken: liga.optional() }, { required_error: SOLO_UNO })
    .passthrough()
    .refine(b => (b.code === undefined) !== (b.pageToken === undefined), SOLO_UNO),
  query: z.any().optional(),
})

export const payGiftCardSchema = z.object({
  params: ordenParams,
  body: z.object({
    idempotencyKey,
    proof: proofSchema,
    amount: pesosPositivos('el monto'),
    tip: pesos('la propina').optional(),
    ...segunElAparato,
  }),
  query: z.any().optional(),
})

/**
 * S2b (Q58): `pay-new-order` — el cuerpo de la venta de mostrador de `POST /orders` (lo valida y lo arma `leerVentaDeMostrador`, por
 * eso `.passthrough()`: los artículos y demás campos de la venta llegan al controller) más el cobro con saldo. `tip` es la propina
 * DEL COBRO en pesos, como en `pay-gift-card`; la propina de la orden en centavos no existe en esta ruta.
 */
export const payNewOrderSchema = z.object({
  params: venueParams,
  body: z
    .object({
      idempotencyKey,
      proof: proofSchema,
      amount: pesosPositivos('el monto'),
      tip: pesos('la propina').optional(),
      ...segunElAparato,
    })
    .passthrough(),
  query: z.any().optional(),
})

export const paymentByKeySchema = z.object({
  params: venueParams.extend({ idempotencyKey }),
  body: z.any().optional(),
  query: z.any().optional(),
})
