import { Prisma, type ReservationStatus } from '@prisma/client'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { resolveCanonicalAppointmentDuration } from '@/services/reservation/resolveAppointmentWindow'
import { checkExternalBusyBlock } from '@/services/reservation/external-busy-block.service'
import type { OperatingHours, ReservationConfig } from './reservationSettings.service'

const ACTIVE_RESERVATION_STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN']
const LIVE_RESCHEDULE_PARENT_STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED']
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface LiveSlotHoldInput {
  expiresAt: Date
  heldForReservationId: string | null
  heldForReservation?: { status: string } | null
}

export interface StaffScheduleExceptionWindow {
  startDate: string
  endDate: string
  kind: string
  startTime?: string | null
  endTime?: string | null
}

export interface OrganizationStaffAvailabilityArgs {
  organizationId: string
  staffId: string
  startsAt: Date
  endsAt: Date
  checkedAt: Date
  excludeReservationId?: string
  excludeHoldId?: string
  excludeClassSessionId?: string
}

export interface StaffEligibilityArgs {
  venueId: string
  staffId: string
  productIds: string[]
  startsAt: Date
  endsAt: Date
  checkedAt: Date
  settings: ReservationConfig
  excludeReservationId?: string
  excludeHoldId?: string
}

export interface ResolveStaffAssignmentArgs {
  venueId: string
  productIds: string[]
  startsAt: Date
  endsAt: Date
  checkedAt: Date
  settings: ReservationConfig
  requestedStaffId?: string
  excludeReservationId?: string
  excludeHoldId?: string
}

interface TimeInterval {
  startsAt: Date
  endsAt: Date
}

interface AllocationCandidate {
  id: string
  staffId: string
  startDate: Date
  venue: { organizationId: string; timezone: string }
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function assertValidWindow(startsAt: Date, endsAt: Date, checkedAt?: Date): void {
  if (!validDate(startsAt) || !validDate(endsAt) || startsAt.getTime() >= endsAt.getTime() || (checkedAt && !validDate(checkedAt))) {
    throw new BadRequestError('La ventana de la cita es inválida')
  }
}

function genericBusy(): ConflictError {
  return new ConflictError('El profesionista no está disponible en ese horario')
}

function noAvailableStaff(): ConflictError {
  return new ConflictError('No hay profesionistas disponibles para este horario')
}

function timeRangeToInterval(localDate: string, timezone: string, open: unknown, close: unknown): TimeInterval | null {
  if (typeof open !== 'string' || typeof close !== 'string' || !TIME_PATTERN.test(open) || !TIME_PATTERN.test(close) || close <= open) {
    return null
  }
  const startsAt = fromZonedTime(`${localDate}T${open}:00`, timezone)
  const endsAt = fromZonedTime(`${localDate}T${close}:00`, timezone)
  if (!validDate(startsAt) || !validDate(endsAt) || startsAt.getTime() >= endsAt.getTime()) return null
  return { startsAt, endsAt }
}

function normalizedIntervals(intervals: TimeInterval[]): TimeInterval[] {
  const ordered = [...intervals].sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime())
  const result: TimeInterval[] = []
  for (const interval of ordered) {
    const previous = result[result.length - 1]
    if (!previous || interval.startsAt.getTime() > previous.endsAt.getTime()) {
      result.push({ ...interval })
    } else if (interval.endsAt.getTime() > previous.endsAt.getTime()) {
      previous.endsAt = interval.endsAt
    }
  }
  return result
}

function scheduleDayIntervals(schedule: OperatingHours, weekday: string, localDate: string, timezone: string): TimeInterval[] | null {
  if (!schedule || typeof schedule !== 'object') return null
  const day = (schedule as unknown as Record<string, unknown>)[weekday]
  if (!day || typeof day !== 'object') return null
  const candidate = day as { enabled?: unknown; ranges?: unknown }
  if (typeof candidate.enabled !== 'boolean' || !Array.isArray(candidate.ranges)) return null
  if (!candidate.enabled) return []

  const intervals: TimeInterval[] = []
  for (const range of candidate.ranges) {
    if (!range || typeof range !== 'object') return null
    const persisted = range as { open?: unknown; close?: unknown }
    const interval = timeRangeToInterval(localDate, timezone, persisted.open, persisted.close)
    if (!interval) return null
    intervals.push(interval)
  }
  return intervals
}

