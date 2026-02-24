import { z } from 'zod'

// ==========================================
// RESERVATION SCHEMAS — Zod validation (Spanish messages)
// ==========================================

// Time format HH:MM (00:00 - 23:59)
const timeStringSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Formato de hora invalido (HH:MM)')

const timeRangeSchema = z
  .object({
    open: timeStringSchema,
    close: timeStringSchema,
  })
  .refine(data => data.close > data.open, {
    message: 'La hora de cierre debe ser posterior a la hora de apertura',
  })

const dayScheduleSchema = z.object({
  enabled: z.boolean(),
  ranges: z.array(timeRangeSchema).max(3, 'Maximo 3 rangos por dia'),
})

export const operatingHoursSchema = z
  .object({
    monday: dayScheduleSchema,
    tuesday: dayScheduleSchema,
    wednesday: dayScheduleSchema,
    thursday: dayScheduleSchema,
    friday: dayScheduleSchema,
    saturday: dayScheduleSchema,
    sunday: dayScheduleSchema,
  })
  .optional()

// Shared enums
export const ReservationStatusSchema = z.enum(['PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])

export const ReservationChannelSchema = z.enum(['DASHBOARD', 'WEB', 'PHONE', 'WHATSAPP', 'APP', 'WALK_IN', 'THIRD_PARTY'])
const depositModeSchema = z.enum(['none', 'card_hold', 'deposit', 'prepaid'])
const waitlistPriorityModeSchema = z.enum(['fifo', 'party_size', 'broadcast'])

// ---- Query Schemas ----

export const getReservationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  status: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return undefined
      const values = val.includes(',') ? val.split(',') : [val]
      const valid = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW']
      for (const v of values) {
        if (!valid.includes(v)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Estado invalido: ${v}` })
          return z.NEVER
        }
      }
      return values.length === 1 ? values[0] : values
    }),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  tableId: z.string().optional(),
  staffId: z.string().optional(),
  productId: z.string().optional(),
  channel: ReservationChannelSchema.optional(),
  search: z.string().optional(),
})

export const getAvailabilityQuerySchema = z.object({
  date: z.string({ required_error: 'La fecha es requerida' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha invalido (YYYY-MM-DD)'),
  duration: z.coerce.number().int().min(5).max(480).optional(),
  partySize: z.coerce.number().int().min(1).max(100).optional(),
  tableId: z.string().optional(),
  staffId: z.string().optional(),
  productId: z.string().optional(),
})

export const getWaitlistQuerySchema = z.object({
  status: z.enum(['WAITING', 'NOTIFIED', 'PROMOTED', 'EXPIRED', 'CANCELLED']).optional(),
})

export const getStatsQuerySchema = z.object({
  dateFrom: z.coerce.date({ required_error: 'La fecha de inicio es requerida' }),
  dateTo: z.coerce.date({ required_error: 'La fecha de fin es requerida' }),
})

export const getCalendarQuerySchema = z.object({
  dateFrom: z.coerce.date({ required_error: 'La fecha de inicio es requerida' }),
  dateTo: z.coerce.date({ required_error: 'La fecha de fin es requerida' }),
  groupBy: z.enum(['table', 'staff']).optional(),
})

// ---- Body Schemas ----

export const createReservationBodySchema = z
  .object({
    startsAt: z.coerce.date({ required_error: 'La fecha de inicio es requerida' }),
    endsAt: z.coerce.date({ required_error: 'La fecha de fin es requerida' }),
    duration: z.number().int().min(5, 'La duracion minima es 5 minutos').max(480, 'La duracion maxima es 8 horas'),
    channel: ReservationChannelSchema.optional(),
    customerId: z.string().optional(),
    guestName: z.string().min(1, 'El nombre del cliente es requerido').max(200).optional(),
    guestPhone: z.string().max(20).optional(),
    guestEmail: z.string().email('Email invalido').max(200).optional(),
    partySize: z.number().int().min(1, 'Minimo 1 persona').max(100, 'Maximo 100 personas').optional(),
    tableId: z.string().optional(),
    productId: z.string().optional(),
    assignedStaffId: z.string().optional(),
    specialRequests: z.string().max(2000).optional(),
    internalNotes: z.string().max(2000).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
  })
  .refine(data => data.endsAt > data.startsAt, {
    message: 'La fecha de fin debe ser posterior a la fecha de inicio',
    path: ['endsAt'],
  })
  .refine(
    data => {
      const diffMin = Math.round((data.endsAt.getTime() - data.startsAt.getTime()) / 60000)
      return Math.abs(diffMin - data.duration) <= 1 // 1-min rounding tolerance
    },
    {
      message: 'La duracion no coincide con el rango de fechas',
      path: ['duration'],
    },
  )

export const updateReservationBodySchema = z
  .object({
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    duration: z.number().int().min(5).max(480).optional(),
    guestName: z.string().max(200).optional(),
    guestPhone: z.string().max(20).optional(),
    guestEmail: z.string().email('Email invalido').max(200).optional().nullable(),
    partySize: z.number().int().min(1).max(100).optional(),
    tableId: z.string().optional().nullable(),
    productId: z.string().optional().nullable(),
    assignedStaffId: z.string().optional().nullable(),
    specialRequests: z.string().max(2000).optional().nullable(),
    internalNotes: z.string().max(2000).optional().nullable(),
    tags: z.array(z.string().max(50)).max(20).optional(),
  })
  .refine(data => !data.startsAt || !data.endsAt || data.endsAt > data.startsAt, {
    message: 'La fecha de fin debe ser posterior a la fecha de inicio',
    path: ['endsAt'],
  })
  .refine(
    data => {
      if (!data.duration || !data.startsAt || !data.endsAt) return true
      const diffMin = Math.round((data.endsAt.getTime() - data.startsAt.getTime()) / 60000)
      return Math.abs(diffMin - data.duration) <= 1
    },
    {
      message: 'La duracion no coincide con el rango de fechas',
      path: ['duration'],
    },
  )

export const rescheduleBodySchema = z
  .object({
    startsAt: z.coerce.date({ required_error: 'La nueva fecha de inicio es requerida' }),
    endsAt: z.coerce.date({ required_error: 'La nueva fecha de fin es requerida' }),
  })
  .refine(data => data.endsAt > data.startsAt, {
    message: 'La fecha de fin debe ser posterior a la fecha de inicio',
    path: ['endsAt'],
  })

export const cancelBodySchema = z.object({
  reason: z.string().max(1000).optional(),
})

export const addToWaitlistBodySchema = z
  .object({
    customerId: z.string().optional(),
    guestName: z.string().min(1, 'El nombre del cliente es requerido').max(200).optional(),
    guestPhone: z.string().max(20).optional(),
    partySize: z.number().int().min(1).max(100).optional(),
    desiredStartAt: z.coerce.date({ required_error: 'La hora deseada es requerida' }),
    desiredEndAt: z.coerce.date().optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine(data => Boolean(data.customerId || data.guestName), {
    message: 'Debes proporcionar customerId o guestName',
    path: ['guestName'],
  })

export const promoteWaitlistBodySchema = z.object({
  reservationId: z.string().min(1, 'reservationId es requerido'),
})

export const updateReservationSettingsBodySchema = z
  .object({
    // Flat payload support
    slotIntervalMin: z.number().int().min(5).max(480).optional(),
    defaultDurationMin: z.number().int().min(5).max(480).optional(),
    autoConfirm: z.boolean().optional(),
    maxAdvanceDays: z.number().int().min(0).max(365).optional(),
    minNoticeMin: z.number().int().min(0).max(10080).optional(),
    noShowGraceMin: z.number().int().min(0).max(240).optional(),
    pacingMaxPerSlot: z.number().int().min(1).max(1000).nullable().optional(),
    onlineCapacityPercent: z.number().int().min(1).max(100).optional(),
    depositMode: depositModeSchema.optional(),
    depositFixedAmount: z.number().min(0).nullable().optional(),
    depositPercentage: z.number().int().min(0).max(100).nullable().optional(),
    depositPartySizeGte: z.number().int().min(1).max(1000).nullable().optional(),
    depositPaymentWindow: z.number().int().min(1).max(168).nullable().optional(),
    waitlistEnabled: z.boolean().optional(),
    waitlistMaxSize: z.number().int().min(1).max(5000).optional(),
    waitlistPriorityMode: waitlistPriorityModeSchema.optional(),
    waitlistNotifyWindow: z.number().int().min(1).max(1440).optional(),
    publicBookingEnabled: z.boolean().optional(),
    requirePhone: z.boolean().optional(),
    requireEmail: z.boolean().optional(),
    allowCustomerCancel: z.boolean().optional(),
    minHoursBeforeCancel: z.number().int().min(0).max(720).nullable().optional(),
    minHoursBeforeStart: z.number().int().min(0).max(720).nullable().optional(),
    forfeitDeposit: z.boolean().optional(),
    noShowFeePercent: z.number().int().min(0).max(100).nullable().optional(),
    remindersEnabled: z.boolean().optional(),
    reminderChannels: z.array(z.string().min(1).max(50)).max(10).optional(),
    reminderMinBefore: z.array(z.number().int().min(1).max(10080)).max(10).optional(),
    operatingHours: operatingHoursSchema,

    // Nested payload support
    scheduling: z
      .object({
        slotIntervalMin: z.number().int().min(5).max(480).optional(),
        defaultDurationMin: z.number().int().min(5).max(480).optional(),
        autoConfirm: z.boolean().optional(),
        maxAdvanceDays: z.number().int().min(0).max(365).optional(),
        minNoticeMin: z.number().int().min(0).max(10080).optional(),
        noShowGraceMin: z.number().int().min(0).max(240).optional(),
        pacingMaxPerSlot: z.number().int().min(1).max(1000).nullable().optional(),
        onlineCapacityPercent: z.number().int().min(1).max(100).optional(),
      })
      .optional(),
    deposits: z
      .object({
        mode: depositModeSchema.optional(),
        percentageOfTotal: z.number().int().min(0).max(100).nullable().optional(),
        fixedAmount: z.number().min(0).nullable().optional(),
        requiredForPartySizeGte: z.number().int().min(1).max(1000).nullable().optional(),
        paymentWindowHrs: z.number().int().min(1).max(168).nullable().optional(),
      })
      .optional(),
    cancellation: z
      .object({
        allowCustomerCancel: z.boolean().optional(),
        minHoursBeforeStart: z.number().int().min(0).max(720).nullable().optional(),
        forfeitDeposit: z.boolean().optional(),
        noShowFeePercent: z.number().int().min(0).max(100).nullable().optional(),
      })
      .optional(),
    waitlist: z
      .object({
        enabled: z.boolean().optional(),
        maxSize: z.number().int().min(1).max(5000).optional(),
        priorityMode: waitlistPriorityModeSchema.optional(),
        notifyWindowMin: z.number().int().min(1).max(1440).optional(),
      })
      .optional(),
    reminders: z
      .object({
        enabled: z.boolean().optional(),
        channels: z.array(z.string().min(1).max(50)).max(10).optional(),
        minutesBefore: z.array(z.number().int().min(1).max(10080)).max(10).optional(),
      })
      .optional(),
    publicBooking: z
      .object({
        enabled: z.boolean().optional(),
        requirePhone: z.boolean().optional(),
        requireEmail: z.boolean().optional(),
      })
      .optional(),
  })
  .refine(data => Object.keys(data).length > 0, {
    message: 'Se requiere al menos un campo para actualizar configuracion',
  })

// ---- Public Booking ----

export const publicCreateReservationBodySchema = z
  .object({
    startsAt: z.coerce.date({ required_error: 'La fecha de inicio es requerida' }).optional(),
    endsAt: z.coerce.date({ required_error: 'La fecha de fin es requerida' }).optional(),
    duration: z.number().int().min(5).max(480).optional(),
    guestName: z.string().min(1, 'El nombre es requerido').max(200),
    guestPhone: z.string().min(1, 'El telefono es requerido').max(20),
    guestEmail: z.string().email('Email invalido').max(200).optional(),
    partySize: z.number().int().min(1).max(100).optional(),
    productId: z.string().optional(),
    classSessionId: z.string().optional(),
    specialRequests: z.string().max(2000).optional(),
  })
  .refine(
    data => {
      // CLASS bookings get times from the session — startsAt/endsAt/duration not required
      if (data.classSessionId) return true
      return data.startsAt != null && data.endsAt != null && data.duration != null
    },
    {
      message: 'startsAt, endsAt y duration son requeridos para reservaciones sin classSessionId',
      path: ['startsAt'],
    },
  )
  .refine(
    data => {
      if (data.classSessionId) return true
      if (!data.startsAt || !data.endsAt) return true // validated above
      return data.endsAt > data.startsAt
    },
    {
      message: 'La fecha de fin debe ser posterior a la fecha de inicio',
      path: ['endsAt'],
    },
  )
  .refine(
    data => {
      // Skip duration check for CLASS bookings — duration comes from the session
      if (data.classSessionId) return true
      if (!data.startsAt || !data.endsAt || data.duration == null) return true // validated above
      const diffMin = Math.round((data.endsAt.getTime() - data.startsAt.getTime()) / 60000)
      return Math.abs(diffMin - data.duration) <= 1
    },
    {
      message: 'La duracion no coincide con el rango de fechas',
      path: ['duration'],
    },
  )

// ---- Param Schemas ----

export const venueParamsSchema = z.object({
  venueId: z.string().min(1),
})

export const reservationParamsSchema = z.object({
  venueId: z.string().min(1),
  id: z.string().min(1),
})

export const waitlistEntryParamsSchema = z.object({
  venueId: z.string().min(1),
  entryId: z.string().min(1),
})

export const publicVenueParamsSchema = z.object({
  venueSlug: z.string().min(1),
})

export const publicReservationParamsSchema = z.object({
  venueSlug: z.string().min(1),
  cancelSecret: z.string().uuid('Token de reservacion invalido'),
})
