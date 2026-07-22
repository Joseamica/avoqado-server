import { z } from 'zod'

// ==========================================
// RESERVATION SCHEMAS — Zod validation (Spanish messages)
// ==========================================

// Time format HH:MM (00:00 - 23:59)
export const timeStringSchema = z
  .string({ required_error: 'La hora es requerida', invalid_type_error: 'La hora debe ser texto' })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Formato de hora invalido (HH:MM)')

const timeRangeSchema = z
  .object(
    {
      open: timeStringSchema,
      close: timeStringSchema,
    },
    { required_error: 'El rango horario es requerido', invalid_type_error: 'El rango horario debe ser un objeto' },
  )
  .refine(data => data.close > data.open, {
    message: 'La hora de cierre debe ser posterior a la hora de apertura',
  })

export const dayScheduleSchema = z.object(
  {
    enabled: z.boolean({
      required_error: 'El estado del dia es requerido',
      invalid_type_error: 'El estado del dia debe ser booleano',
    }),
    ranges: z
      .array(timeRangeSchema, {
        required_error: 'Los rangos del dia son requeridos',
        invalid_type_error: 'Los rangos del dia deben ser una lista',
      })
      .max(3, 'Maximo 3 rangos por dia'),
  },
  {
    required_error: 'La configuracion del dia es requerida',
    invalid_type_error: 'La configuracion del dia debe ser un objeto',
  },
)

export const weeklyScheduleSchema = z.object(
  {
    monday: dayScheduleSchema,
    tuesday: dayScheduleSchema,
    wednesday: dayScheduleSchema,
    thursday: dayScheduleSchema,
    friday: dayScheduleSchema,
    saturday: dayScheduleSchema,
    sunday: dayScheduleSchema,
  },
  { required_error: 'El horario semanal es requerido', invalid_type_error: 'El horario semanal debe ser un objeto' },
)

export const operatingHoursSchema = weeklyScheduleSchema.optional()

export const localDateStringSchema = z
  .string({ required_error: 'La fecha local es requerida', invalid_type_error: 'La fecha local debe ser texto' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha invalido (YYYY-MM-DD)')
  .refine(value => {
    const [year, month, day] = value.split('-').map(Number)
    const parsed = new Date(Date.UTC(year, month - 1, day))
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
  }, 'Fecha invalida')

export const staffScheduleExceptionSchema = z
  .object(
    {
      startDate: localDateStringSchema,
      endDate: localDateStringSchema,
      kind: z.enum(['OFF', 'HOURS'], {
        errorMap: issue => ({
          message:
            issue.code === z.ZodIssueCode.invalid_type && issue.received === 'undefined'
              ? 'El tipo de excepcion es requerido'
              : 'El tipo de excepcion debe ser OFF u HOURS',
        }),
      }),
      startTime: timeStringSchema.optional(),
      endTime: timeStringSchema.optional(),
      note: z.string({ invalid_type_error: 'La nota debe ser texto' }).optional(),
    },
    { required_error: 'La excepcion es requerida', invalid_type_error: 'La excepcion debe ser un objeto' },
  )
  .superRefine((value, ctx) => {
    if (value.endDate < value.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'La fecha final debe ser igual o posterior a la inicial' })
    }
    if (value.kind === 'HOURS') {
      if (!value.startTime) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['startTime'], message: 'La hora inicial es requerida' })
      }
      if (!value.endTime) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endTime'], message: 'La hora final es requerida' })
      }
      if (value.startTime && value.endTime && value.endTime <= value.startTime) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endTime'], message: 'La hora final debe ser posterior a la inicial' })
      }
    } else if (value.startTime !== undefined || value.endTime !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['startTime'], message: 'Una excepcion OFF no acepta horas' })
    }
  })

export const replaceStaffScheduleBodySchema = z.object(
  {
    weekly: weeklyScheduleSchema.nullable(),
    exceptions: z
      .array(staffScheduleExceptionSchema, {
        required_error: 'Las excepciones son requeridas',
        invalid_type_error: 'Las excepciones deben ser una lista',
      })
      .max(30, 'Maximo 30 excepciones'),
  },
  {
    required_error: 'La configuracion del horario es requerida',
    invalid_type_error: 'La configuracion del horario debe ser un objeto',
  },
)

