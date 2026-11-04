import { z } from 'zod'

const OrgParams = z.object({ orgId: z.string().min(1) })

/** POST /:orgId/venue-duplication. El orgId sólo viene de la URL; el cuerpo nunca lo lleva (`.strict()`). */
export const duplicateVenueSchema = z.object({
  params: OrgParams,
  body: z
    .object({
      idempotencyKey: z.string().uuid('La llave de idempotencia debe ser un uuid'),
      templateVenueId: z.string().cuid('Tienda modelo inválida'),
      name: z.string().trim().min(3, 'El nombre debe tener al menos 3 caracteres').max(120, 'El nombre no puede pasar de 120 caracteres'),
      address: z
        .object({
          address: z.string().trim().min(1),
          city: z.string().trim().min(1),
          state: z.string().trim().min(1),
          zipCode: z.string().trim().min(1),
          country: z.string().trim().min(1).optional(),
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
        })
        .strict(),
      supervisorStaffId: z.string().cuid('Supervisor inválido'),
    })
    .strict(),
})

export const venueDuplicationOptionsSchema = z.object({ params: OrgParams })
