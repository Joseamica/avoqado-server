/**
 * Tarjetas de regalo — forma de las peticiones del POS (`/api/v1/mobile`). Los cuerpos NO son estrictos: una app más
 * nueva que el servidor puede mandar campos que éste todavía no conoce (se ignoran). Montos en PESOS, nunca centavos.
 */
import { z } from 'zod'
import { MAX_SOBRES_POR_CUENTA } from '@/services/giftCards/giftCardLimits'
import { PAGE_TOKEN_RE } from '@/services/giftCards/giftCardProof'
import type { GiftCardErrorCode } from '@/services/giftCards/giftCardErrors'
import {
  idempotencyKey,
  montoPositivo,
  operationKey,
  ordenParams,
  pesos,
  pesosPositivos,
  venueParams,
} from '../common/giftCard.common.schema'

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
/** `validateRequest` lo vuelve el `code` del 400 (`params.code`). */
const CAMPO_NO_ACEPTADO: GiftCardErrorCode = 'GIFT_CARD_NEW_ORDER_FIELD_NOT_ALLOWED'

/** 1b S5: la prueba firmada de `phone/verify` (la valida el servidor al cobrar) y la tarjeta que la caja eligió de su lista. */
const pruebaDeTelefono = z.object({
  kind: z.literal('PHONE_OTP'),
  proofToken: z
    .string({ required_error: 'Falta la verificación por teléfono', invalid_type_error: 'La verificación por teléfono no es válida' })
    .trim()
    .min(1, 'Falta la verificación por teléfono')
    .max(2048, 'La verificación por teléfono no es válida'),
  giftCardId: z
    .string({ required_error: 'Falta la tarjeta', invalid_type_error: 'La tarjeta no es válida' })
    .trim()
    .min(1, 'Falta la tarjeta')
    .max(64, 'La tarjeta no es válida'),
})

/**
 * UNA sola unión de pruebas de posesión (A17/D4): la usan `payGiftCardSchema` y, en S2b, `payNewOrderSchema`; S5 le agregó
 * PHONE_OTP una vez.
 */
export const proofSchema = z.discriminatedUnion(
  'kind',
  [z.object({ kind: z.literal('CODE'), code: codigo }), z.object({ kind: z.literal('PAGE_TOKEN'), pageToken: liga }), pruebaDeTelefono],
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
    // 1b Q110: informativos; el controller los anota en la bitácora y nunca entran en la huella de la venta (Q37).
    ...segunElAparato,
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
 *
 * Mesa, `externalId` e `isOfflineReplay: true` dan 400 `GIFT_CARD_NEW_ORDER_FIELD_NOT_ALLOWED` (revisión S2b): ignorarlos cobraba
 * una venta de mostrador APARTE de la mesa. Ausentes, `null` o `false` pasan. `splitType` se sigue ignorando: el armado de Android
 * manda siempre `"FULLPAYMENT"`, y la venta nunca lo lee.
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
    .passthrough()
    .superRefine((b, ctx) => {
      const noSeAcepta = (campo: string, message: string) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [campo], message, params: { code: CAMPO_NO_ACEPTADO } })
      if (b.tableId != null) noSeAcepta('tableId', 'Las cuentas de mesa se cobran con saldo desde la mesa, no como venta nueva.')
      if (b.externalId != null) noSeAcepta('externalId', 'Esta venta nace con la llave del cobro: no mandes externalId.')
      if (b.isOfflineReplay === true)
        noSeAcepta('isOfflineReplay', 'Una venta guardada sin red no se cobra con saldo de tarjeta: el saldo necesita conexión.')
    }),
  query: z.any().optional(),
})

export const paymentByKeySchema = z.object({
  params: venueParams.extend({ idempotencyKey }),
  body: z.any().optional(),
  query: z.any().optional(),
})

// ─── 1b S4: el detalle de la cuenta, reenviar, cambiar el destino y mostrar el código ───