const staffVenueIdSchema = z
  .string({ required_error: 'El ID del profesionista es requerido', invalid_type_error: 'El ID del profesionista debe ser texto' })
  .min(1, 'El ID del profesionista es requerido')

export const replaceProductStaffBodySchema = z.object(
  {
    staffVenueIds: z
      .array(staffVenueIdSchema, {
        required_error: 'Los profesionistas son requeridos',
        invalid_type_error: 'Los profesionistas deben ser una lista',
      })
      .max(100, 'Maximo 100 profesionistas'),
  },
  {
    required_error: 'La configuracion de profesionistas es requerida',
    invalid_type_error: 'La configuracion de profesionistas debe ser un objeto',
  },
)

// Shared enums
export const ReservationStatusSchema = z.enum(['PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])

export const ReservationChannelSchema = z.enum(['DASHBOARD', 'WEB', 'PHONE', 'WHATSAPP', 'APP', 'WALK_IN', 'THIRD_PARTY'])
const depositModeSchema = z.enum(['none', 'card_hold', 'deposit', 'prepaid'])
const waitlistPriorityModeSchema = z.enum(['fifo', 'party_size', 'broadcast'])
const upfrontDefaultSchema = z.enum(['required', 'at_venue', 'optional'])

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

const availabilityProductIdsSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (typeof value === 'string') return
    if (Array.isArray(value)) {
      if (value.every(item => typeof item === 'string')) return
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cada ID de producto debe ser texto' })
      return
    }
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Los IDs de productos deben ser texto o una lista de textos' })
  })
  .transform(value => value as string | string[])

const availabilityBooleanSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value !== 'true' && value !== 'false') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'includeFull debe ser true o false' })
    }
  })
  .transform(value => value === 'true')

const availabilityWindowSemanticsSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value !== 'base') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'windowSemantics debe ser base' })
    }
  })
  .transform(() => 'base' as const)

