// schemas/dashboard/testing.schema.ts

import { z } from 'zod'
import { PaymentMethod } from '@prisma/client'

/**
 * Schema for creating a test payment
 * Used for SUPERADMIN testing purposes to quickly create payments with different configurations
 */
export const createTestPaymentSchema = z.object({
  body: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    amount: z.number().int().positive('Amount must be a positive integer (in cents)'),
    tipAmount: z.number().int().nonnegative('Tip amount must be a non-negative integer (in cents)').default(0),
    method: z.nativeEnum(PaymentMethod, {
      errorMap: () => ({
        message: 'Invalid payment method. Must be one of: CASH, CREDIT_CARD, DEBIT_CARD, DIGITAL_WALLET, BANK_TRANSFER, OTHER',
      }),
    }),
  }),
})

/**
 * Schema for fetching test payments
 */
export const getTestPaymentsSchema = z.object({
  query: z.object({
    venueId: z.string().cuid('Invalid venue ID format').optional(),
    limit: z
      .string()
      .optional()
      .transform(val => (val ? parseInt(val, 10) : 10))
      .refine(val => val > 0 && val <= 100, {
        message: 'Limit must be between 1 and 100',
      }),
  }),
})

/**
 * TypeScript types inferred from schemas
 */
export type CreateTestPaymentInput = z.infer<typeof createTestPaymentSchema>['body']
export type GetTestPaymentsInput = z.infer<typeof getTestPaymentsSchema>['query']
