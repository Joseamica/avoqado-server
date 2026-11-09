/**
 * Checkout Session Schema
 *
 * Zod validation schemas for SDK checkout session creation
 */

import { z } from 'zod'

/**
 * Schema for creating a checkout session
 * Validates URLs, amount, and optional fields
 */
export const createCheckoutSessionSchema = z.object({
  // Amount (required, positive number)
  amount: z
    .number({
      required_error: 'El monto es obligatorio',
      invalid_type_error: 'El monto debe ser un número',
    })
    .positive('El monto debe ser mayor a cero')
    .finite('El monto debe ser un número finito'),

  // Currency (optional, defaults to "MXN")
  currency: z.string().optional().default('MXN'),

  // URLs (required, must be valid HTTP/HTTPS URLs)
  successUrl: z
    .string({ required_error: 'La dirección web de éxito es obligatoria' })
    .url('La dirección web de éxito no es válida')
    .refine(url => url.startsWith('http://') || url.startsWith('https://'), {
      message: 'La dirección web de éxito debe empezar con http:// o https://',
    }),

  cancelUrl: z
    .string({ required_error: 'La dirección web de cancelación es obligatoria' })
    .url('La dirección web de cancelación no es válida')
    .refine(url => url.startsWith('http://') || url.startsWith('https://'), {
      message: 'La dirección web de cancelación debe empezar con http:// o https://',
    }),

  // Optional fields
  description: z.string().optional(),
  customerEmail: z.string().email('El correo no es válido').optional(),
  customerPhone: z.string().optional(),
  customerName: z.string().optional(),
  externalOrderId: z.string().optional(),

  // Metadata (optional, with size limit)
  metadata: z
    .record(z.any())
    .optional()
    .refine(
      data => {
        if (!data) return true
        const size = JSON.stringify(data).length
        return size <= 16 * 1024 // 16KB limit (Stripe pattern)
      },
      {
        message: 'Los metadatos pasan del tamaño máximo de 16 KB',
      },
    ),
})

export type CreateCheckoutSessionInput = z.infer<typeof createCheckoutSessionSchema>
