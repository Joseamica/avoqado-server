import { z } from 'zod'
import { PaymentMethod, PaymentSource } from '@prisma/client'

/**
 * Manual payment creation. All amounts are strings that will be parsed as
 * Decimal. External source is optional free text (≤50 chars) and is ONLY
 * accepted when source = OTHER — enforced by superRefine.
 */
export const createManualPaymentSchema = z.object({
  body: z
    .object({
      /**
       * OPTIONAL. When provided (and non-empty), the payment is attached to
       * an existing order. When omitted OR empty string, the backend creates
       * a shadow Order of type MANUAL_ENTRY to anchor the payment — used for
       * bookkeeping entries that never passed through Avoqado.
       * The transform coerces '' → undefined so FE form state doesn't break.
       */
      orderId: z
        .string()
        .optional()
        .transform(v => (v && v.length > 0 ? v : undefined)),
      /** Waiter to whom tip / commission should be attributed. Optional. */
      waiterId: z
        .string()
        .optional()
        .transform(v => (v && v.length > 0 ? v : undefined)),
      /** Taxes on this manual sale (defaults to 0). Only used for shadow orders. */
      taxAmount: z
        .string()
        .regex(/^\d+(\.\d{1,2})?$/, 'El IVA debe ser un número con máximo 2 decimales')
        .optional(),
      /** Discount applied (defaults to 0). Only used for shadow orders. */
      discountAmount: z
        .string()
        .regex(/^\d+(\.\d{1,2})?$/, 'El descuento debe ser un número con máximo 2 decimales')
        .optional(),
      amount: z
        .string()
        .regex(/^\d+(\.\d{1,2})?$/, 'El monto debe ser un número con máximo 2 decimales')
        .refine(v => parseFloat(v) > 0, 'El monto debe ser mayor a cero'),
      tipAmount: z
        .string()
        .regex(/^\d+(\.\d{1,2})?$/, 'La propina debe ser un número con máximo 2 decimales')
        .optional()
        .default('0'),
      method: z.nativeEnum(PaymentMethod, {
        errorMap: () => ({ message: 'Método de pago inválido' }),
      }),
      source: z.nativeEnum(PaymentSource, {
        errorMap: () => ({ message: 'Origen del pago inválido' }),
      }),
      externalSource: z
        .string()
        .trim()
        .min(1, 'El nombre del proveedor externo no puede estar vacío')
        .max(50, 'El nombre del proveedor externo no puede exceder 50 caracteres')
        .optional(),
      reason: z.string().max(500, 'La razón no puede exceder 500 caracteres').optional(),
    })
    .superRefine((data, ctx) => {
      if (data.source === 'OTHER' && !data.externalSource) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['externalSource'],
          message: 'El nombre del proveedor externo es requerido cuando el origen es OTHER',
        })
      }
      if (data.source !== 'OTHER' && data.externalSource) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['externalSource'],
          message: 'El proveedor externo solo aplica cuando el origen es OTHER',
        })
      }
    }),
})

export const getExternalSourcesSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  }),
})

export type CreateManualPaymentInput = z.infer<typeof createManualPaymentSchema>['body']