export const getAvailabilityQuerySchema = z
  .object({
    // Single-day mode: date is required.
    // Range mode (used by /classes date-first listing): dateFrom + dateTo replace date.
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha invalido (YYYY-MM-DD)')
      .optional(),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato dateFrom invalido (YYYY-MM-DD)')
      .optional(),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato dateTo invalido (YYYY-MM-DD)')
      .optional(),
    duration: z.coerce.number().int().min(1, 'La duracion minima es 1 minuto').max(1440, 'La duracion maxima es 1440 minutos').optional(),
    partySize: z.coerce.number().int().min(1).max(100).optional(),
    tableId: z.string().optional(),
    staffId: z.string().optional(),
    productId: z.string().optional(),
    productIds: availabilityProductIdsSchema.optional(),
    includeFull: availabilityBooleanSchema.optional(),
    windowSemantics: availabilityWindowSemanticsSchema.optional(),
    type: z.enum(['class', 'appointment']).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.duration !== undefined && data.windowSemantics !== 'base' && data.duration < 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'La duracion minima sin windowSemantics=base es 5 minutos',
        path: ['duration'],
      })
    }
    if (data.duration !== undefined && data.windowSemantics !== 'base' && data.duration > 480) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'La duracion maxima sin windowSemantics=base es 480 minutos',
        path: ['duration'],
      })
    }
  })
  .refine(data => Boolean(data.date) || Boolean(data.dateFrom), {
    message: 'La fecha es requerida (envía date o dateFrom)',
    path: ['date'],
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

const reservationModifierSelectionsSchema = z
  .array(
    z.object({
      productId: z.string().min(1, 'productId del modificador es requerido'),
      modifierId: z.string().min(1, 'modifierId es requerido'),
      quantity: z.number().int().min(1).max(99).optional(),
    }),
  )
  .max(100)

export const createReservationBodySchema = z
  .object({
    startsAt: z.coerce.date({ required_error: 'La fecha de inicio es requerida' }),
    endsAt: z.coerce.date({ required_error: 'La fecha de fin es requerida' }),
    duration: z.number().int().min(1, 'La duracion minima es 1 minuto').max(1440, 'La duracion maxima es 1440 minutos'),
    channel: ReservationChannelSchema.optional(),
    customerId: z.string().optional(),
    guestName: z.string().min(1, 'El nombre del cliente es requerido').max(200).optional(),
    guestPhone: z.string().max(20).optional(),
    guestEmail: z.string().email('Email invalido').max(200).optional(),
    partySize: z.number().int().min(1, 'Minimo 1 persona').max(100, 'Maximo 100 personas').optional(),
    tableId: z.string().optional(),
    productId: z.string().optional(),
    productIds: z.array(z.string().min(1)).max(20).optional(),
    modifierSelections: reservationModifierSelectionsSchema.optional(),
    windowSemantics: z.literal('base', { invalid_type_error: 'windowSemantics debe ser base' }).optional(),
    assignedStaffId: z.string().optional(),
    allowOverCapacity: z.boolean({ invalid_type_error: 'allowOverCapacity debe ser true o false' }).optional(),
    specialRequests: z.string().max(2000).optional(),
    internalNotes: z.string().max(2000).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.windowSemantics !== 'base' && data.duration < 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'La duracion minima sin windowSemantics=base es 5 minutos',
        path: ['duration'],
      })
    }
    if (data.windowSemantics !== 'base' && data.duration > 480) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'La duracion maxima sin windowSemantics=base es 480 minutos',
        path: ['duration'],
      })
    }
  })
  .refine(data => data.endsAt > data.startsAt, {
    message: 'La fecha de fin debe ser posterior a la fecha de inicio',
    path: ['endsAt'],
  })
  .refine(
    data => {
      if (data.windowSemantics === 'base') return true
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

export const rescheduleNotificationChannelSchema = z.enum(['push', 'whatsapp', 'email', 'sms', 'none'])

export const rescheduleBodySchema = z
  .object({
    startsAt: z.coerce.date({ required_error: 'La nueva fecha de inicio es requerida' }),
    endsAt: z.coerce.date({ required_error: 'La nueva fecha de fin es requerida' }),
    notificationChannel: rescheduleNotificationChannelSchema.optional(),
    customMessage: z.string().max(500).optional(),
  })
  .refine(data => data.endsAt > data.startsAt, {
    message: 'La fecha de fin debe ser posterior a la fecha de inicio',
    path: ['endsAt'],
  })

export const cancelBodySchema = z.object({
  reason: z.string().max(1000).optional(),
})

export const publicRescheduleBodySchema = z
  .object({
    // Class reschedule (swap to another session of the same class).
    classSessionId: z.string().min(1).optional(),
    spotIds: z.array(z.string().min(1)).max(100).optional(),
    reason: z.string().max(1000).optional(),
    // Appointment reschedule (move to a new slot of the same service).
    startsAt: z.string().min(1).optional(),
    holdId: z.string().min(1).optional(),
  })
  .refine(d => Boolean(d.classSessionId) || Boolean(d.startsAt), {
    message: 'Debes proporcionar classSessionId (clase) o startsAt (cita)',
    path: ['startsAt'],
  })

// Reschedule availability (appointments): same shape as a single-date slot query,
// but scoped by cancelSecret server-side so it can exclude the moving reservation.
export const rescheduleAvailabilityQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date debe ser YYYY-MM-DD'),
})

