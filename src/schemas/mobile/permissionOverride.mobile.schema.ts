import { z } from 'zod'

/**
 * PIN de autorización de gerente. El PIN viaja UNA vez por request, sobre TLS,
 * y nunca se guarda en el dispositivo.
 */
export const createPermissionOverrideSchema = z.object({
  params: z.object({
    venueId: z.string().min(1, { message: 'El ID del establecimiento es requerido.' }),
  }),
  body: z.object({
    // 4-10 dígitos: el mismo rango que tpv.schema.ts, invitation.schema.ts y el
    // alta por superadmin. Un rango distinto aquí rechazaría PINs válidos.
    pin: z.string().regex(/^\d{4,10}$/, { message: 'El código debe tener entre 4 y 10 dígitos.' }),
    permission: z
      .string()
      .min(3, { message: 'El permiso es requerido.' })
      .regex(/^[a-z0-9-]+:[a-z0-9_-]+$/i, { message: 'Formato de permiso inválido.' }),
  }),
})
