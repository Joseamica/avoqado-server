import { z } from 'zod'
import { StaffRole } from '@prisma/client'

/**
 * Zod schemas for the venue staff-access endpoints (grant + candidates).
 *
 * NOTE on id validation: Venue/Staff ids are MIXED format in production — most are
 * cuid, some legacy/seeded rows are UUID. A strict `.cuid()` rejected those (see
 * terminal-migration.schemas.ts). We validate as non-empty strings; the service
 * layer + Prisma reject truly-invalid ids.
 *
 * Zod messages MUST be in Spanish — the validation middleware shows them raw.
 */

const id = (msg: string) => z.string().min(1, msg)

export const grantVenueAccessSchema = z.object({
  params: z.object({ venueId: id('ID de sucursal inválido') }),
  body: z.object({
    grants: z
      .array(
        z.object({
          staffId: id('ID de usuario inválido'),
          role: z.nativeEnum(StaffRole, { errorMap: () => ({ message: 'Rol inválido' }) }),
          pin: z
            .string()
            .regex(/^\d{4,6}$/, 'El PIN debe ser de 4 a 6 dígitos')
            .optional(),
        }),
      )
      .min(1, 'Selecciona al menos una persona'),
  }),
})

export const listCandidatesSchema = z.object({
  params: z.object({ venueId: id('ID de sucursal inválido') }),
  query: z.object({ sourceVenueId: z.string().min(1).optional() }),
})
