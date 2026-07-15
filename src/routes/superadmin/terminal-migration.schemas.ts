import { z } from 'zod'

/**
 * Zod schemas for the TPV venue-migration endpoints.
 *
 * Extracted into their own module so the validation contract can be unit-tested
 * in isolation (no router/controller/Prisma import chain).
 *
 * NOTE on id validation: Terminal/Venue ids are MIXED format in production — most
 * are cuid (`@default(cuid())`), but some legacy/seeded rows have UUID ids
 * (e.g. `f71607dc-cade-402f-8af8-798ce6d1dc66`). A strict `.cuid()` rejected those
 * with a 400 "ID de terminal inválido", making UUID-id terminals impossible to
 * migrate. We validate as a non-empty string instead; the service layer + Prisma
 * reject truly-invalid ids with NotFoundError.
 *
 * Zod messages MUST be in Spanish — the validation middleware shows them raw to users.
 */

export const migratePreflightSchema = z.object({
  params: z.object({ terminalId: z.string().min(1, 'ID de terminal inválido') }),
  body: z.object({
    toVenueId: z.string().min(1, 'Debes seleccionar un venue destino válido'),
    // Si es true, la terminal se lleva su merchant actual al venue destino y el
    // blocker NO_PAYMENT_CONFIG deja de aplicar (la TPV trae con qué cobrar).
    migrateMerchant: z.boolean({ invalid_type_error: 'La opción de migrar el comercio debe ser verdadero o falso' }).optional(),
  }),
})

export const migrateExecuteSchema = z.object({
  params: z.object({ terminalId: z.string().min(1, 'ID de terminal inválido') }),
  body: z.object({
    toVenueId: z.string().min(1, 'Debes seleccionar un venue destino válido'),
    // Optional: assign a specific destination merchant during the migration (set
    // after the re-parent, before the device's post-wipe config fetch). If omitted,
    // the terminal falls back to the destination venue's default VenuePaymentConfig.
    assignedMerchantIds: z.array(z.string()).optional(),
    // Ver migratePreflightSchema.
    migrateMerchant: z.boolean({ invalid_type_error: 'La opción de migrar el comercio debe ser verdadero o falso' }).optional(),
  }),
})

export const migrateStatusSchema = z.object({
  params: z.object({ terminalId: z.string().min(1, 'ID de terminal inválido') }),
  query: z.object({ commandId: z.string().min(1, 'ID de comando inválido') }),
})

export const migrateCancelSchema = z.object({
  params: z.object({ terminalId: z.string().min(1, 'ID de terminal inválido') }),
})
