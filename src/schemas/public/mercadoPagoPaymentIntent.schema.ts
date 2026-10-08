/**
 * Zod schemas for the public Mercado Pago Brick endpoints.
 *
 * These run on the customer-facing pay.avoqado.io flow — unauthenticated
 * but tied to a specific payment-link shortCode.
 *
 * All messages are in Spanish.
 */
import { z } from 'zod'

/** POST /api/v1/public/payment-links/:shortCode/mp-payment-intent */
export const initRequestSchema = z.object({
  /** Required only for OPEN amount payment links. Ignored for FIXED/ITEM. */
  amount: z.number().positive().optional(),
  /** Optional tip on top of base amount. */
  tipAmount: z.number().nonnegative().optional(),
  /** Pre-fills the Brick payer email field. */
  customerEmail: z.string().email().optional(),
  /** Custom field responses (validated against link.customFields by service). */
  customFieldResponses: z.record(z.string()).optional(),
})

/** Shared Brick submission body for payment-link and venue mp-pay endpoints. */
export const payRequestSchema = z
  .object({
    sessionId: z.string({ required_error: 'Sesión requerida', invalid_type_error: 'Sesión inválida' }).min(1, 'Sesión requerida'),
    token: z.string({ invalid_type_error: 'Token inválido' }).min(1, 'El token de la tarjeta es requerido').optional(),
    paymentMethodId: z
      .string({ required_error: 'El método de pago es requerido', invalid_type_error: 'Método de pago inválido' })
      .min(1, 'El método de pago es requerido'),
    installments: z
      .number({ required_error: 'Las cuotas son requeridas', invalid_type_error: 'Cuotas inválidas' })
      .int('Las cuotas deben ser enteras')
      .positive('Las cuotas deben ser mayores a cero'),
    issuerId: z.string({ invalid_type_error: 'Emisor inválido' }).optional(),
    payer: z.object(
      {
        email: z
          .string({ required_error: 'El correo del pagador es requerido', invalid_type_error: 'Correo inválido' })
          .email('Correo del pagador inválido'),
        firstName: z.string({ invalid_type_error: 'Nombre inválido' }).optional(),
        lastName: z.string({ invalid_type_error: 'Apellido inválido' }).optional(),
        identification: z
          .object(
            {
              type: z.string({ required_error: 'Tipo de identificación requerido', invalid_type_error: 'Tipo de identificación inválido' }),
              number: z.string({
                required_error: 'Número de identificación requerido',
                invalid_type_error: 'Número de identificación inválido',
              }),
            },
            { invalid_type_error: 'Identificación inválida' },
          )
          .optional(),
      },
      { required_error: 'Pagador requerido', invalid_type_error: 'Pagador inválido' },
    ),
  })
  .superRefine((input, ctx) => {
    if (input.paymentMethodId !== 'oxxo' && input.paymentMethodId !== 'clabe' && !input.token) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['token'], message: 'El token de la tarjeta es requerido' })
    }
  })

export const paymentLinkMpPaySchema = z.object({
  params: z.object({ shortCode: z.string().min(1, 'Liga de pago inválida') }),
  body: payRequestSchema,
})

export type InitRequest = z.infer<typeof initRequestSchema>
export type PayRequest = z.infer<typeof payRequestSchema>
