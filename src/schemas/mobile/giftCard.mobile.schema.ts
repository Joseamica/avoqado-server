/**
 * Tarjetas de regalo — forma de las peticiones del POS (`/api/v1/mobile`). Los cuerpos NO son estrictos: una app más
 * nueva que el servidor puede mandar campos que éste todavía no conoce (se ignoran). Montos en PESOS, nunca centavos.
 */
import { z } from 'zod'
import { MAX_SOBRES_POR_CUENTA } from '@/services/giftCards/giftCardLimits'
import { idempotencyKey, montoPositivo, ordenParams, pesos, pesosPositivos, venueParams } from '../common/giftCard.common.schema'

/** El mismo que valida A5 (`createGiftCardOrder`): 10 a 15 dígitos, con `+` opcional, sin espacios. */
const TELEFONO = /^\+?\d{10,15}$/
const DESTINOS = ['WHATSAPP', 'EMAIL', 'PRINTED', 'HANDED_TO_BUYER'] as const
const FUENTES = ['AVOQADO_ANDROID', 'AVOQADO_IOS', 'TPV', 'POS'] as const

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

export const lookupSchema = z.object({
  params: venueParams,
  query: z.object({ code: codigo }).passthrough(),
  body: z.any().optional(),
})

export const payGiftCardSchema = z.object({
  params: ordenParams,
  body: z.object({
    idempotencyKey,
    proof: z.object(
      {
        kind: z.literal('CODE', { errorMap: () => ({ message: 'Por ahora el saldo se cobra con el código de la tarjeta' }) }),
        code: codigo,
      },
      { required_error: 'Falta cómo se identificó la tarjeta', invalid_type_error: 'Falta cómo se identificó la tarjeta' },
    ),
    amount: pesosPositivos('el monto'),
    tip: pesos('la propina').optional(),
  }),
  query: z.any().optional(),
})

export const paymentByKeySchema = z.object({
  params: venueParams.extend({ idempotencyKey }),
  body: z.any().optional(),
  query: z.any().optional(),
})
