// schemas/dashboard/testing.schema.ts

import { z } from 'zod'
import { PaymentMethod } from '@prisma/client'

/**
 * Schema for creating a test payment
 * Used for SUPERADMIN testing purposes to quickly create payments with different configurations
 */
export const createTestPaymentSchema = z.object({
  body: z.object({
    venueId: z.string().cuid('El ID del negocio no es válido'),
    amount: z.number().int().positive('El monto debe ser un número entero mayor a cero, en centavos'),
    tipAmount: z.number().int().nonnegative('La propina debe ser un número entero de cero o más, en centavos').default(0),
    method: z.nativeEnum(PaymentMethod, {
      errorMap: () => ({
        message:
          'El método de pago no es válido. Usa efectivo, tarjeta de crédito, tarjeta de débito, cartera digital, transferencia u otro',
      }),
    }),
  }),
})

/**
 * Schema for fetching test payments
 */
export const getTestPaymentsSchema = z.object({
  query: z.object({
    venueId: z.string().cuid('El ID del negocio no es válido').optional(),
    limit: z
      .string()
      .optional()
      .transform(val => (val ? parseInt(val, 10) : 10))
      .refine(val => val > 0 && val <= 100, {
        message: 'El límite debe estar entre 1 y 100',
      }),
  }),
})

/**
 * TypeScript types inferred from schemas
 */
export type CreateTestPaymentInput = z.infer<typeof createTestPaymentSchema>['body']
export type GetTestPaymentsInput = z.infer<typeof getTestPaymentsSchema>['query']
