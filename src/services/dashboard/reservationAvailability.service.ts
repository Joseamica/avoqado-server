import { ReservationStatus } from '@prisma/client'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import prisma from '../../utils/prismaClient'
import { getDefaultOperatingHours, type OperatingHours } from './reservationSettings.service'
import { BadRequestError } from '../../errors/AppError'

// ==========================================
// AVAILABILITY ENGINE — Slot calculation + conflict detection
// ==========================================

const ACTIVE_STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN']

export interface SlotOptions {
  duration?: number // minutes
  partySize?: number
  tableId?: string
  staffId?: string
  productId?: string
}

export interface AvailableSlot {
  startsAt: Date
  endsAt: Date
  availableTables: { id: string; number: string; capacity: number }[]
  availableStaff: { id: string; firstName: string; lastName: string }[]
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
  const slotInterval = moduleConfig?.scheduling?.slotIntervalMin ?? 15
  const defaultDuration = options.duration ?? moduleConfig?.scheduling?.defaultDurationMin ?? 60
  const onlineCapacityPercent = moduleConfig?.scheduling?.onlineCapacityPercent ?? 100
  const pacingMax = moduleConfig?.scheduling?.pacingMaxPerSlot ?? null

  // Get operating hours for this day of week
  const operatingHours: OperatingHours = moduleConfig?.operatingHours ?? getDefaultOperatingHours()
  const { dateStr, dayKey } = resolveVenueCalendarDate(date, venueTimezone)
  const daySchedule = operatingHours[dayKey]

  if (!daySchedule.enabled || daySchedule.ranges.length === 0) {
    return [] // Venue closed on this day
  }

  // For each time range, generate slot start times (converted to UTC)
  const slotStarts: Date[] = []
  for (const range of daySchedule.ranges) {
    const rangeStart = fromZonedTime(new Date(`${dateStr}T${range.open}:00`), venueTimezone)
    const rangeEnd = fromZonedTime(new Date(`${dateStr}T${range.close}:00`), venueTimezone)

    const cursor = new Date(rangeStart)
    while (cursor.getTime() + defaultDuration * 60000 <= rangeEnd.getTime()) {
      slotStarts.push(new Date(cursor))
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
    },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      tableId: true,
      assignedStaffId: true,
      productId: true,
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
    prisma.staff.findMany({
      where: {
        venues: { some: { venueId, active: true } },
      },
      select: { id: true, firstName: true, lastName: true },
    }),
  ])

  // Get product capacity if productId specified
  let productCapacity: number | null = null
  if (options.productId) {
    const product = await prisma.product.findFirst({
      where: { id: options.productId, venueId },
      select: { eventCapacity: true },
    })
    if (product?.eventCapacity) {
      productCapacity = Math.floor((product.eventCapacity * onlineCapacityPercent) / 100)
    }
  }

  // Evaluate each slot
  const availableSlots: AvailableSlot[] = []

  for (const slotStart of slotStarts) {
    const slotEnd = new Date(slotStart.getTime() + defaultDuration * 60000)

    // Find reservations overlapping this slot
    const overlapping = existingReservations.filter(r => r.startsAt < slotEnd && r.endsAt > slotStart)

    // Pacing check: total bookings in this slot
    if (pacingMax !== null && overlapping.length >= pacingMax) {
      continue
    }

    // Product capacity check (sum partySize, not count reservations)
    if (options.productId && productCapacity !== null) {
      const productOverlap = overlapping.filter(r => r.productId === options.productId)
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
      slotAvailableTables = tables.filter(t => t.id === options.tableId)
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
    let slotAvailableStaff = staff
    if (options.staffId) {
      const staffConflict = overlapping.some(r => r.assignedStaffId === options.staffId)
      if (staffConflict) continue
      slotAvailableStaff = staff.filter(s => s.id === options.staffId)
    } else {
      const busyStaffIds = new Set(overlapping.map(r => r.assignedStaffId).filter(Boolean))
      slotAvailableStaff = staff.filter(s => !busyStaffIds.has(s.id))
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
