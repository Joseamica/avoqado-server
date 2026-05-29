import { z } from 'zod'

/**
 * Schemas for the superadmin TPV-orders endpoints exposed at
 * `/api/v1/dashboard/superadmin/tpv-orders/*`.
 *
 * NOTE: Zod messages are in Spanish — they surface to the user via the
 * `validateRequest` middleware (see src/middlewares/validation.ts).
 */

export const assignSerialsSchema = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          orderItemId: z.string().min(1, 'orderItemId es obligatorio'),
          units: z
            .array(
              z.object({
                name: z.string().min(1, 'El nombre del terminal es obligatorio'),
                serial: z.string().min(1, 'El número de serie es obligatorio'),
              }),
            )
            .min(1, 'Debes asignar al menos una unidad'),
        }),
      )
      .min(1, 'Debes asignar al menos un item'),
  }),
})

export const markShippedSchema = z.object({
  body: z.object({
    trackingNumber: z.string().min(1, 'El número de rastreo es obligatorio'),
    carrier: z.string().min(1, 'La paquetería es obligatoria'),
  }),
})
