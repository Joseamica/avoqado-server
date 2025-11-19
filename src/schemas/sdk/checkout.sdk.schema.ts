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
      required_error: 'Amount is required',
      invalid_type_error: 'Amount must be a number',
    })
    .positive('Amount must be greater than 0')
    .finite('Amount must be a finite number'),

  // Currency (optional, defaults to "MXN")
  currency: z.string().optional().default('MXN'),

  // URLs (required, must be valid HTTP/HTTPS URLs)
  successUrl: z
    .string({ required_error: 'successUrl is required' })
    .url('successUrl must be a valid URL')
    .refine(url => url.startsWith('http://') || url.startsWith('https://'), {
      message: 'successUrl must start with http:// or https://',
    }),

  cancelUrl: z
    .string({ required_error: 'cancelUrl is required' })
    .url('cancelUrl must be a valid URL')
    .refine(url => url.startsWith('http://') || url.startsWith('https://'), {
      message: 'cancelUrl must start with http:// or https://',
    }),

  // Optional fields
  description: z.string().optional(),
  customerEmail: z.string().email('Invalid email address').optional(),
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
        message: 'Metadata exceeds maximum size of 16KB',
      },
    ),
})

export type CreateCheckoutSessionInput = z.infer<typeof createCheckoutSessionSchema>
