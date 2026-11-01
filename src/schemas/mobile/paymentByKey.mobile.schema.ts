import { z } from 'zod'

export const cashPaymentByKeyParamsSchema = z.object({
  params: z.object({
    venueId: z
      .string({ required_error: 'El negocio es requerido', invalid_type_error: 'El negocio debe ser un texto' })
      .cuid('El identificador del negocio no es válido'),
    idempotencyKey: z
      .string({ required_error: 'El folio del cobro es requerido', invalid_type_error: 'El folio del cobro debe ser un texto' })
      .max(64, 'El folio del cobro admite hasta 64 caracteres')
      .refine(value => value.trim().length > 0, 'El folio del cobro es requerido'),
  }),
})
