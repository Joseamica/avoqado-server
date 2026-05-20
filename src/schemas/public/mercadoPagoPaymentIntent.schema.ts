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

/**
 * POST /api/v1/public/payment-links/:shortCode/mp-pay
 *
 * Called by the frontend Brick's onSubmit after card tokenization.
 */
export const payRequestSchema = z.object({
  token: z.string().min(1, 'El token de la tarjeta es requerido'),
  paymentMethodId: z.string().min(1, 'El método de pago es requerido'),
  installments: z.number().int().positive(),
  issuerId: z.string().optional(),
  payer: z.object({
    email: z.string().email('El correo del pagador es requerido'),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    identification: z
      .object({
        type: z.string(),
        number: z.string(),
      })
      .optional(),
  }),
})

export type InitRequest = z.infer<typeof initRequestSchema>
export type PayRequest = z.infer<typeof payRequestSchema>
