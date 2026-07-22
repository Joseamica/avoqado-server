import { Prisma, ReservationStatus } from '@prisma/client'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import prisma from '../../utils/prismaClient'
import { getDefaultOperatingHours, isStaffAware, type OperatingHours, type ReservationConfig } from './reservationSettings.service'
import { BadRequestError } from '../../errors/AppError'
import { findEligibleStaffForDayWindows, isLiveSlotHold } from './appointmentStaffAssignment.service'
import { resolveCanonicalAppointmentDuration } from '../reservation/resolveAppointmentWindow'

// ==========================================
// AVAILABILITY ENGINE — Slot calculation + conflict detection
// ==========================================

export const ACTIVE_RESERVATION_STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN']
// Kept for internal back-compat with code in this file.
const ACTIVE_STATUSES = ACTIVE_RESERVATION_STATUSES

/**
 * Pacing floor for APPOINTMENTS_SERVICE. Tableless studios default pacingMax
 * to null in DB ("unlimited"), which is correct semantics for restaurants
 * (gated by table assignment) but wrong for 1:1 service venues. Floor to 1
 * unless the operator explicitly overrode it (e.g. 3 cabins → 3).
 *
 * `Math.max(1, ...)` clamps the explicit 0 / negative case defensively: a
 * value of 0 would otherwise make every slot unbookable forever.
 */
export function effectiveAppointmentPacing(pacingMaxFromSettings: number | null | undefined): number {
  const fromSettings = pacingMaxFromSettings ?? 1
  return Math.max(1, fromSettings)
}

/**
 * Counts active reservations + active slot-holds overlapping the given
 * [startsAt, endsAt) window for the appointment product space (i.e. excludes
 * class sessions; those have their own per-session capacity check).
 *
 * Used by `createHold` and `createReservation` to enforce per-slot pacing
 * without duplicating the where-clause across files. Pass a transaction
 * client when running inside `prisma.$transaction(...)` so the count is
 * consistent with the surrounding lock.
 */
export async function countAppointmentOccupancy(
  client: Prisma.TransactionClient | typeof prisma,
  args: {
    venueId: string
    startsAt: Date
    endsAt: Date
    excludeHoldId?: string
    excludeReservationId?: string
    checkedAt?: Date
  },
): Promise<{ reservations: number; holds: number }> {
  const checkedAt = args.checkedAt ?? new Date()
  const [reservations, holdRows] = await Promise.all([
    client.reservation.count({
      where: {
        venueId: args.venueId,
        status: { in: ACTIVE_RESERVATION_STATUSES },
        classSessionId: null,
        product: { is: { type: 'APPOINTMENTS_SERVICE' } },
        startsAt: { lt: args.endsAt },
        endsAt: { gt: args.startsAt },
        // Reschedule: don't count the reservation being moved against its own
        // target slot (otherwise a pacing=1 venue blocks itself on an adjacent move).
        ...(args.excludeReservationId ? { id: { not: args.excludeReservationId } } : {}),
      },
    }),
    client.slotHold.findMany({
      where: {
        venueId: args.venueId,
        classSessionId: null,
        expiresAt: { gt: checkedAt },
        startsAt: { lt: args.endsAt },
        endsAt: { gt: args.startsAt },
        ...(args.excludeHoldId ? { id: { not: args.excludeHoldId } } : {}),
      },
      select: {
        expiresAt: true,
        heldForReservationId: true,
        heldForReservation: { select: { status: true } },
      },
    }),
  ])
  return { reservations, holds: holdRows.filter(hold => isLiveSlotHold(hold, checkedAt)).length }
}

export interface SlotOptions {
  duration?: number // minutes
  partySize?: number
  tableId?: string
  staffId?: string
  productId?: string
  productIds?: string[]
  includeFull?: boolean
  windowSemantics?: 'base'
  /** Server-owned reschedule duration. Never populate this from a public query. */
  fixedDurationMin?: number
  /**
   * Reschedule: exclude this reservation from per-slot occupancy so the customer
   * can move to an adjacent/overlapping slot without colliding with their own
   * current booking. Resolved server-side from the cancelSecret.
   */
  excludeReservationId?: string
}

export interface AvailableSlot {
  startsAt: Date
  endsAt: Date
  availableTables: { id: string; number: string; capacity: number }[]
  availableStaff: { id: string; firstName: string; lastName: string }[]
  available?: false
  reason?: 'FULL'
}

