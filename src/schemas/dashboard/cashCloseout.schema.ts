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
        required_error: 'El efectivo contado es obligatorio',
        invalid_type_error: 'El efectivo contado debe ser un número',
      })
      .min(0, 'El efectivo contado no puede ser negativo'),
    depositMethod: z.enum(['BANK_DEPOSIT', 'SAFE', 'OWNER_WITHDRAWAL', 'NEXT_SHIFT'], {
      required_error: 'El método de depósito es obligatorio',
      invalid_type_error: 'El método de depósito debe ser depósito bancario, caja fuerte, retiro del dueño o siguiente turno',
    }),
    bankReference: z.string().max(100, 'La referencia bancaria admite hasta 100 caracteres').optional(),
    notes: z.string().max(1000, 'Las notas admiten hasta 1000 caracteres').optional(),
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
