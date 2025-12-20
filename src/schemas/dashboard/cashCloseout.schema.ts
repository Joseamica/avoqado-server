import { z } from 'zod'

/**
 * Validation schemas for cash closeout endpoints
 */

/**
 * Body schema for creating a cash closeout
 */
export const createCloseoutSchema = z.object({
  body: z.object({
    actualAmount: z
      .number({
        required_error: 'actualAmount is required',
        invalid_type_error: 'actualAmount must be a number',
      })
      .min(0, 'actualAmount cannot be negative'),
    depositMethod: z.enum(['BANK_DEPOSIT', 'SAFE', 'OWNER_WITHDRAWAL', 'NEXT_SHIFT'], {
      required_error: 'depositMethod is required',
      invalid_type_error: 'depositMethod must be one of: BANK_DEPOSIT, SAFE, OWNER_WITHDRAWAL, NEXT_SHIFT',
    }),
    bankReference: z.string().max(100, 'bankReference cannot exceed 100 characters').optional(),
    notes: z.string().max(1000, 'notes cannot exceed 1000 characters').optional(),
  }),
})

/**
 * Query schema for listing closeout history
 */
export const closeoutHistoryQuerySchema = z.object({
  query: z
    .object({
      page: z.coerce.number().min(1).default(1).optional(),
      pageSize: z.coerce.number().min(1).max(100).default(10).optional(),
    })
    .optional(),
})