export interface ConflictResult {
  hasConflict: boolean
  conflicts: { id: string; confirmationCode: string; startsAt: Date; endsAt: Date; status: ReservationStatus }[]
}

/**
 * Generate available time slots for a given date.
 * Computed on-the-fly (no materialized slots).
 */
export async function getAvailableSlots(
  venueId: string,
  date: Date | string,
  options: SlotOptions,
  moduleConfig: any,
  venueTimezone: string = 'America/Mexico_City',
): Promise<AvailableSlot[]> {
  const checkedAt = new Date()
  const slotInterval = moduleConfig?.scheduling?.slotIntervalMin ?? 15
  const normalizedSettings = {
    ...moduleConfig,
    scheduling: { capacityMode: 'pacing', ...moduleConfig?.scheduling },
    publicBooking: { showStaffPicker: false, ...moduleConfig?.publicBooking },
  } as ReservationConfig
  const staffAware = isStaffAware(normalizedSettings)
  const legacyRescheduleStaffId =
    !staffAware && options.fixedDurationMin !== undefined && options.staffId !== undefined ? options.staffId : undefined
  const requestedProductIds = [
    ...new Set((options.productIds ?? (options.productId ? [options.productId] : [])).map(id => id.trim()).filter(Boolean)),
  ]
  let canonicalProductIds = requestedProductIds
  let defaultDuration: number

  if (options.fixedDurationMin !== undefined) {
    if (!Number.isInteger(options.fixedDurationMin) || options.fixedDurationMin < 1 || options.fixedDurationMin > 1440) {
      throw new BadRequestError('La duración fija debe estar entre 1 y 1440 minutos')
    }
    defaultDuration = options.fixedDurationMin
  } else if (staffAware || options.windowSemantics === 'base') {
    const canonical = await resolveCanonicalAppointmentDuration(prisma, {
      venueId,
      productIds: requestedProductIds,
      settings: normalizedSettings,
    })
    canonicalProductIds = canonical.productIds
    const advisoryDuration = options.duration ?? canonical.canonicalBaseDurationMin
    if (
      !Number.isInteger(advisoryDuration) ||
      advisoryDuration < 1 ||
      advisoryDuration > 1440 ||
      canonical.canonicalBaseDurationMin > 1440
    ) {
      throw new BadRequestError('La duración de la cita debe estar entre 1 y 1440 minutos')
    }
    defaultDuration = Math.max(canonical.canonicalBaseDurationMin, advisoryDuration)
  } else {
    defaultDuration = options.duration ?? moduleConfig?.scheduling?.defaultDurationMin ?? 60
  }
  const onlineCapacityPercent = moduleConfig?.scheduling?.onlineCapacityPercent ?? 100
  const pacingMax = moduleConfig?.scheduling?.pacingMaxPerSlot ?? null

  // Get operating hours for this day of week
  const operatingHours: OperatingHours = moduleConfig?.operatingHours ?? getDefaultOperatingHours()
  const { dateStr, dayKey } = resolveVenueCalendarDate(date, venueTimezone)
  const daySchedule = operatingHours[dayKey]

  if (!daySchedule.enabled || daySchedule.ranges.length === 0) {
    return [] // Venue closed on this day
  }

  // Un slot que ya no se puede reservar (pasado o dentro del aviso mínimo) no
  // debe OFRECERSE: antes solo createReservation lo validaba (422) y los
  // pickers mostraban horas imposibles que morían al confirmar.
  const minNoticeMin = moduleConfig?.scheduling?.minNoticeMin ?? 0
  const earliestBookable = new Date(checkedAt.getTime() + minNoticeMin * 60000)

  // For each time range, generate slot start times (converted to UTC)
  const slotStarts: Date[] = []
  for (const range of daySchedule.ranges) {
    const rangeStart = fromZonedTime(`${dateStr}T${range.open}:00`, venueTimezone)
    const rangeEnd = fromZonedTime(`${dateStr}T${range.close}:00`, venueTimezone)

    const cursor = new Date(rangeStart)
    while (cursor.getTime() + defaultDuration * 60000 <= rangeEnd.getTime()) {
      if (cursor.getTime() >= earliestBookable.getTime()) {
        slotStarts.push(new Date(cursor))
      }
      cursor.setTime(cursor.getTime() + slotInterval * 60000)
    }
  }

  if (slotStarts.length === 0) {
    return []
  }

  // Use the full operating hours range for the reservation query
  const dayStart = slotStarts[0]
  const dayEnd = new Date(slotStarts[slotStarts.length - 1].getTime() + defaultDuration * 60000)

  // Get existing reservations for the date range
  const existingReservations = await prisma.reservation.findMany({
    where: {
      venueId,
      status: { in: ACTIVE_STATUSES },
      startsAt: { lt: dayEnd },
      endsAt: { gt: dayStart },
      // Reschedule self-exclusion: the reservation being moved must not occupy
      // its own target slots (see SlotOptions.excludeReservationId).
      ...(options.excludeReservationId ? { id: { not: options.excludeReservationId } } : {}),
    },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      tableId: true,
      assignedStaffId: true,
      productId: true,
      product: { select: { type: true } },
      partySize: true,
      status: true,
    },
  })

  // Get tables and staff for availability
  const [tables, staff] = await Promise.all([
    prisma.table.findMany({
      where: { venueId, active: true },
      select: { id: true, number: true, capacity: true },
      orderBy: { number: 'asc' },
    }),
    staffAware
      ? Promise.resolve([])
      : prisma.staff.findMany({
          where: {
            ...(legacyRescheduleStaffId !== undefined ? { id: legacyRescheduleStaffId, active: true } : {}),
            venues: { some: { venueId, active: true } },
          },
          select: { id: true, firstName: true, lastName: true },
        }),
  ])

  // Get product capacity if productId specified
  let productCapacity: number | null = null
  let productType: string | null = null
  const leadProductId = options.productId ?? canonicalProductIds[0]
  if (leadProductId) {
    const product = await prisma.product.findFirst({
      where: { id: leadProductId, venueId },
      select: { eventCapacity: true, type: true },
    })
    productType = product?.type ?? null
    if (product?.eventCapacity && productType !== 'APPOINTMENTS_SERVICE') {
      productCapacity = Math.floor((product.eventCapacity * onlineCapacityPercent) / 100)
    }
  }

  // Active slot holds for APPOINTMENTS_SERVICE — counted as soft-reservations
  // so a customer holding a slot via the Square countdown doesn't have it
  // offered to someone else mid-checkout. Classes already gate via
  // ClassSession.capacity, so we skip the lookup for them (and explicitly
  // filter classSessionId:null in case a future feature adds class-side
  // holds — those should not bleed into appointment availability).
  const isAppointment = productType === 'APPOINTMENTS_SERVICE'
  const activeHolds =
    isAppointment || staffAware
      ? await prisma.slotHold.findMany({
          where: {
            venueId,
            classSessionId: null,
            expiresAt: { gt: checkedAt },
            startsAt: { lt: dayEnd },
            endsAt: { gt: dayStart },
          },
          select: {
            startsAt: true,
            endsAt: true,
            expiresAt: true,
            heldForReservationId: true,
            heldForReservation: { select: { status: true } },
          },
        })
      : []

  // External calendar busy blocks (Google Calendar et al.) — merged into the
  // same busy-intervals data structure the per-slot logic uses below.
  // Venue-master blocks always apply; staff-personal blocks only apply when
  // the caller asked for availability scoped to a specific staff member.
  const externalBlocks = staffAware
    ? []
    : await prisma.externalBusyBlock.findMany({
        where: {
          OR: [
            { venueId, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } },
            ...(options.staffId ? [{ staffId: options.staffId, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } }] : []),
          ],
        },
        select: { startsAt: true, endsAt: true, staffId: true, venueId: true },
      })

  const windows = slotStarts.map(startsAt => ({
    startsAt,
    endsAt: new Date(startsAt.getTime() + defaultDuration * 60000),
  }))
  const eligibleStaffByWindow = staffAware
    ? await findEligibleStaffForDayWindows(prisma, {
        venueId,
        canonicalProductIds,
        windows,
        checkedAt,
        settings: normalizedSettings,
        requestedStaffId: options.staffId,
        excludeReservationId: options.excludeReservationId,
      })
    : null

  // Tableless studios (Mindform pattern) have NO resource model gating
  // concurrent appointments — the table-collision logic below is a no-op
  // when tables.length === 0, and pacingMax defaults to null. Without this
  // floor of 1, /availability happily offered the SAME slot to N customers
  // and the controller happily wrote N CONFIRMED reservations for it.
  // Restaurants with tables keep null = unlimited; table assignment is
  // their gate. Venues can opt back to overbooking by setting an explicit
  // pacingMaxPerSlot (e.g. 3 for a studio with 3 cabins).
  const effectivePacing = staffAware
    ? (pacingMax ?? Number.POSITIVE_INFINITY)
    : isAppointment
      ? effectiveAppointmentPacing(pacingMax)
      : pacingMax

  // Evaluate each slot
  const availableSlots: AvailableSlot[] = []

  for (const [slotIndex, slotStart] of slotStarts.entries()) {
    const slotEnd = new Date(slotStart.getTime() + defaultDuration * 60000)

    // Find reservations overlapping this slot
    const overlapping = existingReservations.filter(r => r.startsAt < slotEnd && r.endsAt > slotStart)
    const overlappingHolds = activeHolds.filter(
      hold => isLiveSlotHold(hold, checkedAt) && hold.startsAt < slotEnd && hold.endsAt > slotStart,
    )
    const overlappingAppointments = overlapping.filter(reservation => reservation.product?.type === 'APPOINTMENTS_SERVICE')

    // External calendar busy-block check — a single overlap fully blocks the
    // slot regardless of pacing/capacity (the venue or the requested staff
    // member is unavailable for the entire window). Staff-personal blocks are
    // only considered when the caller asked for a specific staff member;
    // venue-master blocks always apply.
    const overlappingExternal = externalBlocks.some(b => b.startsAt < slotEnd && b.endsAt > slotStart)
    if (overlappingExternal) {
      continue
    }

    // Pacing check: total bookings + active holds in this slot
    const pacingOccupancy = isAppointment || staffAware ? overlappingAppointments.length + overlappingHolds.length : overlapping.length
    const pacingFull = effectivePacing !== null && pacingOccupancy >= effectivePacing
    if (!staffAware && pacingFull) {
      continue
    }

    // Product capacity check (sum partySize, not count reservations)
    if (leadProductId && productCapacity !== null) {
      const productOverlap = overlapping.filter(r => r.productId === leadProductId)
      const occupiedSlots = productOverlap.reduce((sum, r) => sum + r.partySize, 0)
      if (occupiedSlots + (options.partySize ?? 1) > productCapacity) {
        continue
      }
    }

    // Table availability
    let slotAvailableTables = tables
    if (options.tableId) {
      // Check specific table
      const tableConflict = overlapping.some(r => r.tableId === options.tableId)
      if (tableConflict) continue
      slotAvailableTables = tables.filter(
        table => table.id === options.tableId && (!staffAware || options.partySize === undefined || table.capacity >= options.partySize),
      )
      if (staffAware && slotAvailableTables.length === 0) continue
    } else if (options.partySize) {
      // Find tables with sufficient capacity that aren't booked
      const bookedTableIds = new Set(overlapping.map(r => r.tableId).filter(Boolean))
      slotAvailableTables = tables.filter(t => t.capacity >= (options.partySize ?? 1) && !bookedTableIds.has(t.id))
      // Tableless businesses (e.g. studios) should still be able to reserve by product capacity.
      if (tables.length > 0 && slotAvailableTables.length === 0) continue
    } else {
      // No specific table or party size — still filter out booked tables
      const bookedTableIds = new Set(overlapping.map(r => r.tableId).filter(Boolean))
      slotAvailableTables = tables.filter(t => !bookedTableIds.has(t.id))
    }

    // Staff availability
    let slotAvailableStaff
    if (staffAware) {
      slotAvailableStaff = eligibleStaffByWindow?.[slotIndex] ?? []
      if (slotAvailableStaff.length === 0) continue
    } else if (options.staffId) {
      const staffConflict = overlapping.some(r => r.assignedStaffId === options.staffId)
      if (staffConflict) continue
      slotAvailableStaff = staff.filter(s => s.id === options.staffId)
    } else {
      const busyStaffIds = new Set(overlapping.map(r => r.assignedStaffId).filter(Boolean))
      slotAvailableStaff = staff.filter(s => !busyStaffIds.has(s.id))
    }
    if (legacyRescheduleStaffId !== undefined && slotAvailableStaff.length === 0) continue

    if (staffAware && pacingFull) {
      if (options.includeFull === true) {
        availableSlots.push({
          startsAt: slotStart,
          endsAt: slotEnd,
          availableTables: slotAvailableTables,
          availableStaff: slotAvailableStaff,
          available: false,
          reason: 'FULL',
        })
      }
      continue
    }

    availableSlots.push({
      startsAt: slotStart,
      endsAt: slotEnd,
      availableTables: slotAvailableTables,
      availableStaff: slotAvailableStaff,
    })
  }

  return availableSlots
}

