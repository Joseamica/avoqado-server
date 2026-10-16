/**
 * Tarjetas de regalo — forma de las peticiones del dashboard. Cuerpos estrictos (el dashboard se despliega con el
 * servidor). Sólo forma: rangos, topes, plan y saldo viven en los servicios. Los ajustes viajan como NÚMEROS (A5 los
 * valida); el ajuste de gerente, como `Prisma.Decimal` (A4 lo recibe así).
 */
import { GiftCardStatus } from '@prisma/client'
import { z } from 'zod'
import type { EstadoDeListaDeTarjetas } from '@/services/giftCards/giftCardReports.service'
import { CAMPO_DE_MAS, DIA, mayuscula, montoPositivo, operationKey, pesosPositivos, venueParams } from '../common/giftCard.common.schema'

/** Los estados de la base más `EXPIRED` (decisión 1 del coordinador: ACTIVE con `expiresAt` ya pasado). */
const ESTADOS = [...Object.values(GiftCardStatus), 'EXPIRED'] as string[]
const MOTIVOS_DE_GERENTE = ['SUSPICIOUS_ACTIVITY', 'CASHIER_ERROR', 'CUSTOMER_REQUEST', 'LOST_CARD', 'CHARGEBACK', 'OTHER'] as const

const entero = (que: string) =>
  z.coerce
    .number({ invalid_type_error: `${que} debe ser un número` })
    .int(`${que} debe ser un número entero`)
    .min(1, `${que} debe ser 1 o más`)
const dia = (que: string) => z.string({ required_error: `Falta ${que}` }).regex(DIA, `${mayuscula(que)} debe tener la forma AAAA-MM-DD`)
const tarjetaParams = venueParams.extend({ giftCardId: z.string().min(1, 'Falta la tarjeta').max(64, 'La tarjeta no es válida') })

export const updateSettingsSchema = z.object({
  params: venueParams,
  body: z
    .object({
      enabled: z.boolean({ invalid_type_error: 'El interruptor debe ser verdadero o falso' }).optional(),
      suggestedAmounts: z
        .array(montoPositivo('cada monto sugerido'), { invalid_type_error: 'Los montos sugeridos deben ser una lista' })
        .min(1, 'Deja al menos un monto sugerido')
        .max(6, 'Máximo 6 montos sugeridos')
        .optional(),
      minAmount: montoPositivo('el monto mínimo').optional(),
      maxAmount: montoPositivo('el monto máximo').optional(),
      validityMonths: z
        .union([z.literal(12), z.literal(24), z.literal(36), z.literal(60), z.null()], {
          errorMap: () => ({ message: 'La vigencia es sin vencimiento, 12, 24, 36 o 60 meses' }),
        })
        .optional(),
      // A5 (`UpdateGiftCardSettingsInput.aceptaTerminos`): obligatorio en `true` cuando la petición PRENDE la función.
      aceptaTerminos: z.boolean({ invalid_type_error: 'La aceptación de los términos debe ser verdadero o falso' }).optional(),
    })
    .strict(CAMPO_DE_MAS)
    .refine(b => Object.keys(b).length > 0, 'No hay nada que guardar'),
  query: z.any().optional(),
})

