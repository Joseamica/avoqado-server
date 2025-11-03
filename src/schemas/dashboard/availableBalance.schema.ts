import { z } from 'zod'
import { TransactionCardType } from '@prisma/client'

/**
 * Validation schemas for Available Balance endpoints
 */

// Params validation
export const venueIdParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
})

// Query validation for date ranges
export const dateRangeQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  query: z.object({
    from: z.string().datetime({ message: 'La fecha "from" debe ser una fecha válida en formato ISO.' }).optional(),
    to: z.string().datetime({ message: 'La fecha "to" debe ser una fecha válida en formato ISO.' }).optional(),
  }),
})

// Query validation for required date ranges (timeline)
export const requiredDateRangeQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  query: z.object({
    from: z
      .string({ required_error: 'La fecha "from" es requerida.' })
      .datetime({ message: 'La fecha "from" debe ser una fecha válida en formato ISO.' }),
    to: z
      .string({ required_error: 'La fecha "to" es requerida.' })
      .datetime({ message: 'La fecha "to" debe ser una fecha válida en formato ISO.' }),
  }),
})

// Simulation request body
export const simulateTransactionSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  body: z.object({
    amount: z.number({ required_error: 'El monto es requerido.' }).positive({ message: 'El monto debe ser un número positivo.' }),
    cardType: z.nativeEnum(TransactionCardType, {
      errorMap: () => ({ message: 'Tipo de tarjeta inválido. Valores permitidos: DEBIT, CREDIT, AMEX, INTERNATIONAL, OTHER.' }),
    }),
    transactionDate: z.string({ required_error: 'La fecha de transacción es requerida.' }).datetime({
      message: 'La fecha de transacción debe ser una fecha válida en formato ISO.',
    }),
    transactionTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'La hora debe estar en formato HH:MM.',
      })
      .optional(),
  }),
})

// Timeline query params (optional date range with flags)
export const timelineQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  query: z.object({
    from: z.string().datetime({ message: 'La fecha "from" debe ser una fecha válida en formato ISO.' }).optional(),
    to: z.string().datetime({ message: 'La fecha "to" debe ser una fecha válida en formato ISO.' }).optional(),
    includePast: z
      .string()
      .transform(val => val === 'true')
      .optional(),
    includeFuture: z
      .string()
      .transform(val => val === 'true')
      .optional(),
  }),
})

// Projection query params
export const balanceProjectionQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  query: z.object({
    days: z
      .string()
      .regex(/^\d+$/, { message: 'Los días deben ser un número entero.' })
      .transform(Number)
      .refine(val => val >= 1 && val <= 30, {
        message: 'Los días de proyección deben estar entre 1 y 30.',
      })
      .optional(),
  }),
})

/**
 * TypeScript types inferred from schemas
 */
export type VenueIdParams = z.infer<typeof venueIdParamsSchema>
export type DateRangeQuery = z.infer<typeof dateRangeQuerySchema>
export type RequiredDateRangeQuery = z.infer<typeof requiredDateRangeQuerySchema>
export type TimelineQuery = z.infer<typeof timelineQuerySchema>
export type SimulateTransaction = z.infer<typeof simulateTransactionSchema>
export type BalanceProjectionQuery = z.infer<typeof balanceProjectionQuerySchema>
