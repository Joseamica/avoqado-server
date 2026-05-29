import { z } from 'zod'

/**
 * Public reject body schema for magic-link rejection of a SPEI TerminalOrder.
 * Token validation lives in the controller (query param) — this only validates
 * the JSON body the sales operator submits.
 */
export const rejectSpeiSchema = z.object({
  body: z.object({
    reason: z.string().min(5, 'El motivo debe tener al menos 5 caracteres').max(500, 'El motivo no puede exceder 500 caracteres'),
  }),
})

/**
 * Public assign-serials body schema for the magic-link form sales operators
 * fill in to register the physical PAX terminals against an order. Mirrors
 * the dashboard AssignSerialsInput shape — controller pulls orderId/token
 * from the URL.
 */
export const assignSerialsPublicSchema = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          orderItemId: z.string().min(1, 'orderItemId requerido'),
          units: z
            .array(
              z.object({
                name: z.string().min(1, 'El nombre del terminal es obligatorio'),
                serial: z.string().min(1, 'El número de serie es obligatorio'),
              }),
            )
            .min(1, 'Mínimo una unidad por item'),
        }),
      )
      .min(1, 'Mínimo un item'),
  }),
})