// Reschedule hold (appointments): reserve the target slot for ~10 min before confirm.
export const rescheduleHoldBodySchema = z.object({
  startsAt: z.string().min(1, 'startsAt es requerido'),
  endsAt: z.string().min(1, 'endsAt es requerido'),
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
    requireAccount: z.boolean().optional(),
    allowCustomerCancel: z.boolean().optional(),
    minHoursBeforeCancel: z.number().int().min(0).max(720).nullable().optional(),
    minHoursBeforeStart: z.number().int().min(0).max(720).nullable().optional(),
    forfeitDeposit: z.boolean().optional(),
    noShowFeePercent: z.number().int().min(0).max(100).nullable().optional(),
    remindersEnabled: z.boolean().optional(),
    reminderChannels: z.array(z.string().min(1).max(50)).max(10).optional(),
    reminderMinBefore: z.array(z.number().int().min(1).max(10080)).max(10).optional(),
    appointmentUpfrontDefault: upfrontDefaultSchema.optional(),
    classUpfrontDefault: upfrontDefaultSchema.optional(),
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
        creditRefundMode: z.enum(['NEVER', 'ALWAYS', 'TIME_BASED']).optional(),
        creditFreeRefundHoursBefore: z.number().int().min(0).max(720).optional(),
        creditLateRefundPercent: z.number().int().min(0).max(100).optional(),
        creditNoShowRefund: z.boolean().optional(),
        allowCustomerReschedule: z.boolean().optional(),
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
        requireAccount: z.boolean().optional(),
      })
      .optional(),
    payments: z
      .object({
        appointmentUpfrontDefault: upfrontDefaultSchema.optional(),
        classUpfrontDefault: upfrontDefaultSchema.optional(),
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
    duration: z.number().int().min(1, 'La duracion minima es 1 minuto').max(1440).optional(),
    guestName: z.string().min(1, 'El nombre es requerido').max(200),
    guestPhone: z.string().min(1, 'El telefono es requerido').max(20).optional(),
    guestEmail: z.string().email('Email invalido').max(200).optional(),
    partySize: z.number().int().min(1).max(100).optional(),
    productId: z.string().optional(),
    // Multi-service appointments (Square pattern). When present, the controller
    // sums durations + sets productId = productIds[0] for back-compat.
    productIds: z.array(z.string().min(1)).max(20).optional(),
    staffId: z.string({ invalid_type_error: 'staffId debe ser texto' }).min(1, 'staffId es requerido').optional(),
    windowSemantics: z.literal('base', { invalid_type_error: 'windowSemantics debe ser base' }).optional(),
    classSessionId: z.string().optional(),
    spotIds: z.array(z.string().min(1)).max(100).optional(),
    specialRequests: z.string().max(2000).optional(),
    creditItemBalanceId: z.string().optional(), // Credit pack: redeems N credits on booking (N = partySize / spotIds.length)
    // Multi-service /appointments — one balance per selected service. Server
    // iterates and redeems creditsPerBalance from each. When both fields are
    // present, the array wins.
    creditItemBalanceIds: z.array(z.string().min(1)).max(20).optional(),
    // Transitional hold bridge — when present and valid, create excludes this
    // trusted row from its authoritative checks and deletes it best-effort
    // after commit. Atomic consumption arrives with the Release A protocol.
    holdId: z.string().optional(),
    modifierSelections: reservationModifierSelectionsSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.duration !== undefined && data.windowSemantics !== 'base' && data.duration < 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'La duracion minima sin windowSemantics=base es 5 minutos',
        path: ['duration'],
      })
    }
    if (data.duration !== undefined && data.windowSemantics !== 'base' && data.duration > 480) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'La duracion maxima sin windowSemantics=base es 480 minutos',
        path: ['duration'],
      })
    }
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
      if (data.classSessionId || data.windowSemantics === 'base') return true
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

const staffConfigVenueIdSchema = z
  .string({ required_error: 'El ID del establecimiento es requerido', invalid_type_error: 'El ID del establecimiento debe ser texto' })
  .min(1, 'El ID del establecimiento es requerido')

const staffConfigProductIdSchema = z
  .string({ required_error: 'El ID del producto es requerido', invalid_type_error: 'El ID del producto debe ser texto' })
  .min(1, 'El ID del producto es requerido')

export const staffScheduleParamsSchema = z.object(
  {
    venueId: staffConfigVenueIdSchema,
    staffVenueId: staffVenueIdSchema,
  },
  {
    required_error: 'Los parametros del horario son requeridos',
    invalid_type_error: 'Los parametros del horario deben ser un objeto',
  },
)

export const productStaffParamsSchema = z.object(
  {
    venueId: staffConfigVenueIdSchema,
    productId: staffConfigProductIdSchema,
  },
  {
    required_error: 'Los parametros del servicio son requeridos',
    invalid_type_error: 'Los parametros del servicio deben ser un objeto',
  },
)

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

// Slot hold (Square countdown UX) ------------------------------------------
export const publicCreateHoldBodySchema = z
  .object({
    startsAt: z.coerce.date({ required_error: 'La fecha de inicio es requerida' }),
    endsAt: z.coerce.date({ required_error: 'La fecha de fin es requerida' }),
    productIds: z.array(z.string().min(1)).max(20).optional(),
    classSessionId: z.string().optional(),
    partySize: z.number().int().min(1).max(100).optional(),
    fingerprint: z.string().max(200).optional(),
  })
  .refine(data => data.endsAt > data.startsAt, {
    message: 'endsAt debe ser posterior a startsAt',
    path: ['endsAt'],
  })

export const publicHoldParamsSchema = z.object({
  venueSlug: z.string().min(1),
  holdId: z.string().min(1),
})
