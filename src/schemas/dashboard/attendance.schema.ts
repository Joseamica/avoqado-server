import { z } from 'zod'
import { TimeEntryStatus } from '@prisma/client'

/** Fecha en formato YYYY-MM-DD, tal como la manda el selector de rango del dashboard. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe venir como YYYY-MM-DD')

export const VenueTimeEntriesQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  query: z.object({
    staffId: z.string().cuid().optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    status: z.nativeEnum(TimeEntryStatus).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

export const VenueIdOnlySchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
})

export const StaffTimeSummarySchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    staffId: z.string().cuid(),
  }),
  query: z.object({
    startDate: isoDate,
    endDate: isoDate,
  }),
})

export const ValidateTimeEntrySchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    timeEntryId: z.string().cuid(),
  }),
  body: z.object({
    // Sólo aprobar o rechazar: devolver una checada a PENDIENTE es deshacer una decisión
    // ya tomada y necesita su propia acción, no un valor más en esta lista.
    status: z.enum(['APPROVED', 'REJECTED']),
    note: z.string().trim().max(500).optional(),
  }),
})
