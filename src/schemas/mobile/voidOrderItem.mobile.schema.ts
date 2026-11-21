import { z } from 'zod'

/** «Anular producto» en la mesa del POS: sólo forma. Las guardas de la cuenta las pone el servicio, bajo su candado. */
export const voidOrderItemSchema = z.object({
  params: z.object({
    venueId: z.string().min(1, 'El negocio es requerido'),
    orderId: z.string().min(1, 'La cuenta es requerida'),
    itemId: z.string().min(1, 'El producto es requerido'),
  }),
  body: z.object({
    reason: z
      .string({ required_error: 'Elige el motivo para anular el producto', invalid_type_error: 'El motivo no es válido' })
      .trim()
      .min(1, 'Elige el motivo para anular el producto')
      .max(120, 'El motivo es muy largo'),
    // El POS manda `null` sin versión (kotlinx con `explicitNulls`).
    expectedVersion: z.number().int().nonnegative('La versión no es válida').nullish(),
  }),
})