const tarjetaParams = venueParams.extend({
  giftCardId: z.string().min(1, 'Falta la tarjeta').max(64, 'La tarjeta no es válida'),
})

/** `GET …/gift-cards/orders/:orderId`. */
export const cuentaDeTarjetasSchema = z.object({ params: ordenParams, body: z.any().optional(), query: z.any().optional() })

/**
 * El destino de un reenvío o de un cambio de destino (P-2). Acepta los CUATRO canales para que el servicio responda con su
 * `code` a impresa o en mano (C5); teléfono de 10 dígitos o E.164 (el servidor lo normaliza, Q25).
 */
const destino = {
  deliveryChannel: z.enum(DESTINOS, {
    errorMap: () => ({ message: 'Elige a dónde va la tarjeta: WhatsApp, correo, imprimir o entregar al comprador' }),
  }),
  recipientPhone: z.string().trim().regex(TELEFONO, 'El teléfono debe tener 10 dígitos, sin espacios (puedes anteponer +52)').optional(),
  recipientEmail: z.string().trim().email('El correo no es válido').max(120, 'El correo es demasiado largo').optional(),
}

function conSuContacto(b: { deliveryChannel?: string; recipientPhone?: string; recipientEmail?: string }, ctx: z.RefinementCtx) {
  if (b.deliveryChannel === 'WHATSAPP' && !b.recipientPhone)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipientPhone'], message: 'Para mandarla por WhatsApp falta el teléfono' })
  if (b.deliveryChannel === 'EMAIL' && !b.recipientEmail)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipientEmail'], message: 'Para mandarla por correo falta el correo' })
}

/** `resend`: sin `deliveryChannel` = el mismo destino; con él, debe ser el actual (si no, 400 del servicio). */
export const resendSchema = z.object({
  params: tarjetaParams,
  body: z.object({ operationKey, ...destino, deliveryChannel: destino.deliveryChannel.optional() }).superRefine(conSuContacto),
  query: z.any().optional(),
})

export const changeDestinationSchema = z.object({
  params: tarjetaParams,
  body: z.object({ operationKey, ...destino }).superRefine(conSuContacto),
  query: z.any().optional(),
})

/** `reveal` y `reveal-manager`: reimprimir el certificado o enseñar el QR. */
export const revealSchema = z.object({
  params: tarjetaParams,
  body: z.object({
    operationKey,
    motivo: z.enum(['REPRINT', 'SHOW_QR'], { errorMap: () => ({ message: 'Di para qué se muestra el código: REPRINT o SHOW_QR' }) }),
  }),
  query: z.any().optional(),
})

// ─── 1b S5: teléfono + código (S-2) ───

/**
 * El teléfono como lo escriba la caja; LA forma (Q25) es del servicio. Ausente, `null`, que no sea texto o de más de 32 caracteres
 * (sin los espacios de las orillas) ⇒ el MISMO 400 de C5 que da el servicio (m3 de S5): las apps deciden por `code`, y
 * `validateRequest` sólo toma el `code` de un issue `custom` (como `CAMPO_NO_ACEPTADO`).
 */
const telefonoDelCliente = z.custom<string>(v => typeof v === 'string' && v.trim().length <= 32, {
  message: 'El teléfono no es válido.',
  params: { code: 'GIFT_CARD_PHONE_INVALID' },
})

export const phoneRequestSchema = z.object({
  params: venueParams,
  body: z.object({ phone: telefonoDelCliente }),
  query: z.any().optional(),
})

export const phoneVerifySchema = z.object({
  params: venueParams,
  body: z.object({
    phone: telefonoDelCliente,
    code: z
      .string({ required_error: 'El código son 6 números', invalid_type_error: 'El código son 6 números' })
      .trim()
      .regex(/^\d{6}$/, 'El código son 6 números'),
  }),
  query: z.any().optional(),
})