function resolveVenueCalendarDate(
  date: Date | string,
  venueTimezone: string,
): { dateStr: string; dayKey: 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' } {
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

  if (typeof date === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (match) {
      const year = Number(match[1])
      const month = Number(match[2])
      const day = Number(match[3])
      const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
      return {
        dateStr: `${match[1]}-${match[2]}-${match[3]}`,
        dayKey: dayNames[utcDay],
      }
    }
  }

  const parsed = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError('Fecha de disponibilidad invalida')
  }

  const venueDate = toZonedTime(parsed, venueTimezone)
  const yyyy = venueDate.getFullYear()
  const mm = String(venueDate.getMonth() + 1).padStart(2, '0')
  const dd = String(venueDate.getDate()).padStart(2, '0')

  return {
    dateStr: `${yyyy}-${mm}-${dd}`,
    dayKey: dayNames[venueDate.getDay()],
  }
}

// ==========================================
// CLASS SESSION SLOTS — For CLASS products
// ==========================================

export interface ClassSlot {
  classSessionId: string
  startsAt: Date
  endsAt: Date
  duration: number
  capacity: number
  enrolled: number
  remaining: number
  available: boolean
  takenSpotIds: string[]
  instructor?: { firstName: string; lastName: string } | null
}

/**
 * Generate available slots for a CLASS product from its ClassSession records.
 * Unlike operating-hours-based slots, these come directly from the sessions the venue has created.
 */
