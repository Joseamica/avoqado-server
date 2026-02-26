import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { logAction } from './activity-log.service'

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
  }
  deposits: {
    enabled: boolean
    mode: 'none' | 'card_hold' | 'deposit' | 'prepaid'
    percentageOfTotal: number | null
    fixedAmount: number | null
    requiredForPartySizeGte: number | null
    paymentWindowHrs: number | null
  }
  cancellation: {
    allowCustomerCancel: boolean
    minHoursBeforeStart: number | null
    forfeitDeposit: boolean
    noShowFeePercent: number | null
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
  }
  operatingHours: OperatingHours
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
  allowCustomerCancel: boolean
  minHoursBeforeCancel: number | null
  minHoursBeforeStart: number | null
  forfeitDeposit: boolean
  noShowFeePercent: number | null
  remindersEnabled: boolean
  reminderChannels: string[]
  reminderMinBefore: number[]
  operatingHours: Prisma.InputJsonValue | typeof Prisma.DbNull
  scheduling: Partial<ReservationConfig['scheduling']>
  deposits: Partial<ReservationConfig['deposits']>
  cancellation: Partial<ReservationConfig['cancellation']>
  waitlist: Partial<ReservationConfig['waitlist']>
  reminders: Partial<ReservationConfig['reminders']>
  publicBooking: Partial<ReservationConfig['publicBooking']>
}>

/**
 * Get reservation settings for a venue, creating defaults if not found.
 * Returns a config object compatible with the previous moduleConfig shape.
 */
export async function getReservationSettings(venueId: string): Promise<ReservationConfig> {
  const settings = await prisma.reservationSettings.findUnique({
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
    },
    deposits: {
      enabled: settings.depositMode !== 'none',
      mode: settings.depositMode as ReservationConfig['deposits']['mode'],
      percentageOfTotal: settings.depositPercentage,
      fixedAmount: settings.depositFixedAmount ? Number(settings.depositFixedAmount) : null,
      requiredForPartySizeGte: settings.depositPartySizeGte,
      paymentWindowHrs: settings.depositPaymentWindow,
    },
    cancellation: {
      allowCustomerCancel: settings.allowCustomerCancel,
      minHoursBeforeStart: settings.minHoursBeforeCancel,
      forfeitDeposit: settings.forfeitDeposit,
      noShowFeePercent: settings.noShowFeePercent,
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
  if (data.allowCustomerCancel !== undefined) normalized.allowCustomerCancel = data.allowCustomerCancel
  if (data.minHoursBeforeCancel !== undefined) normalized.minHoursBeforeCancel = data.minHoursBeforeCancel
  if (data.minHoursBeforeStart !== undefined) normalized.minHoursBeforeCancel = data.minHoursBeforeStart
  if (data.forfeitDeposit !== undefined) normalized.forfeitDeposit = data.forfeitDeposit
  if (data.noShowFeePercent !== undefined) normalized.noShowFeePercent = data.noShowFeePercent
  if (data.remindersEnabled !== undefined) normalized.remindersEnabled = data.remindersEnabled
  if (data.reminderChannels !== undefined) normalized.reminderChannels = data.reminderChannels
  if (data.reminderMinBefore !== undefined) normalized.reminderMinBefore = data.reminderMinBefore
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
  }

  if (data.cancellation) {
    if (data.cancellation.allowCustomerCancel !== undefined) normalized.allowCustomerCancel = data.cancellation.allowCustomerCancel
    if (data.cancellation.minHoursBeforeStart !== undefined) normalized.minHoursBeforeCancel = data.cancellation.minHoursBeforeStart
    if (data.cancellation.forfeitDeposit !== undefined) normalized.forfeitDeposit = data.cancellation.forfeitDeposit
    if (data.cancellation.noShowFeePercent !== undefined) normalized.noShowFeePercent = data.cancellation.noShowFeePercent
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
    },
    deposits: {
      enabled: false,
      mode: 'none',
      percentageOfTotal: null,
      fixedAmount: null,
      requiredForPartySizeGte: null,
      paymentWindowHrs: null,
    },
    cancellation: {
      allowCustomerCancel: true,
      minHoursBeforeStart: 2,
      forfeitDeposit: false,
      noShowFeePercent: null,
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
    },
    operatingHours: getDefaultOperatingHours(),
  }
}
