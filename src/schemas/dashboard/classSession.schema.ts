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

export type CreateClassSessionDto = z.infer<typeof createClassSessionSchema>
export type UpdateClassSessionDto = z.infer<typeof updateClassSessionSchema>
export type ListClassSessionsQuery = z.infer<typeof listClassSessionsQuerySchema>
export type AddAttendeeDto = z.infer<typeof addAttendeeSchema>
