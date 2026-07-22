import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { logAction } from './activity-log.service'
import { BadRequestError } from '../../errors/AppError'
import { canVenueChargeOnline } from '../payments/ecommerceCapability'

// ==========================================
// RESERVATION SETTINGS — Typed config from ReservationSettings model
// Replaces moduleService.getModuleConfig() for reservations
// ==========================================

export interface DaySchedule {
  enabled: boolean
  ranges: { open: string; close: string }[] // "09:00", "22:00" — venue local time
}

export interface OperatingHours {
  monday: DaySchedule
  tuesday: DaySchedule
  wednesday: DaySchedule
  thursday: DaySchedule
  friday: DaySchedule
  saturday: DaySchedule
  sunday: DaySchedule
}

export function getDefaultOperatingHours(): OperatingHours {
  const defaultDay: DaySchedule = { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] }
  const closedDay: DaySchedule = { enabled: false, ranges: [] }
  return {
    monday: defaultDay,
    tuesday: defaultDay,
    wednesday: defaultDay,
    thursday: defaultDay,
    friday: defaultDay,
    saturday: defaultDay,
    sunday: closedDay,
  }
}

export interface ReservationConfig {
  scheduling: {
    slotIntervalMin: number
    defaultDurationMin: number
    autoConfirm: boolean
    maxAdvanceDays: number
    minNoticeMin: number
    noShowGraceMin: number
    pacingMaxPerSlot: number | null
    onlineCapacityPercent: number
    capacityMode: 'pacing' | 'per_staff'
  }
  deposits: {
    enabled: boolean
    mode: 'none' | 'card_hold' | 'deposit' | 'prepaid'
    percentageOfTotal: number | null
    fixedAmount: number | null
    requiredForPartySizeGte: number | null
    paymentWindowHrs: number | null
  }
  /**
   * Type-aware upfront payment defaults (Phase 3 of public booking redesign).
   * Square's pattern: classes default to 'required' (pay-now to hold the spot),
   * appointments default to 'at_venue' (pay on arrival). Per-product Product.upfrontPolicy
   * overrides these — see resolveUpfrontPolicy() in reservation.public.controller.ts.
   */
  payments: {
    appointmentUpfrontDefault: 'required' | 'at_venue' | 'optional'
    classUpfrontDefault: 'required' | 'at_venue' | 'optional'
  }
  cancellation: {
    allowCustomerCancel: boolean
    minHoursBeforeStart: number | null
    forfeitDeposit: boolean
    noShowFeePercent: number | null
    creditRefundMode: 'NEVER' | 'ALWAYS' | 'TIME_BASED'
    creditFreeRefundHoursBefore: number
    creditLateRefundPercent: number
    creditNoShowRefund: boolean
    allowCustomerReschedule: boolean
  }
  waitlist: {
    enabled: boolean
    maxSize: number
    priorityMode: 'fifo' | 'party_size' | 'broadcast'
    notifyWindowMin: number
  }
  reminders: {
    enabled: boolean
    channels: string[]
    minutesBefore: number[]
  }
  publicBooking: {
    enabled: boolean
    requirePhone: boolean
    requireEmail: boolean
    requireAccount: boolean
    showStaffPicker: boolean
  }
  /**
   * Google Calendar Sync (Phase 2) — controls per-venue behavior when staff or
   * the venue admin has connected a Google Calendar via /api/v1/google-calendar.
   * These fields gate the push direction; pull-direction blocking is always on
   * when a connection exists.
   */
  googleCalendar: {
    pushEnabled: boolean
    dualWrite: boolean
    eventDetailLevel: 'MINIMAL' | 'SERVICE' | 'FULL'
    removeCancelled: boolean
    classRosterInDescription: boolean
  }
  operatingHours: OperatingHours
  /**
   * Computed (read-only) capability flag — NOT stored. Whether the venue can
   * collect money online for booking surfaces (has a chargeable e-commerce
   * merchant). Populated by the dashboard settings GET controller so the UI can
   * disable the deposit/upfront toggles and show the "connect e-commerce" banner.
   * Optional because getDefaultConfig() and hot-path callers don't compute it.
   */
  canChargeOnline?: boolean
}