export async function getClassSessionSlots(
  venueId: string,
  productId: string,
  date: Date | string,
  onlineCapacityPercent: number,
  venueTimezone: string = 'America/Mexico_City',
): Promise<ClassSlot[]> {
  const { dateStr } = resolveVenueCalendarDate(date, venueTimezone)

  // Date range for the requested day in venue timezone
  const dayStart = fromZonedTime(`${dateStr}T00:00:00`, venueTimezone)
  const dayEnd = fromZonedTime(`${dateStr}T23:59:59.999`, venueTimezone)

  const sessions = await prisma.classSession.findMany({
    where: {
      venueId,
      productId,
      status: 'SCHEDULED',
      startsAt: { gte: dayStart, lte: dayEnd },
    },
    include: {
      assignedStaff: {
        select: { firstName: true, lastName: true },
      },
      reservations: {
        where: { status: { in: ACTIVE_STATUSES } },
        select: { partySize: true, spotIds: true },
      },
    },
    orderBy: { startsAt: 'asc' },
  })

  return sessions.map(session => {
    const enrolled = session.reservations.reduce((sum, r) => sum + r.partySize, 0)
    const effectiveCapacity = Math.floor((session.capacity * onlineCapacityPercent) / 100)
    const remaining = Math.max(0, effectiveCapacity - enrolled)

    // Collect all taken spot IDs across active reservations
    const takenSpotIds: string[] = []
    for (const r of session.reservations) {
      if (r.spotIds && r.spotIds.length > 0) {
        takenSpotIds.push(...r.spotIds)
      }
    }

    return {
      classSessionId: session.id,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      duration: session.duration,
      capacity: effectiveCapacity,
      enrolled,
      remaining,
      available: remaining > 0,
      takenSpotIds,
      instructor: session.assignedStaff ?? null,
    }
  })
}

/**
 * Check if a proposed time range conflicts with existing reservations.
 */
export async function checkConflicts(
  venueId: string,
  startsAt: Date,
  endsAt: Date,
  options: { tableId?: string; staffId?: string; excludeReservationId?: string },
): Promise<ConflictResult> {
  const where: any = {
    venueId,
    status: { in: ACTIVE_STATUSES },
    startsAt: { lt: endsAt },
    endsAt: { gt: startsAt },
  }

  if (options.tableId) where.tableId = options.tableId
  if (options.staffId) where.assignedStaffId = options.staffId
  if (options.excludeReservationId) where.id = { not: options.excludeReservationId }

  const conflicts = await prisma.reservation.findMany({
    where,
    select: {
      id: true,
      confirmationCode: true,
      startsAt: true,
      endsAt: true,
      status: true,
    },
  })

  return {
    hasConflict: conflicts.length > 0,
    conflicts,
  }
}
