import { DateTime } from 'luxon'
import { z } from 'zod'
import { TimeEntryStatus } from '@prisma/client'

/** Fecha en formato YYYY-MM-DD, tal como la manda el selector de rango del dashboard. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe venir como YYYY-MM-DD')
  // El regex sólo mira la FORMA: `2026-13-40` pasaba y se guardaba tal cual (columna de texto).
  // Luxon rechaza mes 13 y día 40 (auditoría Codex fase 2, hallazgo 3).
  .refine(value => DateTime.fromISO(value).isValid, 'Esa fecha no existe en el calendario')

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

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'La hora debe venir como HH:mm')

export const AttendanceReportSchema = z.object({
  params: z.object({ venueId: z.string().cuid() }),
  query: z.object({ startDate: isoDate, endDate: isoDate }),
})

export const WorkScheduleParamsSchema = z.object({
  params: z.object({ venueId: z.string().cuid(), staffVenueId: z.string().cuid() }),
})

const DayScheduleSchema = z
  .object({
    enabled: z.boolean(),
    ranges: z.array(z.object({ open: hhmm, close: hhmm })).max(4),
  })
  .superRefine((day, ctx) => {
    // El resolvedor toma el PRIMER y el ÚLTIMO rango tal cual llegan. Fuera de orden,
    // "[16-20, 9-14]" se leía como entrada 16:00 y salida 14:00 del día siguiente
    // (auditoría Codex, P2). Se exige orden y sin solapes; abrir==cerrar tampoco vale.
    for (let i = 0; i < day.ranges.length; i++) {
      const r = day.ranges[i]
      if (r.open >= r.close)
        ctx.addIssue({ code: 'custom', message: `El rango ${r.open}–${r.close} termina antes de empezar`, path: ['ranges', i] })
      if (i > 0 && day.ranges[i - 1].close > r.open)
        ctx.addIssue({ code: 'custom', message: 'Los rangos deben ir en orden y sin traslaparse', path: ['ranges', i] })
    }
  })

export const ReplaceWorkScheduleSchema = z.object({
  params: z.object({ venueId: z.string().cuid(), staffVenueId: z.string().cuid() }),
  body: z.object({
    weekly: z
      .object({
        monday: DayScheduleSchema,
        tuesday: DayScheduleSchema,
        wednesday: DayScheduleSchema,
        thursday: DayScheduleSchema,
        friday: DayScheduleSchema,
        saturday: DayScheduleSchema,
        sunday: DayScheduleSchema,
      })
      .nullable(),
    exceptions: z
      .array(
        z.object({
          startDate: isoDate,
          endDate: isoDate,
          kind: z.enum(['OFF', 'HOURS']),
          startTime: hhmm.optional().nullable(),
          endTime: hhmm.optional().nullable(),
          note: z.string().trim().max(200).optional().nullable(),
        }),
      )
      .max(200)
      .default([]),
  }),
})