type ReservationSettingsUpdateInput = Partial<{
  slotIntervalMin: number
  defaultDurationMin: number
  autoConfirm: boolean
  maxAdvanceDays: number
  minNoticeMin: number
  noShowGraceMin: number
  pacingMaxPerSlot: number | null
  onlineCapacityPercent: number
  capacityMode: 'pacing' | 'per_staff'
  depositMode: string
  depositFixedAmount: number | null
  depositPercentage: number | null
  depositPartySizeGte: number | null
  depositPaymentWindow: number | null
  waitlistEnabled: boolean
  waitlistMaxSize: number
  waitlistPriorityMode: string
  waitlistNotifyWindow: number
  publicBookingEnabled: boolean
  requirePhone: boolean
  requireEmail: boolean
  requireAccount: boolean
  showStaffPicker: boolean
  allowCustomerCancel: boolean
  minHoursBeforeCancel: number | null
  minHoursBeforeStart: number | null
  forfeitDeposit: boolean
  noShowFeePercent: number | null
  creditRefundMode: 'NEVER' | 'ALWAYS' | 'TIME_BASED'
  creditFreeRefundHoursBefore: number
  creditLateRefundPercent: number
  creditNoShowRefund: boolean
  allowCustomerReschedule: boolean
  remindersEnabled: boolean
  reminderChannels: string[]
  reminderMinBefore: number[]
  appointmentUpfrontDefault: 'required' | 'at_venue' | 'optional'
  classUpfrontDefault: 'required' | 'at_venue' | 'optional'
  operatingHours: Prisma.InputJsonValue | typeof Prisma.DbNull
  // Google Calendar (Phase 2) — flat legacy form
  googleCalendarPushEnabled: boolean
  googleCalendarDualWrite: boolean
  googleCalendarEventDetailLevel: 'MINIMAL' | 'SERVICE' | 'FULL'
  googleCalendarRemoveCancelled: boolean
  googleCalendarClassRosterInDescription: boolean
  scheduling: Partial<ReservationConfig['scheduling']>
  deposits: Partial<ReservationConfig['deposits']>
  cancellation: Partial<ReservationConfig['cancellation']>
  waitlist: Partial<ReservationConfig['waitlist']>
  reminders: Partial<ReservationConfig['reminders']>
  publicBooking: Partial<ReservationConfig['publicBooking']>
  payments: Partial<ReservationConfig['payments']>
  googleCalendar: Partial<ReservationConfig['googleCalendar']>
}>

/**
 * Get reservation settings for a venue, creating defaults if not found.
 * Returns a config object compatible with the previous moduleConfig shape.
 */
