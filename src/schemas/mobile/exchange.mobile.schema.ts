import { z } from 'zod'

const textSchema = z.string({ required_error: 'Este dato es requerido.', invalid_type_error: 'Debe ser texto.' })
const id = textSchema.cuid('El identificador no es válido.')
const integerSchema = z
  .number({ required_error: 'Este número es requerido.', invalid_type_error: 'Debe ser un número.' })
  .int('Debe ser un número entero.')
  .safe('Debe ser un entero seguro.')
const quantitySchema = integerSchema.min(1, 'La cantidad mínima es 1.').max(999, 'La cantidad máxima es 999.')
const booleanSchema = z.boolean({ required_error: 'Este dato es requerido.', invalid_type_error: 'Debe ser verdadero o falso.' })
const dateTimeSchema = textSchema.datetime({ offset: true, message: 'La fecha debe ser ISO 8601 con zona horaria.' })
const enumOptions = { errorMap: () => ({ message: 'Elige una de las opciones permitidas.' }) }
const objectOptions = { required_error: 'Este dato es requerido.', invalid_type_error: 'Debe ser un objeto.' }

export const exchangeIdParamsSchema = z.object({ params: z.object({ venueId: id, exchangeId: id }) })

export const createExchangeSchema = z.object({
  params: z.object({ venueId: id }),
  query: z.object({}),
  body: z
    .object(
      {
        idempotencyKey: textSchema.regex(
          /^[A-Za-z0-9_-]{8,64}$/,
          'La llave debe tener de 8 a 64 letras, números, guiones o guiones bajos.',
        ),
        originalPaymentId: id,
        returned: z
          .array(
            z.object(
              {
                orderItemId: id,
                quantity: quantitySchema,
                restock: booleanSchema,
                reason: z.enum(['SIZE', 'TASTE', 'DEFECT'], enumOptions),
              },
              objectOptions,
            ),
            { required_error: 'Incluye los artículos que se devuelven.', invalid_type_error: 'Debe ser una lista de artículos.' },
          )
          .min(1, 'Incluye al menos un artículo que se devuelve.')
          .max(100, 'Sólo se permiten hasta 100 artículos por cambio.'),
        taken: z
          .array(
            z.object(
              {
                productId: id,
                quantity: quantitySchema,
                inheritsFromOrderItemId: id.nullish(),
                displayedUnitPriceCents: integerSchema.nonnegative('El precio no puede ser negativo.').optional(),
                catalogAt: dateTimeSchema.optional(),
              },
              objectOptions,
            ),
            { required_error: 'Incluye los artículos que se lleva.', invalid_type_error: 'Debe ser una lista de artículos.' },
          )
          .min(1, 'Incluye al menos un artículo que se lleva.')
          .max(100, 'Sólo se permiten hasta 100 artículos por cambio.'),
        staffId: id,
        deviceId: textSchema.min(1, 'El aparato es requerido.').max(128, 'El identificador del aparato no puede exceder 128 caracteres.'),
        createdAtLocal: dateTimeSchema,
        isOfflineReplay: booleanSchema.optional(),
        settlement: z.object(
          {
            kind: z.enum(['EVEN', 'COLLECT', 'PAYOUT'], enumOptions),
            method: z.enum(['CASH', 'CARD_TERMINAL', 'BANK_TRANSFER', 'GIFT_CARD_BALANCE', 'TENDER'], enumOptions).nullable(),
            expectedDifferenceCents: integerSchema,
            cashDrawerSessionId: id.nullish(),
            terminalId: id.nullish(),
            tenderTypeId: id.nullish(),
            tenderRevision: integerSchema.nonnegative('La versión del tipo de pago no puede ser negativa.').nullish(),
            cashFromNonCash: booleanSchema.optional(),
          },
          { required_error: 'Falta la liquidación del cambio.', invalid_type_error: 'La liquidación del cambio no es válida.' },
        ),
      },
      objectOptions,
    )
    .superRefine((body, ctx) => {
      const seen = new Set<string>()
      for (const [index, line] of body.returned.entries()) {
        if (seen.has(line.orderItemId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['returned', index, 'orderItemId'],
            message: 'Un artículo está repetido en la devolución; junta su cantidad en un solo renglón.',
            params: { code: 'EXCHANGE_DUPLICATE_LINE' },
          })
        }
        seen.add(line.orderItemId)
      }
      const { kind, method, expectedDifferenceCents, tenderTypeId, tenderRevision, cashFromNonCash } = body.settlement
      if (body.isOfflineReplay && method !== 'CARD_TERMINAL') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['isOfflineReplay'],
          message: 'El cambio sin red se envía por la cola de sincronización.',
        })
      }
      if (
        (kind === 'EVEN' && (expectedDifferenceCents !== 0 || method !== null)) ||
        (kind === 'COLLECT' && (expectedDifferenceCents <= 0 || method === null)) ||
        (kind === 'PAYOUT' && (expectedDifferenceCents >= 0 || method === null || method === 'TENDER'))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['settlement'],
          message: 'El tipo, el medio y la diferencia del cambio no coinciden.',
        })
      }
      if (
        (method === 'TENDER') !== (tenderTypeId != null && tenderRevision != null) ||
        (method !== 'TENDER' && (tenderTypeId != null || tenderRevision != null))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['settlement'],
          message: 'El tipo de pago personalizado requiere su identificador y versión, y sólo se usa con TENDER.',
        })
      }
      if (cashFromNonCash !== undefined && (kind !== 'PAYOUT' || method !== 'CASH')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['settlement', 'cashFromNonCash'],
          message: 'Devolver efectivo de otro medio sólo se permite en una devolución en efectivo.',
        })
      }
    }),
})
