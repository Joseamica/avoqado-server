import { z } from 'zod'
import { payRequestSchema } from './mercadoPagoPaymentIntent.schema'

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
  params: z.object({ venueSlug: z.string().min(1, 'Venue inválido') }),
  body: payRequestSchema,
})

export const venueCheckoutSessionSchema = z.object({
  params: z.object({
    venueSlug: z.string().min(1),
    sessionId: z.string().min(1),
  }),
})