export async function getReservationSettings(
  venueId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ReservationConfig> {
  const settings = await client.reservationSettings.findUnique({
    where: { venueId },
  })

  if (!settings) {
    // Return defaults (same as DB defaults in the model)
    return getDefaultConfig()
  }

  return {
    scheduling: {
      slotIntervalMin: settings.slotIntervalMin,
      defaultDurationMin: settings.defaultDurationMin,
      autoConfirm: settings.autoConfirm,
      maxAdvanceDays: settings.maxAdvanceDays,
      minNoticeMin: settings.minNoticeMin,
      noShowGraceMin: settings.noShowGraceMin,
      pacingMaxPerSlot: settings.pacingMaxPerSlot,
      onlineCapacityPercent: settings.onlineCapacityPercent,
      capacityMode: settings.capacityMode === 'per_staff' ? 'per_staff' : 'pacing',
    },
    deposits: {
      enabled: settings.depositMode !== 'none',
      mode: settings.depositMode as ReservationConfig['deposits']['mode'],
      percentageOfTotal: settings.depositPercentage,
      fixedAmount: settings.depositFixedAmount ? Number(settings.depositFixedAmount) : null,
      requiredForPartySizeGte: settings.depositPartySizeGte,
      paymentWindowHrs: settings.depositPaymentWindow,
    },
    payments: {
      appointmentUpfrontDefault:
        (settings.appointmentUpfrontDefault as ReservationConfig['payments']['appointmentUpfrontDefault']) ?? 'at_venue',
      classUpfrontDefault: (settings.classUpfrontDefault as ReservationConfig['payments']['classUpfrontDefault']) ?? 'required',
    },
    cancellation: {
      allowCustomerCancel: settings.allowCustomerCancel,
      minHoursBeforeStart: settings.minHoursBeforeCancel,
      forfeitDeposit: settings.forfeitDeposit,
      noShowFeePercent: settings.noShowFeePercent,
      creditRefundMode: (settings.creditRefundMode as 'NEVER' | 'ALWAYS' | 'TIME_BASED') ?? 'TIME_BASED',
      creditFreeRefundHoursBefore: settings.creditFreeRefundHoursBefore,
      creditLateRefundPercent: settings.creditLateRefundPercent,
      creditNoShowRefund: settings.creditNoShowRefund,
      allowCustomerReschedule: settings.allowCustomerReschedule,
    },
    waitlist: {
      enabled: settings.waitlistEnabled,
      maxSize: settings.waitlistMaxSize,
      priorityMode: settings.waitlistPriorityMode as ReservationConfig['waitlist']['priorityMode'],
      notifyWindowMin: settings.waitlistNotifyWindow,
    },
    reminders: {
      enabled: settings.remindersEnabled,
      channels: settings.reminderChannels,
      minutesBefore: settings.reminderMinBefore,
    },
    publicBooking: {
      enabled: settings.publicBookingEnabled,
      requirePhone: settings.requirePhone,
      requireEmail: settings.requireEmail,
      requireAccount: settings.requireAccount ?? false,
      showStaffPicker: settings.showStaffPicker ?? false,
    },
    googleCalendar: {
      pushEnabled: settings.googleCalendarPushEnabled,
      dualWrite: settings.googleCalendarDualWrite,
      eventDetailLevel: ((['MINIMAL', 'SERVICE', 'FULL'] as const).includes(
        settings.googleCalendarEventDetailLevel as 'MINIMAL' | 'SERVICE' | 'FULL',
      )
        ? settings.googleCalendarEventDetailLevel
        : 'FULL') as 'MINIMAL' | 'SERVICE' | 'FULL',
      removeCancelled: settings.googleCalendarRemoveCancelled,
      classRosterInDescription: settings.googleCalendarClassRosterInDescription,
    },
    operatingHours: settings.operatingHours ? (settings.operatingHours as unknown as OperatingHours) : getDefaultOperatingHours(),
  }
}

/**
 * Ensure settings exist for a venue (upsert with defaults).
 */
export async function ensureReservationSettings(venueId: string) {
  return prisma.reservationSettings.upsert({
    where: { venueId },
    create: { venueId },
    update: {},
  })
}

/**
 * Update reservation settings for a venue.
 */
export async function updateReservationSettings(venueId: string, data: ReservationSettingsUpdateInput) {
  const normalized = normalizeReservationSettingsUpdate(data)

  // 🔒 Can't TRANSITION any online-charging setting from off → on without a
  // chargeable e-commerce rail. "Enabling charging" = a deposit mode other than
  // 'none', or an upfront default other than 'at_venue'. Turning things off (or
  // leaving them) is always allowed.
  //
  // Bug fixed 2026-07-07 (found by /full-testing): comparing only the INCOMING
  // payload — not the current DB row — meant a venue that already had cobro
  // configured before this gate existed (legacy data, or the field just isn't
  // being touched this call) got blocked from saving ANY unrelated setting,
  // because the dashboard form always resends the full deposits/payments object.
  // We now only block a genuine off→on TRANSITION; resaving an already-charging
  // value (even switching between two charging modes) is left alone — that
  // venue's merchant gap is pre-existing, not something this save created.
  const wantsDeposit = normalized.depositMode !== undefined
  const wantsAppt = normalized.appointmentUpfrontDefault !== undefined
  const wantsClass = normalized.classUpfrontDefault !== undefined
  let enablesCharging = false
  if (wantsDeposit || wantsAppt || wantsClass) {
    const current = await prisma.reservationSettings.findUnique({ where: { venueId } })
    // Baseline for "was this venue already charging" when a field was never
    // explicitly saved. NOTE this intentionally does NOT match getDefaultConfig()'s
    // *display* default for classUpfrontDefault ('required') — that default is a
    // product choice for brand-new venues, not evidence an operator activated
    // cobro. For THIS guard (has a human ever explicitly turned it on?), a
    // missing row/field means "no", so the safe baseline is 'at_venue' for both
    // upfront fields and 'none' for deposits.
    const wasChargingDeposit = (current?.depositMode ?? 'none') !== 'none'
    const wasChargingAppt = (current?.appointmentUpfrontDefault ?? 'at_venue') !== 'at_venue'
    const wasChargingClass = (current?.classUpfrontDefault ?? 'at_venue') !== 'at_venue'

    const nextDepositMode = typeof normalized.depositMode === 'string' ? normalized.depositMode : undefined
    const nextApptUpfront = typeof normalized.appointmentUpfrontDefault === 'string' ? normalized.appointmentUpfrontDefault : undefined
    const nextClassUpfront = typeof normalized.classUpfrontDefault === 'string' ? normalized.classUpfrontDefault : undefined

    enablesCharging =
      (nextDepositMode !== undefined && nextDepositMode !== 'none' && !wasChargingDeposit) ||
      (nextApptUpfront !== undefined && nextApptUpfront !== 'at_venue' && !wasChargingAppt) ||
      (nextClassUpfront !== undefined && nextClassUpfront !== 'at_venue' && !wasChargingClass)
  }
  if (enablesCharging && !(await canVenueChargeOnline(venueId))) {
    throw new BadRequestError(
      'Necesitas dar de alta un proveedor de e-commerce (Stripe/Mercado Pago) para cobrar o pre-cobrar reservaciones.',
    )
  }

  const settings = await prisma.reservationSettings.upsert({
    where: { venueId },
    create: { venueId, ...(normalized as any) },
    update: normalized,
  })

  logAction({
    venueId,
    action: 'RESERVATION_SETTINGS_UPDATED',
    entity: 'ReservationSettings',
    entityId: settings.id,
    data: { venueId },
  })

  return settings
}

function normalizeReservationSettingsUpdate(data: ReservationSettingsUpdateInput): Prisma.ReservationSettingsUpdateInput {
  const normalized: Prisma.ReservationSettingsUpdateInput = {}

  // Flat payload support (legacy)
  if (data.slotIntervalMin !== undefined) normalized.slotIntervalMin = data.slotIntervalMin
  if (data.defaultDurationMin !== undefined) normalized.defaultDurationMin = data.defaultDurationMin
  if (data.autoConfirm !== undefined) normalized.autoConfirm = data.autoConfirm
  if (data.maxAdvanceDays !== undefined) normalized.maxAdvanceDays = data.maxAdvanceDays
  if (data.minNoticeMin !== undefined) normalized.minNoticeMin = data.minNoticeMin
  if (data.noShowGraceMin !== undefined) normalized.noShowGraceMin = data.noShowGraceMin
  if (data.pacingMaxPerSlot !== undefined) normalized.pacingMaxPerSlot = data.pacingMaxPerSlot
  if (data.onlineCapacityPercent !== undefined) normalized.onlineCapacityPercent = data.onlineCapacityPercent
  if (data.capacityMode !== undefined) normalized.capacityMode = data.capacityMode
  if (data.depositMode !== undefined) normalized.depositMode = data.depositMode
  if (data.depositFixedAmount !== undefined) normalized.depositFixedAmount = data.depositFixedAmount
  if (data.depositPercentage !== undefined) normalized.depositPercentage = data.depositPercentage
  if (data.depositPartySizeGte !== undefined) normalized.depositPartySizeGte = data.depositPartySizeGte
  if (data.depositPaymentWindow !== undefined) normalized.depositPaymentWindow = data.depositPaymentWindow
  if (data.waitlistEnabled !== undefined) normalized.waitlistEnabled = data.waitlistEnabled
  if (data.waitlistMaxSize !== undefined) normalized.waitlistMaxSize = data.waitlistMaxSize
  if (data.waitlistPriorityMode !== undefined) normalized.waitlistPriorityMode = data.waitlistPriorityMode
  if (data.waitlistNotifyWindow !== undefined) normalized.waitlistNotifyWindow = data.waitlistNotifyWindow
  if (data.publicBookingEnabled !== undefined) normalized.publicBookingEnabled = data.publicBookingEnabled
  if (data.requirePhone !== undefined) normalized.requirePhone = data.requirePhone
  if (data.requireEmail !== undefined) normalized.requireEmail = data.requireEmail
  if (data.requireAccount !== undefined) normalized.requireAccount = data.requireAccount
  if (data.showStaffPicker !== undefined) normalized.showStaffPicker = data.showStaffPicker
  if (data.allowCustomerCancel !== undefined) normalized.allowCustomerCancel = data.allowCustomerCancel
  if (data.minHoursBeforeCancel !== undefined) normalized.minHoursBeforeCancel = data.minHoursBeforeCancel
  if (data.minHoursBeforeStart !== undefined) normalized.minHoursBeforeCancel = data.minHoursBeforeStart
  if (data.forfeitDeposit !== undefined) normalized.forfeitDeposit = data.forfeitDeposit
  if (data.noShowFeePercent !== undefined) normalized.noShowFeePercent = data.noShowFeePercent
  if (data.creditRefundMode !== undefined) normalized.creditRefundMode = data.creditRefundMode
  if (data.creditFreeRefundHoursBefore !== undefined) normalized.creditFreeRefundHoursBefore = data.creditFreeRefundHoursBefore
  if (data.creditLateRefundPercent !== undefined) normalized.creditLateRefundPercent = data.creditLateRefundPercent
  if (data.creditNoShowRefund !== undefined) normalized.creditNoShowRefund = data.creditNoShowRefund
  if (data.allowCustomerReschedule !== undefined) normalized.allowCustomerReschedule = data.allowCustomerReschedule
  if (data.remindersEnabled !== undefined) normalized.remindersEnabled = data.remindersEnabled
  if (data.reminderChannels !== undefined) normalized.reminderChannels = data.reminderChannels
  if (data.reminderMinBefore !== undefined) normalized.reminderMinBefore = data.reminderMinBefore
  if (data.appointmentUpfrontDefault !== undefined) normalized.appointmentUpfrontDefault = data.appointmentUpfrontDefault
  if (data.classUpfrontDefault !== undefined) normalized.classUpfrontDefault = data.classUpfrontDefault
  if (data.operatingHours !== undefined) normalized.operatingHours = data.operatingHours

  // Nested payload support (dashboard UI)
  if (data.scheduling) {
    if (data.scheduling.slotIntervalMin !== undefined) normalized.slotIntervalMin = data.scheduling.slotIntervalMin
    if (data.scheduling.defaultDurationMin !== undefined) normalized.defaultDurationMin = data.scheduling.defaultDurationMin
    if (data.scheduling.autoConfirm !== undefined) normalized.autoConfirm = data.scheduling.autoConfirm
    if (data.scheduling.maxAdvanceDays !== undefined) normalized.maxAdvanceDays = data.scheduling.maxAdvanceDays
    if (data.scheduling.minNoticeMin !== undefined) normalized.minNoticeMin = data.scheduling.minNoticeMin
    if (data.scheduling.noShowGraceMin !== undefined) normalized.noShowGraceMin = data.scheduling.noShowGraceMin
    if (data.scheduling.pacingMaxPerSlot !== undefined) normalized.pacingMaxPerSlot = data.scheduling.pacingMaxPerSlot
    if (data.scheduling.onlineCapacityPercent !== undefined) normalized.onlineCapacityPercent = data.scheduling.onlineCapacityPercent
    if (data.scheduling.capacityMode !== undefined) normalized.capacityMode = data.scheduling.capacityMode
  }

  if (data.deposits) {
    if (data.deposits.mode !== undefined) normalized.depositMode = data.deposits.mode
    if (data.deposits.fixedAmount !== undefined) normalized.depositFixedAmount = data.deposits.fixedAmount
    if (data.deposits.percentageOfTotal !== undefined) normalized.depositPercentage = data.deposits.percentageOfTotal
    if (data.deposits.requiredForPartySizeGte !== undefined) normalized.depositPartySizeGte = data.deposits.requiredForPartySizeGte
    if (data.deposits.paymentWindowHrs !== undefined) normalized.depositPaymentWindow = data.deposits.paymentWindowHrs
  }

  if (data.publicBooking) {
    if (data.publicBooking.enabled !== undefined) normalized.publicBookingEnabled = data.publicBooking.enabled
    if (data.publicBooking.requirePhone !== undefined) normalized.requirePhone = data.publicBooking.requirePhone
    if (data.publicBooking.requireEmail !== undefined) normalized.requireEmail = data.publicBooking.requireEmail
    if (data.publicBooking.requireAccount !== undefined) normalized.requireAccount = data.publicBooking.requireAccount
    if (data.publicBooking.showStaffPicker !== undefined) normalized.showStaffPicker = data.publicBooking.showStaffPicker
  }

  if (data.cancellation) {
    if (data.cancellation.allowCustomerCancel !== undefined) normalized.allowCustomerCancel = data.cancellation.allowCustomerCancel
    if (data.cancellation.minHoursBeforeStart !== undefined) normalized.minHoursBeforeCancel = data.cancellation.minHoursBeforeStart
    if (data.cancellation.forfeitDeposit !== undefined) normalized.forfeitDeposit = data.cancellation.forfeitDeposit
    if (data.cancellation.noShowFeePercent !== undefined) normalized.noShowFeePercent = data.cancellation.noShowFeePercent
    if (data.cancellation.creditRefundMode !== undefined) normalized.creditRefundMode = data.cancellation.creditRefundMode
    if (data.cancellation.creditFreeRefundHoursBefore !== undefined)
      normalized.creditFreeRefundHoursBefore = data.cancellation.creditFreeRefundHoursBefore
    if (data.cancellation.creditLateRefundPercent !== undefined)
      normalized.creditLateRefundPercent = data.cancellation.creditLateRefundPercent
    if (data.cancellation.creditNoShowRefund !== undefined) normalized.creditNoShowRefund = data.cancellation.creditNoShowRefund
    if (data.cancellation.allowCustomerReschedule !== undefined)
      normalized.allowCustomerReschedule = data.cancellation.allowCustomerReschedule
  }

  if (data.waitlist) {
    if (data.waitlist.enabled !== undefined) normalized.waitlistEnabled = data.waitlist.enabled
    if (data.waitlist.maxSize !== undefined) normalized.waitlistMaxSize = data.waitlist.maxSize
    if (data.waitlist.priorityMode !== undefined) normalized.waitlistPriorityMode = data.waitlist.priorityMode
    if (data.waitlist.notifyWindowMin !== undefined) normalized.waitlistNotifyWindow = data.waitlist.notifyWindowMin
  }

  if (data.reminders) {
    if (data.reminders.enabled !== undefined) normalized.remindersEnabled = data.reminders.enabled
    if (data.reminders.channels !== undefined) normalized.reminderChannels = data.reminders.channels
    if (data.reminders.minutesBefore !== undefined) normalized.reminderMinBefore = data.reminders.minutesBefore
  }

  if (data.payments) {
    if (data.payments.appointmentUpfrontDefault !== undefined)
      normalized.appointmentUpfrontDefault = data.payments.appointmentUpfrontDefault
    if (data.payments.classUpfrontDefault !== undefined) normalized.classUpfrontDefault = data.payments.classUpfrontDefault
  }

  // Google Calendar (Phase 2) — flat legacy keys
  if (data.googleCalendarPushEnabled !== undefined) normalized.googleCalendarPushEnabled = data.googleCalendarPushEnabled
  if (data.googleCalendarDualWrite !== undefined) normalized.googleCalendarDualWrite = data.googleCalendarDualWrite
  if (data.googleCalendarEventDetailLevel !== undefined) normalized.googleCalendarEventDetailLevel = data.googleCalendarEventDetailLevel
  if (data.googleCalendarRemoveCancelled !== undefined) normalized.googleCalendarRemoveCancelled = data.googleCalendarRemoveCancelled
  if (data.googleCalendarClassRosterInDescription !== undefined)
    normalized.googleCalendarClassRosterInDescription = data.googleCalendarClassRosterInDescription

  // Nested form `googleCalendar: { ... }` — dashboard UI shape
  if (data.googleCalendar) {
    if (data.googleCalendar.pushEnabled !== undefined) normalized.googleCalendarPushEnabled = data.googleCalendar.pushEnabled
    if (data.googleCalendar.dualWrite !== undefined) normalized.googleCalendarDualWrite = data.googleCalendar.dualWrite
    if (data.googleCalendar.eventDetailLevel !== undefined) normalized.googleCalendarEventDetailLevel = data.googleCalendar.eventDetailLevel
    if (data.googleCalendar.removeCancelled !== undefined) normalized.googleCalendarRemoveCancelled = data.googleCalendar.removeCancelled
    if (data.googleCalendar.classRosterInDescription !== undefined)
      normalized.googleCalendarClassRosterInDescription = data.googleCalendar.classRosterInDescription
  }

  return normalized
}

function getDefaultConfig(): ReservationConfig {
  return {
    scheduling: {
      slotIntervalMin: 15,
      defaultDurationMin: 60,
      autoConfirm: true,
      maxAdvanceDays: 60,
      minNoticeMin: 60,
      noShowGraceMin: 15,
      pacingMaxPerSlot: null,
      onlineCapacityPercent: 100,
      capacityMode: 'pacing',
    },
    deposits: {
      enabled: false,
      mode: 'none',
      percentageOfTotal: null,
      fixedAmount: null,
      requiredForPartySizeGte: null,
      paymentWindowHrs: null,
    },
    payments: {
      appointmentUpfrontDefault: 'at_venue',
      classUpfrontDefault: 'required',
    },
    cancellation: {
      allowCustomerCancel: true,
      minHoursBeforeStart: 2,
      forfeitDeposit: false,
      noShowFeePercent: null,
      creditRefundMode: 'TIME_BASED',
      creditFreeRefundHoursBefore: 12,
      creditLateRefundPercent: 0,
      creditNoShowRefund: false,
      allowCustomerReschedule: true,
    },
    waitlist: {
      enabled: true,
      maxSize: 50,
      priorityMode: 'fifo',
      notifyWindowMin: 30,
    },
    reminders: {
      enabled: true,
      channels: ['EMAIL'],
      minutesBefore: [1440, 120],
    },
    publicBooking: {
      enabled: false,
      requirePhone: true,
      requireEmail: false,
      requireAccount: false,
      showStaffPicker: false,
    },
    googleCalendar: {
      pushEnabled: true,
      dualWrite: false,
      eventDetailLevel: 'FULL',
      removeCancelled: false,
      classRosterInDescription: true,
    },
    operatingHours: getDefaultOperatingHours(),
  }
}

export function isStaffAware(settings: ReservationConfig): boolean {
  return settings.scheduling.capacityMode === 'per_staff' || settings.publicBooking.showStaffPicker === true
}