const estados = z
  .string()
  .trim()
  .max(80, 'Demasiados estados')
  .transform((s, ctx) => {
    const lista = [
      ...new Set(
        s
          .split(',')
          .map(x => x.trim().toUpperCase())
          .filter(Boolean),
      ),
    ]
    const malos = lista.filter(x => !ESTADOS.includes(x))
    if (malos.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Estado no reconocido: ${malos.join(', ')}` })
      return z.NEVER
    }
    return lista as EstadoDeListaDeTarjetas[]
  })

export const listSchema = z.object({
  params: venueParams,
  query: z.object({
    page: entero('La página').optional(),
    pageSize: entero('El tamaño de página').optional(),
    search: z.string().trim().max(80, 'La búsqueda no puede pasar de 80 caracteres').optional(),
    status: estados.optional(),
  }),
  body: z.any().optional(),
})

export const detailSchema = z.object({
  params: tarjetaParams,
  query: z.object({
    cursor: z.string().trim().max(200, 'El cursor no es válido').optional(),
    limit: entero('El límite').optional(),
  }),
  body: z.any().optional(),
})

const motivo = z.enum(MOTIVOS_DE_GERENTE, { errorMap: () => ({ message: 'Elige un motivo de la lista' }) })
const nota = z.string().trim().max(500, 'La nota no puede pasar de 500 caracteres').optional()
/** Decisión del coordinador (spec § 5.7, «ajustar con motivo y nota»): todo AJUSTE lleva nota, no vacía y de ≤ 500. */
const notaDeAjuste = z
  .string({ required_error: 'Escribe una nota que explique el ajuste', invalid_type_error: 'La nota debe ser texto' })
  .trim()
  .min(1, 'Escribe una nota que explique el ajuste')
  .max(500, 'La nota no puede pasar de 500 caracteres')

const operacion = z
  .discriminatedUnion(
    'tipo',
    [
      z
        .object({
          operationKey,
          tipo: z.literal('AJUSTE'),
          direccion: z.enum(['INCREMENT', 'DECREMENT'], { errorMap: () => ({ message: 'Indica si el ajuste suma o resta' }) }),
          amount: pesosPositivos('el monto del ajuste'),
          reason: motivo,
          note: notaDeAjuste,
        })
        .strict(CAMPO_DE_MAS),
      z.object({ operationKey, tipo: z.literal('BLOQUEAR'), reason: motivo, note: nota }).strict(CAMPO_DE_MAS),
      z.object({ operationKey, tipo: z.literal('DESBLOQUEAR'), reason: motivo, note: nota }).strict(CAMPO_DE_MAS),
      z
        .object({
          operationKey,
          tipo: z.literal('REEMPLAZAR_CODIGO'),
          reason: z.literal('LOST_CARD', { errorMap: () => ({ message: 'Reponer el código sólo se hace por tarjeta perdida' }) }),
          // Spec § 5.7: «con el folio de compra». Decisión del coordinador: folio de compra = `Order.orderNumber` (el número
          // de cuenta que trae el comprobante). El servicio lo compara con el de la venta del sobre.
          folio: z
            .string({ required_error: 'Falta el folio de la compra (número de cuenta)', invalid_type_error: 'El folio debe ser texto' })
            .trim()
            .min(1, 'Falta el folio de la compra (número de cuenta)')
            .max(64, 'El folio no es válido'),
          note: nota,
        })
        .strict(CAMPO_DE_MAS),
    ],
    {
      errorMap: (issue, ctx) =>
        issue.code === z.ZodIssueCode.invalid_union_discriminator
          ? { message: 'Operación no reconocida: AJUSTE, BLOQUEAR, DESBLOQUEAR o REEMPLAZAR_CODIGO' }
          : { message: ctx.defaultError },
    },
  )
  // Decisión del coordinador: con el motivo «Otro», cualquier operación lleva nota (no vacía; el tope de 500 ya lo pone `nota`).
  .refine(o => o.reason !== 'OTHER' || (o.note?.length ?? 0) > 0, { message: 'Con el motivo «Otro» escribe una nota', path: ['note'] })

export const operationSchema = z.object({ params: tarjetaParams, body: operacion, query: z.any().optional() })

export const summarySchema = z.object({
  params: venueParams,
  query: z.object({ from: dia('la fecha inicial'), to: dia('la fecha final') }),
  body: z.any().optional(),
})

export const agingSchema = z.object({
  params: venueParams,
  query: z.object({ at: dia('la fecha de corte') }),
  body: z.any().optional(),
})

export const pendingAccountingSchema = z.object({
  params: venueParams,
  query: z.object({
    from: dia('la fecha inicial'),
    to: dia('la fecha final'),
    page: entero('La página').optional(),
    pageSize: entero('El tamaño de página').optional(),
  }),
  body: z.any().optional(),
})
