import { z } from 'zod'

// ==========================================
// CLASS SESSION SCHEMAS
// ==========================================

export const sessionParamsSchema = z.object({
  venueId: z.string().cuid('Venue ID inválido'),
  sessionId: z.string().cuid('Session ID inválido'),
})

export const createClassSessionSchema = z
  .object({
    productId: z.string().cuid('Product ID inválido'),
    startsAt: z.string().datetime({ message: 'Fecha de inicio inválida' }),
    endsAt: z.string().datetime({ message: 'Fecha de fin inválida' }),
    capacity: z.number().int().min(1, 'La capacidad mínima es 1'),
    assignedStaffId: z.string().cuid('Staff ID inválido').optional().nullable(),
    internalNotes: z.string().max(2000).optional().nullable(),
  })
  .refine(data => new Date(data.startsAt) < new Date(data.endsAt), {
    message: 'La hora de inicio debe ser anterior a la hora de fin',
    path: ['endsAt'],
  })

export const updateClassSessionSchema = z
  .object({
    startsAt: z.string().datetime({ message: 'Fecha de inicio inválida' }).optional(),
    endsAt: z.string().datetime({ message: 'Fecha de fin inválida' }).optional(),
    capacity: z.number().int().min(1, 'La capacidad mínima es 1').optional(),
    assignedStaffId: z.string().cuid('Staff ID inválido').optional().nullable(),
    internalNotes: z.string().max(2000).optional().nullable(),
  })
  .refine(
    data => {
      if (data.startsAt && data.endsAt) return new Date(data.startsAt) < new Date(data.endsAt)
      return true
    },
    { message: 'La hora de inicio debe ser anterior a la hora de fin', path: ['endsAt'] },
  )

export const listClassSessionsQuerySchema = z.object({
  dateFrom: z.coerce.date({ required_error: 'La fecha de inicio es requerida' }),
  dateTo: z.coerce.date({ required_error: 'La fecha de fin es requerida' }),
  productId: z.string().cuid().optional(),
  status: z.enum(['SCHEDULED', 'CANCELLED', 'COMPLETED']).optional(),
})

export const attendeeParamsSchema = z.object({
  venueId: z.string().cuid('Venue ID inválido'),
  sessionId: z.string().cuid('Session ID inválido'),
  reservationId: z.string().cuid('Reservation ID inválido'),
})

export const addAttendeeSchema = z.object({
  guestName: z.string().min(1, 'El nombre es requerido').max(255),
  guestPhone: z.string().min(6, 'Teléfono inválido').optional().nullable(),
  guestEmail: z.string().email('Email inválido').optional().nullable(),
  partySize: z.number().int().min(1).default(1),
  specialRequests: z.string().max(2000).optional().nullable(),
  customerId: z.string().cuid().optional().nullable(),
})

// ---- Bulk (recurring) creation ----
//
// Lets the dashboard create N sessions in one request based on a recurrence rule.
// Server expands the rule, validates each instance, and creates them in a single
// serializable transaction. Conflicting dates are skipped (not failed) so partial
// runs don't leave the calendar half-populated.
export const createClassSessionBulkSchema = z
  .object({
    productId: z.string().cuid('Product ID inválido'),
    /** ISO date (YYYY-MM-DD) in venue timezone — first occurrence */
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)'),
    /** Local time (HH:mm) for every occurrence */
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida (HH:mm)'),
    /** Local time (HH:mm) for every occurrence */
    endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida (HH:mm)'),
    /** Days of week to include (0 = Sunday … 6 = Saturday) — must contain at least one */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Selecciona al menos un día'),
    /** End condition — exactly one of endDate / occurrences */
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)')
      .optional(),
    occurrences: z.number().int().min(1).max(104).optional(),
    capacity: z.number().int().min(1, 'La capacidad mínima es 1'),
    assignedStaffId: z.string().cuid('Staff ID inválido').optional().nullable(),
    internalNotes: z.string().max(2000).optional().nullable(),
  })
  .refine(d => !!d.endDate !== !!d.occurrences, {
    message: 'Especifica endDate o occurrences (no ambos)',
    path: ['endDate'],
  })
  .refine(d => d.startTime < d.endTime, {
    message: 'La hora de fin debe ser posterior a la de inicio',
    path: ['endTime'],
  })

export type CreateClassSessionDto = z.infer<typeof createClassSessionSchema>
export type UpdateClassSessionDto = z.infer<typeof updateClassSessionSchema>
export type ListClassSessionsQuery = z.infer<typeof listClassSessionsQuerySchema>
export type AddAttendeeDto = z.infer<typeof addAttendeeSchema>
export type CreateClassSessionBulkDto = z.infer<typeof createClassSessionBulkSchema>
