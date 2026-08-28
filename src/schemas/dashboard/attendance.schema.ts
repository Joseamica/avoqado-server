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

export const PayrollSummarySchema = z.object({
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
    //
    // Un rango con open > close CRUZA LA MEDIANOCHE (22:00–06:00, decisión del founder
    // 2026-08-26) y sólo puede ser el ÚLTIMO del día: corre hacia el día siguiente y
    // cualquier rango posterior quedaría dentro de él.
    for (let i = 0; i < day.ranges.length; i++) {
      const r = day.ranges[i]
      const overnight = r.open > r.close
      if (r.open === r.close)
        ctx.addIssue({ code: 'custom', message: `El rango ${r.open}–${r.close} termina antes de empezar`, path: ['ranges', i] })
      if (overnight && i !== day.ranges.length - 1)
        ctx.addIssue({ code: 'custom', message: 'Un turno que cruza la medianoche debe ser el último rango del día', path: ['ranges', i] })
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
          // Fase 3: por qué no viene. Sólo con OFF — cambiar el horario no es faltar.
          type: z.enum(['REST', 'VACATION', 'PAID_LEAVE', 'UNPAID_LEAVE', 'SICK_LEAVE', 'JUSTIFIED_ABSENCE']).optional().nullable(),
          startTime: hhmm.optional().nullable(),
          endTime: hhmm.optional().nullable(),
          note: z.string().trim().max(200).optional().nullable(),
        }),
      )
      .max(200)
      .default([]),
  }),
})

// ─── Turnos rotativos (fase 1 "como Sesame") ────────────────────────────────────────────
const shiftHhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora inválida (HH:mm)')
const shiftIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)')
const templateBody = z.object({
  name: z.string().trim().min(1).max(40),
  abbreviation: z.string().trim().min(1).max(4),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  startTime: shiftHhmm,
  endTime: shiftHhmm,
  sortOrder: z.number().int().min(0).max(999).optional(),
})
export const WorkShiftTemplatesQuerySchema = z.object({
  params: z.object({ venueId: z.string().cuid() }),
  query: z.object({ includeInactive: z.enum(['true', 'false']).optional() }).optional(),
})
export const CreateWorkShiftTemplateSchema = z.object({ params: z.object({ venueId: z.string().cuid() }), body: templateBody })
export const UpdateWorkShiftTemplateSchema = z.object({
  params: z.object({ venueId: z.string().cuid(), templateId: z.string().cuid() }),
  body: templateBody.partial().extend({ active: z.boolean().optional() }),
})
export const WorkShiftAssignmentsQuerySchema = z.object({
  params: z.object({ venueId: z.string().cuid() }),
  query: z.object({ from: shiftIsoDate, to: shiftIsoDate }),
})
export const ReplaceWorkShiftAssignmentsSchema = z.object({
  params: z.object({ venueId: z.string().cuid() }),
  body: z.object({
    from: shiftIsoDate,
    to: shiftIsoDate,
    items: z.array(z.object({ staffVenueId: z.string().cuid(), date: shiftIsoDate, templateId: z.string().cuid().nullable() })).max(600),
  }),
})
export const PublishWorkShiftAssignmentsSchema = z.object({
  params: z.object({ venueId: z.string().cuid() }),
  body: z.object({
    from: shiftIsoDate,
    to: shiftIsoDate,
    /** Revisión de cada borrador que el gerente tiene enfrente (CAS todo-o-nada; 409 si alguno cambió). */
    drafts: z.array(z.object({ id: z.string().cuid(), updatedAt: z.string().datetime() })).max(600),
  }),
})