function isValidLocalDate(value: string): boolean {
  if (!LOCAL_DATE_PATTERN.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

function isValidPersistedException(exception: StaffScheduleExceptionWindow): boolean {
  if (!isValidLocalDate(exception.startDate) || !isValidLocalDate(exception.endDate) || exception.endDate < exception.startDate)
    return false
  if (exception.kind === 'OFF') return exception.startTime == null && exception.endTime == null
  if (exception.kind !== 'HOURS') return false
  return (
    typeof exception.startTime === 'string' &&
    typeof exception.endTime === 'string' &&
    TIME_PATTERN.test(exception.startTime) &&
    TIME_PATTERN.test(exception.endTime) &&
    exception.endTime > exception.startTime
  )
}

export function isLiveSlotHold(hold: LiveSlotHoldInput, checkedAt: Date): boolean {
  if (!validDate(hold.expiresAt) || !validDate(checkedAt) || hold.expiresAt.getTime() <= checkedAt.getTime()) return false
  if (hold.heldForReservationId === null) return true
  return Boolean(hold.heldForReservation && LIVE_RESCHEDULE_PARENT_STATUSES.includes(hold.heldForReservation.status as ReservationStatus))
}

export function staffScheduleAllowsWindow(args: {
  startsAt: Date
  endsAt: Date
  timezone: string
  weekly: OperatingHours | null
  exceptions: StaffScheduleExceptionWindow[]
  venueOperatingHours: OperatingHours
}): boolean {
  try {
    if (!validDate(args.startsAt) || !validDate(args.endsAt) || args.startsAt.getTime() >= args.endsAt.getTime()) return false
    const localDate = formatInTimeZone(args.startsAt, args.timezone, 'yyyy-MM-dd')
    const weekday = formatInTimeZone(args.startsAt, args.timezone, 'EEEE').toLowerCase()
    if (!Array.isArray(args.exceptions) || args.exceptions.some(exception => !isValidPersistedException(exception))) return false
    const applicable = args.exceptions.filter(exception => exception.startDate <= localDate && exception.endDate >= localDate)

    if (applicable.some(exception => exception.kind === 'OFF')) return false
    const hourExceptions = applicable.filter(exception => exception.kind === 'HOURS')
    let intervals: TimeInterval[] | null
    if (hourExceptions.length > 0) {
      intervals = []
      for (const exception of hourExceptions) {
        const interval = timeRangeToInterval(localDate, args.timezone, exception.startTime, exception.endTime)
        if (!interval) return false
        intervals.push(interval)
      }
    } else {
      intervals = scheduleDayIntervals(args.weekly ?? args.venueOperatingHours, weekday, localDate, args.timezone)
    }
    if (!intervals) return false

    return normalizedIntervals(intervals).some(
      interval => interval.startsAt.getTime() <= args.startsAt.getTime() && interval.endsAt.getTime() >= args.endsAt.getTime(),
    )
  } catch {
    return false
  }
}

export function shouldAutoAssign(isAppointmentService: boolean, settings: ReservationConfig): boolean {
  return isAppointmentService && (settings.scheduling.capacityMode === 'per_staff' || settings.publicBooking.showStaffPicker === true)
}

export async function lockAppointmentVenue(tx: Prisma.TransactionClient, venueId: string): Promise<void> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'apt-hold:' + venueId}))`
}

export async function assertOrganizationStaffAvailability(
  tx: Prisma.TransactionClient,
  args: OrganizationStaffAvailabilityArgs,
): Promise<void> {
  assertValidWindow(args.startsAt, args.endsAt, args.checkedAt)
  const memberships = await tx.staffVenue.findMany({
    where: { staffId: args.staffId, venue: { organizationId: args.organizationId } },
    select: { venueId: true },
  })
  const venueIds = [...new Set(memberships.map(membership => membership.venueId))]
  const overlap = { startsAt: { lt: args.endsAt }, endsAt: { gt: args.startsAt } }

  const [reservation, classSession, hold, personalBlock] = await Promise.all([
    tx.reservation.findFirst({
      where: {
        assignedStaffId: args.staffId,
        venueId: { in: venueIds },
        status: { in: ACTIVE_RESERVATION_STATUSES },
        ...overlap,
        ...(args.excludeReservationId && { id: { not: args.excludeReservationId } }),
      },
      select: { id: true },
    }),
    tx.classSession.findFirst({
      where: {
        assignedStaffId: args.staffId,
        venueId: { in: venueIds },
        status: 'SCHEDULED',
        ...overlap,
        ...(args.excludeClassSessionId && { id: { not: args.excludeClassSessionId } }),
      },
      select: { id: true },
    }),
    tx.slotHold.findFirst({
      where: {
        staffId: args.staffId,
        venueId: { in: venueIds },
        ...overlap,
        expiresAt: { gt: args.checkedAt },
        OR: [{ heldForReservationId: null }, { heldForReservation: { status: { in: LIVE_RESCHEDULE_PARENT_STATUSES } } }],
        ...(args.excludeHoldId && { id: { not: args.excludeHoldId } }),
      },
      select: { id: true },
    }),
    tx.externalBusyBlock.findFirst({
      where: { staffId: args.staffId, ...overlap },
      select: { id: true },
    }),
  ])

  if (reservation || classSession || hold || personalBlock) throw genericBusy()
}

async function loadExplicitMembership(tx: Prisma.TransactionClient, venueId: string, staffId: string) {
  return tx.staffVenue.findFirst({
    where: { venueId, staffId, active: true, staff: { active: true } },
    select: {
      id: true,
      staffId: true,
      startDate: true,
      venue: { select: { organizationId: true, timezone: true } },
    },
  })
}

export async function assertStaffEligible(tx: Prisma.TransactionClient, args: StaffEligibilityArgs): Promise<void> {
  assertValidWindow(args.startsAt, args.endsAt, args.checkedAt)
  const member = await loadExplicitMembership(tx, args.venueId, args.staffId)
  if (!member) throw genericBusy()

  const canonical = await resolveCanonicalAppointmentDuration(tx, {
    venueId: args.venueId,
    productIds: args.productIds,
    settings: args.settings,
  })
  const mappings = await tx.productStaff.findMany({
    where: {
      venueId: args.venueId,
      staffVenueId: member.id,
      productId: { in: canonical.productIds },
    },
    select: { productId: true },
  })
  if (new Set(mappings.map(mapping => mapping.productId)).size !== canonical.productIds.length) throw genericBusy()

  const localDate = formatInTimeZone(args.startsAt, member.venue.timezone, 'yyyy-MM-dd')
  const [schedule, exceptions] = await Promise.all([
    tx.staffSchedule.findFirst({
      where: { staffVenueId: member.id, venueId: args.venueId },
      select: { weekly: true },
    }),
    tx.staffScheduleException.findMany({
      where: {
        staffVenueId: member.id,
        venueId: args.venueId,
        startDate: { lte: localDate },
        endDate: { gte: localDate },
      },
      select: { startDate: true, endDate: true, kind: true, startTime: true, endTime: true },
    }),
  ])
  if (
    !staffScheduleAllowsWindow({
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      timezone: member.venue.timezone,
      weekly: (schedule?.weekly as unknown as OperatingHours | undefined) ?? null,
      exceptions,
      venueOperatingHours: args.settings.operatingHours,
    })
  ) {
    throw genericBusy()
  }

  const venueMasterBlock = await checkExternalBusyBlock(tx, {
    venueId: args.venueId,
    staffId: null,
    startsAt: args.startsAt,
    endsAt: args.endsAt,
  })
  if (venueMasterBlock) throw genericBusy()

  await assertOrganizationStaffAvailability(tx, {
    organizationId: member.venue.organizationId,
    staffId: member.staffId,
    startsAt: args.startsAt,
    endsAt: args.endsAt,
    checkedAt: args.checkedAt,
    excludeReservationId: args.excludeReservationId,
    excludeHoldId: args.excludeHoldId,
  })
}

function candidateConflictOr(
  candidates: AllocationCandidate[],
  venuesByStaff: Map<string, string[]>,
  staffField: 'assignedStaffId' | 'staffId',
) {
  return candidates.map(candidate => ({
    [staffField]: candidate.staffId,
    venueId: { in: venuesByStaff.get(candidate.staffId) ?? [] },
  }))
}

function nextLocalDate(localDate: string): string {
  const [year, month, day] = localDate.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

export async function resolveStaffAssignment(tx: Prisma.TransactionClient, args: ResolveStaffAssignmentArgs): Promise<string> {
  assertValidWindow(args.startsAt, args.endsAt, args.checkedAt)

  if (args.requestedStaffId) {
    await assertStaffEligible(tx, { ...args, staffId: args.requestedStaffId })
    return args.requestedStaffId
  }

  const canonical = await resolveCanonicalAppointmentDuration(tx, {
    venueId: args.venueId,
    productIds: args.productIds,
    settings: args.settings,
  })
  const candidates = (await tx.staffVenue.findMany({
    where: { venueId: args.venueId, active: true, staff: { active: true } },
    select: {
      id: true,
      staffId: true,
      startDate: true,
      venue: { select: { organizationId: true, timezone: true } },
    },
  })) as AllocationCandidate[]
  if (candidates.length === 0) throw noAvailableStaff()

  const timezone = candidates[0].venue.timezone
  const organizationId = candidates[0].venue.organizationId
  const localDate = formatInTimeZone(args.startsAt, timezone, 'yyyy-MM-dd')
  const staffIds = candidates.map(candidate => candidate.staffId)
  const staffVenueIds = candidates.map(candidate => candidate.id)

  const [mappings, schedules, exceptions, organizationMemberships, venueMasterBlock] = await Promise.all([
    tx.productStaff.findMany({
      where: { venueId: args.venueId, staffVenueId: { in: staffVenueIds }, productId: { in: canonical.productIds } },
      select: { productId: true, staffVenueId: true },
    }),
    tx.staffSchedule.findMany({
      where: { venueId: args.venueId, staffVenueId: { in: staffVenueIds } },
      select: { staffVenueId: true, weekly: true },
    }),
    tx.staffScheduleException.findMany({
      where: {
        venueId: args.venueId,
        staffVenueId: { in: staffVenueIds },
        startDate: { lte: localDate },
        endDate: { gte: localDate },
      },
      select: { staffVenueId: true, startDate: true, endDate: true, kind: true, startTime: true, endTime: true },
    }),
    tx.staffVenue.findMany({
      where: { staffId: { in: staffIds }, venue: { organizationId } },
      select: { staffId: true, venueId: true },
    }),
    checkExternalBusyBlock(tx, {
      venueId: args.venueId,
      staffId: null,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
    }),
  ])
  if (venueMasterBlock) throw noAvailableStaff()

  const venuesByStaff = new Map<string, string[]>()
  for (const membership of organizationMemberships) {
    const venueIds = venuesByStaff.get(membership.staffId) ?? []
    if (!venueIds.includes(membership.venueId)) venueIds.push(membership.venueId)
    venuesByStaff.set(membership.staffId, venueIds)
  }
  const overlap = { startsAt: { lt: args.endsAt }, endsAt: { gt: args.startsAt } }

  const [reservations, classes, holds, personalBlocks, dailyCounts] = await Promise.all([
    tx.reservation.findMany({
      where: {
        OR: candidateConflictOr(candidates, venuesByStaff, 'assignedStaffId'),
        status: { in: ACTIVE_RESERVATION_STATUSES },
        ...overlap,
        ...(args.excludeReservationId && { id: { not: args.excludeReservationId } }),
      },
      select: { assignedStaffId: true },
    }),
    tx.classSession.findMany({
      where: {
        OR: candidateConflictOr(candidates, venuesByStaff, 'assignedStaffId'),
        status: 'SCHEDULED',
        ...overlap,
      },
      select: { assignedStaffId: true },
    }),
    tx.slotHold.findMany({
      where: {
        OR: candidateConflictOr(candidates, venuesByStaff, 'staffId'),
        ...overlap,
        expiresAt: { gt: args.checkedAt },
        ...(args.excludeHoldId && { id: { not: args.excludeHoldId } }),
      },
      select: {
        staffId: true,
        expiresAt: true,
        heldForReservationId: true,
        heldForReservation: { select: { status: true } },
      },
    }),
    tx.externalBusyBlock.findMany({
      where: { staffId: { in: staffIds }, ...overlap },
      select: { staffId: true },
    }),
    tx.reservation.groupBy({
      by: ['assignedStaffId'],
      where: {
        venueId: args.venueId,
        assignedStaffId: { in: staffIds },
        status: { in: ACTIVE_RESERVATION_STATUSES },
        startsAt: {
          gte: fromZonedTime(`${localDate}T00:00:00`, timezone),
          lt: fromZonedTime(`${nextLocalDate(localDate)}T00:00:00`, timezone),
        },
        ...(args.excludeReservationId && { id: { not: args.excludeReservationId } }),
      },
      _count: { _all: true },
    }),
  ])

  const mappingsByMember = new Map<string, Set<string>>()
  for (const mapping of mappings) {
    const productIds = mappingsByMember.get(mapping.staffVenueId) ?? new Set<string>()
    productIds.add(mapping.productId)
    mappingsByMember.set(mapping.staffVenueId, productIds)
  }
  const scheduleByMember = new Map(schedules.map(schedule => [schedule.staffVenueId, schedule.weekly]))
  const exceptionsByMember = new Map<string, StaffScheduleExceptionWindow[]>()
  for (const exception of exceptions) {
    const memberExceptions = exceptionsByMember.get(exception.staffVenueId) ?? []
    memberExceptions.push(exception)
    exceptionsByMember.set(exception.staffVenueId, memberExceptions)
  }

  const busyStaff = new Set<string>()
  for (const reservation of reservations) if (reservation.assignedStaffId) busyStaff.add(reservation.assignedStaffId)
  for (const classSession of classes) if (classSession.assignedStaffId) busyStaff.add(classSession.assignedStaffId)
  for (const hold of holds) {
    if (hold.staffId && isLiveSlotHold(hold, args.checkedAt)) busyStaff.add(hold.staffId)
  }
  for (const block of personalBlocks) if (block.staffId) busyStaff.add(block.staffId)

  const counts = new Map<string, number>()
  for (const row of dailyCounts) {
    if (row.assignedStaffId) counts.set(row.assignedStaffId, row._count._all)
  }

  const eligible = candidates.filter(candidate => {
    if ((mappingsByMember.get(candidate.id)?.size ?? 0) !== canonical.productIds.length) return false
    if (busyStaff.has(candidate.staffId)) return false
    return staffScheduleAllowsWindow({
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      timezone: candidate.venue.timezone,
      weekly: (scheduleByMember.get(candidate.id) as unknown as OperatingHours | undefined) ?? null,
      exceptions: exceptionsByMember.get(candidate.id) ?? [],
      venueOperatingHours: args.settings.operatingHours,
    })
  })
  eligible.sort((left, right) => {
    const countDifference = (counts.get(left.staffId) ?? 0) - (counts.get(right.staffId) ?? 0)
    if (countDifference !== 0) return countDifference
    const startDifference = left.startDate.getTime() - right.startDate.getTime()
    if (startDifference !== 0) return startDifference
    return left.id.localeCompare(right.id)
  })

  if (!eligible[0]) throw noAvailableStaff()
  return eligible[0].staffId
}
