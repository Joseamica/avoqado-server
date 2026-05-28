import { z } from 'zod'

/**
 * Request schemas for the public venue-checkout endpoints (embeddable widget).
 * Charges go directly to a venue (by public slug) with a host/customer-provided
 * amount — no payment link involved.
 */

export const venueCheckoutInfoSchema = z.object({
  params: z.object({
    venueSlug: z.string().min(1, 'Venue inválido'),
  }),
})

const amountBody = z.object({
  amount: z.number().positive('El monto debe ser mayor a cero'),
  customerEmail: z.string().email('Correo inválido').optional(),
})

export const venueStripeIntentSchema = z.object({
  params: z.object({ venueSlug: z.string().min(1) }),
  body: amountBody,
})

export const venueMpIntentSchema = z.object({
  params: z.object({ venueSlug: z.string().min(1) }),
  body: amountBody,
})

export const venueMpPaySchema = z.object({
  params: z.object({ venueSlug: z.string().min(1) }),
  body: z.object({
    sessionId: z.string().min(1, 'Sesión requerida'),
    token: z.string().min(1, 'Token requerido'),
    paymentMethodId: z.string().min(1),
    installments: z.number().int().positive(),
    issuerId: z.string().optional(),
    payer: z.object({
      email: z.string().email(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      identification: z
        .object({
          type: z.string(),
          number: z.string(),
        })
        .optional(),
    }),
  }),
})

export const venueCheckoutSessionSchema = z.object({
  params: z.object({
    venueSlug: z.string().min(1),
    sessionId: z.string().min(1),
  }),
})
