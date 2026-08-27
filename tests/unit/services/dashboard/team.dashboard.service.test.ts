/**
 * Team Dashboard Service Tests
 *
 * Regression: the venue "Equipo" list (GET /dashboard/venues/:venueId/team →
 * getTeamMembers) queried StaffVenue by venueId only, so staff removed from the
 * org (StaffOrganization.isActive=false via removeFromOrganization / the
 * ex-collaborator cleanup) kept appearing. The fix filters on the venue's org
 * membership being active, while keeping venue-deactivated members (StaffVenue.active
 * =false, isActive stays true) visible so they can be reactivated.
 * See Asana 1215884464715725.
 */

import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/dashboard/appointmentStaffAssignment.service', () => ({
  ...jest.requireActual('@/services/dashboard/appointmentStaffAssignment.service'),
  lockAppointmentVenue: jest.fn(),
}))

import {
  getTeamMembers,
  updateTeamMember,
  inviteTeamMember,
  hardDeleteTeamMember,
  getDeactivationImpact,
} from '@/services/dashboard/team.dashboard.service'
import { StaffRole } from '@prisma/client'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'
import { lockAppointmentVenue } from '@/services/dashboard/appointmentStaffAssignment.service'

const VENUE_ID = 'venue-1'
const ORG_ID = 'org-1'
const TEAM_MEMBER_ID = 'staff-venue-1'
const STAFF_ID = 'staff-1'
const HARD_DELETE_CONFLICT_MESSAGE = 'El miembro del equipo tiene compromisos futuros activos y no puede eliminarse'

const loggerInfoMock = logger.info as jest.MockedFunction<typeof logger.info>
const lockAppointmentVenueMock = lockAppointmentVenue as jest.MockedFunction<typeof lockAppointmentVenue>

const ACTIVE_ORG_MEMBER_FILTER = {
  staff: { organizations: { some: { organizationId: ORG_ID, isActive: true } } },
}

describe('getTeamMembers', () => {
  beforeEach(() => {
    // getTeamMembers uses the ARRAY form of $transaction; the global mock only
    // handles the callback form, so support arrays here.
    prismaMock.$transaction.mockImplementation((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prismaMock)))
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORG_ID } as any)
    prismaMock.staffVenue.findMany.mockResolvedValue([])
    prismaMock.staffVenue.count.mockResolvedValue(0)
    prismaMock.order.groupBy.mockResolvedValue([] as any)
    prismaMock.payment.groupBy.mockResolvedValue([] as any)
  })

  it('hides org-removed members by filtering on the active org membership', async () => {
    await getTeamMembers(VENUE_ID, 1, 10)

    // The org-member filter is the fix: without it, staff with
    // StaffOrganization.isActive=false leak into the venue team list.
    expect(prismaMock.staffVenue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: VENUE_ID, ...ACTIVE_ORG_MEMBER_FILTER }),
      }),
    )
    // count must use the SAME where so pagination totals match the rows returned.
    expect(prismaMock.staffVenue.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: VENUE_ID, ...ACTIVE_ORG_MEMBER_FILTER }),
      }),
    )
  })

  it('still applies the org-member filter alongside a search term', async () => {
    await getTeamMembers(VENUE_ID, 1, 10, 'lopez')

    expect(prismaMock.staffVenue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: VENUE_ID,
          ...ACTIVE_ORG_MEMBER_FILTER,
          OR: expect.any(Array),
        }),
      }),
    )
  })
})

/**
 * SECURITY regression: role-assignment privilege escalation.
 * A MANAGER (who holds teams:update / teams:invite by default) must NOT be able to
 * promote themselves or anyone to a role at/above their own level, nor assign
 * SUPERADMIN. `callerRole` is the caller's role RESOLVED for the venue (threaded
 * from req.resolvedRole by the controller). When absent (internal callers) the
 * guard is skipped, so existing invite/update tests are unaffected.
 */
describe('updateTeamMember — privilege-escalation guard', () => {
  const existingManager = {
    id: 'sv-mgr',
    venueId: VENUE_ID,
    staffId: 'staff-mgr',
    role: StaffRole.MANAGER,
    active: true,
    staff: { id: 'staff-mgr', firstName: 'M', lastName: 'X' },
  }

  beforeEach(() => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(existingManager as any)
  })

  it('blocks a MANAGER from promoting themselves to OWNER (self-promotion vector)', async () => {
    await expect(updateTeamMember(VENUE_ID, 'sv-mgr', { role: StaffRole.OWNER, callerRole: StaffRole.MANAGER })).rejects.toThrow(
      /No puedes asignar el rol/i,
    )
  })

  it('blocks a MANAGER from promoting a member to ADMIN', async () => {
    await expect(updateTeamMember(VENUE_ID, 'sv-mgr', { role: StaffRole.ADMIN, callerRole: StaffRole.MANAGER })).rejects.toThrow(
      /No puedes asignar el rol/i,
    )
  })

  it('still blocks assigning SUPERADMIN outright', async () => {
    await expect(updateTeamMember(VENUE_ID, 'sv-mgr', { role: StaffRole.SUPERADMIN, callerRole: StaffRole.OWNER })).rejects.toThrow(
      /SUPERADMIN/i,
    )
  })
})

describe('inviteTeamMember — privilege-escalation guard', () => {
  it('blocks a MANAGER from inviting an OWNER', async () => {
    await expect(
      inviteTeamMember(VENUE_ID, 'inviter', {
        firstName: 'A',
        lastName: 'B',
        role: StaffRole.OWNER,
        callerRole: StaffRole.MANAGER,
      }),
    ).rejects.toThrow(/No puedes invitar con el rol/i)
  })

  it('blocks a MANAGER from inviting an ADMIN', async () => {
    await expect(
      inviteTeamMember(VENUE_ID, 'inviter', {
        firstName: 'A',
        lastName: 'B',
        role: StaffRole.ADMIN,
        callerRole: StaffRole.MANAGER,
      }),
    ).rejects.toThrow(/No puedes invitar con el rol/i)
  })

  it('still blocks inviting SUPERADMIN regardless of caller role', async () => {
    await expect(
      inviteTeamMember(VENUE_ID, 'inviter', {
        firstName: 'A',
        lastName: 'B',
        role: StaffRole.SUPERADMIN,
        callerRole: StaffRole.OWNER,
      }),
    ).rejects.toThrow(/SUPERADMIN/i)
  })
})

type StoredHold = {
  venueId: string
  staffId: string
  startsAt: Date
  endsAt: Date
  expiresAt: Date
  heldForReservationId: string | null
  heldForReservation: { status: string } | null
}

const makeStoredHold = (overrides: Partial<StoredHold> = {}): StoredHold => ({
  venueId: VENUE_ID,
  staffId: STAFF_ID,
  startsAt: new Date('2030-01-01T10:00:00.000Z'),
  endsAt: new Date('2030-01-01T11:00:00.000Z'),
  expiresAt: new Date('2030-01-01T09:30:00.000Z'),
  heldForReservationId: null,
  heldForReservation: null,
  ...overrides,
})

function mockStoredHolds(rows: StoredHold[]): void {
  prismaMock.slotHold.findMany.mockImplementation(async ({ where }: any) =>
    rows
      .filter(
        row =>
          row.venueId === where.venueId &&
          row.staffId === where.staffId &&
          row.endsAt.getTime() > where.endsAt.gt.getTime() &&
          row.expiresAt.getTime() > where.expiresAt.gt.getTime(),
      )
      .map(row => ({
        expiresAt: row.expiresAt,
        heldForReservationId: row.heldForReservationId,
        heldForReservation: row.heldForReservation,
      })),
  )
}

function expectNoHardDeleteWrites(): void {
  expect(prismaMock.commissionPayout.deleteMany).not.toHaveBeenCalled()
  expect(prismaMock.commissionCalculation.deleteMany).not.toHaveBeenCalled()
  expect(prismaMock.milestoneAchievement.deleteMany).not.toHaveBeenCalled()
  expect(prismaMock.commissionOverride.deleteMany).not.toHaveBeenCalled()
  expect(prismaMock.staffVenue.delete).not.toHaveBeenCalled()
  expect(prismaMock.staff.delete).not.toHaveBeenCalled()
}

describe('hardDeleteTeamMember — future commitment safety', () => {
  beforeEach(() => {
    prismaMock.$transaction.mockReset().mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.$queryRaw.mockReset().mockResolvedValue([{ id: TEAM_MEMBER_ID, staffId: STAFF_ID }])
    prismaMock.staffVenue.findFirst.mockReset()
    prismaMock.reservation.findFirst.mockReset().mockResolvedValue(null)
    prismaMock.classSession.findFirst.mockReset().mockResolvedValue(null)
    prismaMock.slotHold.findMany.mockReset().mockResolvedValue([])
    prismaMock.commissionPayout.deleteMany.mockReset().mockResolvedValue({ count: 1 })
    prismaMock.commissionCalculation.deleteMany.mockReset().mockResolvedValue({ count: 2 })
    prismaMock.milestoneAchievement.deleteMany.mockReset().mockResolvedValue({ count: 3 })
    prismaMock.commissionOverride.deleteMany.mockReset().mockResolvedValue({ count: 4 })
    prismaMock.staffVenue.delete.mockReset().mockResolvedValue({ id: TEAM_MEMBER_ID })
    prismaMock.staff.delete.mockReset()
    prismaMock.productStaff.findMany.mockReset()
    prismaMock.staffSchedule.findFirst.mockReset()
    prismaMock.staffSchedule.findUnique.mockReset()
    prismaMock.staffScheduleException.findMany.mockReset()
    prismaMock.reservationSettings.findUnique.mockReset()
    lockAppointmentVenueMock.mockReset().mockResolvedValue(undefined)
    loggerInfoMock.mockReset()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('preserves the explicit confirmation guard before opening a transaction', async () => {
    await expect(hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, false)).rejects.toThrow('Deletion must be explicitly confirmed')

    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expectNoHardDeleteWrites()
  })

  it('preserves tenant-scoped not-found behavior from the locked membership read', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])

    await expect(hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true)).rejects.toThrow(NotFoundError)
    await expect(hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true)).rejects.toThrow('Team member not found')

    expect(prismaMock.reservation.findFirst).not.toHaveBeenCalled()
    expectNoHardDeleteWrites()
  })

  it('locks the tenant membership first, checks exact live predicates, and preserves delete order', async () => {
    const beforeLock = new Date('2030-01-01T08:59:00.000Z')
    const checkedAt = new Date('2030-01-01T09:00:00.000Z')
    jest.useFakeTimers().setSystemTime(beforeLock)
    const events: string[] = []

    prismaMock.$queryRaw.mockImplementation(async () => {
      events.push('lock')
      jest.setSystemTime(checkedAt)
      return [{ id: TEAM_MEMBER_ID, staffId: STAFF_ID }]
    })
    prismaMock.reservation.findFirst.mockImplementation(async () => {
      events.push('reservation')
      return null
    })
    prismaMock.classSession.findFirst.mockImplementation(async () => {
      events.push('classSession')
      return null
    })
    prismaMock.slotHold.findMany.mockImplementation(async () => {
      events.push('slotHolds')
      return []
    })
    prismaMock.commissionPayout.deleteMany.mockImplementation(async () => {
      events.push('commissionPayouts')
      return { count: 1 }
    })
    prismaMock.commissionCalculation.deleteMany.mockImplementation(async () => {
      events.push('commissionCalculations')
      return { count: 2 }
    })
    prismaMock.milestoneAchievement.deleteMany.mockImplementation(async () => {
      events.push('milestoneAchievements')
      return { count: 3 }
    })
    prismaMock.commissionOverride.deleteMany.mockImplementation(async () => {
      events.push('commissionOverrides')
      return { count: 4 }
    })
    prismaMock.staffVenue.delete.mockImplementation(async () => {
      events.push('staffVenue')
      return { id: TEAM_MEMBER_ID }
    })

    const result = await hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
      timeout: 10_000,
    })
    expect(events).toEqual([
      'lock',
      'reservation',
      'classSession',
      'slotHolds',
      'commissionPayouts',
      'commissionCalculations',
      'milestoneAchievements',
      'commissionOverrides',
      'staffVenue',
    ])
    const lockQuery = prismaMock.$queryRaw.mock.calls[0][0] as any
    expect(lockQuery.sql).toContain('SELECT id, "staffId"')
    expect(lockQuery.sql).toContain('FROM "StaffVenue"')
    expect(lockQuery.sql).toContain('AND "venueId" = ?')
    expect(lockQuery.sql).toContain('FOR UPDATE')
    expect(lockQuery.sql).not.toMatch(/now\(\)|current_timestamp/i)
    expect(lockQuery.values).toEqual([TEAM_MEMBER_ID, VENUE_ID])
    expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.reservation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          venueId: VENUE_ID,
          assignedStaffId: STAFF_ID,
          status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
          endsAt: { gt: checkedAt },
        },
      }),
    )
    expect(prismaMock.classSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: VENUE_ID, assignedStaffId: STAFF_ID, status: 'SCHEDULED', endsAt: { gt: checkedAt } },
      }),
    )
    expect(prismaMock.slotHold.findMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, staffId: STAFF_ID, endsAt: { gt: checkedAt }, expiresAt: { gt: checkedAt } },
      select: {
        expiresAt: true,
        heldForReservationId: true,
        heldForReservation: { select: { status: true } },
      },
    })
    expect(result).toEqual({
      deletedRecords: {
        commissionPayouts: 1,
        commissionCalculations: 2,
        milestoneAchievements: 3,
        commissionOverrides: 4,
        staffVenue: 1,
      },
    })
    expect(prismaMock.commissionPayout.deleteMany).toHaveBeenCalledWith({ where: { staffId: STAFF_ID, venueId: VENUE_ID } })
    expect(prismaMock.commissionCalculation.deleteMany).toHaveBeenCalledWith({ where: { staffId: STAFF_ID, venueId: VENUE_ID } })
    expect(prismaMock.milestoneAchievement.deleteMany).toHaveBeenCalledWith({ where: { staffId: STAFF_ID, venueId: VENUE_ID } })
    expect(prismaMock.commissionOverride.deleteMany).toHaveBeenCalledWith({ where: { staffId: STAFF_ID, config: { venueId: VENUE_ID } } })
    expect(prismaMock.staffVenue.delete).toHaveBeenCalledWith({ where: { id: TEAM_MEMBER_ID } })
    expect(prismaMock.staff.delete).not.toHaveBeenCalled()
    expect(lockAppointmentVenueMock).not.toHaveBeenCalled()
    expect(prismaMock.productStaff.findMany).not.toHaveBeenCalled()
    expect(prismaMock.staffSchedule.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.staffSchedule.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.staffScheduleException.findMany).not.toHaveBeenCalled()
    expect(prismaMock.reservationSettings.findUnique).not.toHaveBeenCalled()
    expect(loggerInfoMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['reservation', () => prismaMock.reservation.findFirst.mockResolvedValue({ id: 'reservation-secret', customerId: 'customer-secret' })],
    ['class session', () => prismaMock.classSession.findFirst.mockResolvedValue({ id: 'class-secret' })],
  ])('blocks a future active %s before any delete with one generic conflict', async (_label, arrangeBlocker) => {
    arrangeBlocker()

    const error = await hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true).catch(value => value)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({ statusCode: 409, message: HARD_DELETE_CONFLICT_MESSAGE })
    expect(error.message).not.toMatch(/reservation|class|customer|secret|venue/i)
    expectNoHardDeleteWrites()
    expect(loggerInfoMock).not.toHaveBeenCalled()
  })

  it.each([
    ['normal', null, null],
    ['pending-parent reschedule', 'reservation-parent', 'PENDING'],
    ['confirmed-parent reschedule', 'reservation-parent', 'CONFIRMED'],
  ])('blocks a future live %s hold before any delete', async (_label, heldForReservationId, parentStatus) => {
    jest.useFakeTimers().setSystemTime(new Date('2030-01-01T09:00:00.000Z'))
    mockStoredHolds([
      makeStoredHold({
        heldForReservationId,
        heldForReservation: parentStatus ? { status: parentStatus } : null,
      }),
    ])

    await expect(hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true)).rejects.toMatchObject({
      statusCode: 409,
      message: HARD_DELETE_CONFLICT_MESSAGE,
    })

    expectNoHardDeleteWrites()
  })

  it('ignores expired, past, other-venue, and non-live-parent commitments', async () => {
    const checkedAt = new Date('2030-01-01T09:00:00.000Z')
    jest.useFakeTimers().setSystemTime(checkedAt)
    prismaMock.reservation.findFirst.mockImplementation(async ({ where }: any) =>
      new Date('2030-01-01T08:30:00.000Z').getTime() > where.endsAt.gt.getTime() ? { id: 'past-reservation' } : null,
    )
    prismaMock.classSession.findFirst.mockImplementation(async ({ where }: any) =>
      new Date('2030-01-01T08:45:00.000Z').getTime() > where.endsAt.gt.getTime() ? { id: 'past-class' } : null,
    )
    mockStoredHolds([
      makeStoredHold({ endsAt: new Date('2030-01-01T08:30:00.000Z') }),
      makeStoredHold({ expiresAt: new Date('2030-01-01T08:59:59.000Z') }),
      makeStoredHold({ venueId: 'venue-other' }),
      ...['CANCELLED', 'CHECKED_IN', 'NO_SHOW', 'COMPLETED'].map(status =>
        makeStoredHold({
          heldForReservationId: `reservation-${status.toLowerCase()}`,
          heldForReservation: { status },
        }),
      ),
    ])

    const result = await hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true)

    expect(result.deletedRecords.staffVenue).toBe(1)
    expect(prismaMock.staffVenue.delete).toHaveBeenCalledTimes(1)
    expect(prismaMock.staff.delete).not.toHaveBeenCalled()
  })

  it('re-reads membership and commitments on retry without leaking failed-attempt counters or logger calls', async () => {
    const staffIds = ['staff-attempt-1', 'staff-attempt-2']
    let attempt = 0
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      attempt += 1
      const result = await callback(prismaMock)
      if (attempt === 1) throw { code: 'P2034' }
      return result
    })
    prismaMock.$queryRaw.mockImplementation(async () => [{ id: TEAM_MEMBER_ID, staffId: staffIds[attempt - 1] }])
    prismaMock.commissionPayout.deleteMany.mockImplementation(async () => ({ count: attempt === 1 ? 91 : 1 }))
    prismaMock.commissionCalculation.deleteMany.mockImplementation(async () => ({ count: attempt === 1 ? 92 : 2 }))
    prismaMock.milestoneAchievement.deleteMany.mockImplementation(async () => ({ count: attempt === 1 ? 93 : 3 }))
    prismaMock.commissionOverride.deleteMany.mockImplementation(async () => ({ count: attempt === 1 ? 94 : 4 }))

    const result = await hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true)

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
    expect(prismaMock.reservation.findFirst).toHaveBeenCalledTimes(2)
    expect(prismaMock.classSession.findFirst).toHaveBeenCalledTimes(2)
    expect(prismaMock.slotHold.findMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.reservation.findFirst.mock.calls.map(([args]: any[]) => args.where.assignedStaffId)).toEqual(staffIds)
    expect(prismaMock.classSession.findFirst.mock.calls.map(([args]: any[]) => args.where.assignedStaffId)).toEqual(staffIds)
    expect(prismaMock.slotHold.findMany.mock.calls.map(([args]: any[]) => args.where.staffId)).toEqual(staffIds)
    expect(result.deletedRecords).toEqual({
      commissionPayouts: 1,
      commissionCalculations: 2,
      milestoneAchievements: 3,
      commissionOverrides: 4,
      staffVenue: 1,
    })
    expect(loggerInfoMock).toHaveBeenCalledTimes(1)
    // El mensaje perdio el sufijo "(SUPERADMIN)" cuando el borrado se abrio al OWNER:
    // decia quien PODIA ejecutarlo, y ya no era cierto.
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'Team member hard deleted',
      expect.objectContaining({ staffId: 'staff-attempt-2', deletedRecords: result.deletedRecords }),
    )
    expect(prismaMock.staff.delete).not.toHaveBeenCalled()
  })

  it('re-runs future commitment validation after a serialization retry', async () => {
    let attempt = 0
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      attempt += 1
      const result = await callback(prismaMock)
      if (attempt === 1) throw { code: 'P2034' }
      return result
    })
    prismaMock.reservation.findFirst.mockImplementation(async () => (attempt === 2 ? { id: 'new-future-commitment' } : null))

    await expect(hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true)).rejects.toMatchObject({
      statusCode: 409,
      message: HARD_DELETE_CONFLICT_MESSAGE,
    })

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
    expect(prismaMock.reservation.findFirst).toHaveBeenCalledTimes(2)
    expect(prismaMock.commissionPayout.deleteMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.staffVenue.delete).toHaveBeenCalledTimes(1)
    expect(loggerInfoMock).not.toHaveBeenCalled()
    expect(prismaMock.staff.delete).not.toHaveBeenCalled()
  })
})

/**
 * El borrado permanente pasó de ser exclusivo de SUPERADMIN a estar disponible para
 * el OWNER del negocio. Con SUPERADMIN bastaba la confianza del operador; abierto al
 * dueño hacen falta las mismas dos guardas que ya protegían la baja suave, porque
 * ahora sí hay alguien con motivo para borrar a un par.
 */
describe('hardDeleteTeamMember — guardas al abrirlo al OWNER', () => {
  beforeEach(() => {
    prismaMock.$transaction.mockReset().mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.$queryRaw.mockReset().mockResolvedValue([{ id: TEAM_MEMBER_ID, staffId: STAFF_ID, role: StaffRole.WAITER }])
    prismaMock.staffVenue.count.mockReset().mockResolvedValue(2)
    prismaMock.reservation.findFirst.mockReset().mockResolvedValue(null)
    prismaMock.classSession.findFirst.mockReset().mockResolvedValue(null)
    prismaMock.slotHold.findMany.mockReset().mockResolvedValue([])
    prismaMock.commissionPayout.deleteMany.mockReset().mockResolvedValue({ count: 0 })
    prismaMock.commissionCalculation.deleteMany.mockReset().mockResolvedValue({ count: 0 })
    prismaMock.milestoneAchievement.deleteMany.mockReset().mockResolvedValue({ count: 0 })
    prismaMock.commissionOverride.deleteMany.mockReset().mockResolvedValue({ count: 0 })
    prismaMock.staffVenue.delete.mockReset().mockResolvedValue({ id: TEAM_MEMBER_ID })
    prismaMock.staff.delete.mockReset()
    lockAppointmentVenueMock.mockReset().mockResolvedValue(undefined)
    loggerInfoMock.mockReset()
  })

  it.each([[StaffRole.OWNER], [StaffRole.SUPERADMIN]])('no borra a un %s', async role => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: TEAM_MEMBER_ID, staffId: STAFF_ID, role }])

    await expect(hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true)).rejects.toThrow(ConflictError)

    expectNoHardDeleteWrites()
  })

  it('no deja al negocio sin ningún administrador activo', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: TEAM_MEMBER_ID, staffId: STAFF_ID, role: StaffRole.ADMIN }])
    prismaMock.staffVenue.count.mockResolvedValue(0)

    await expect(hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true)).rejects.toThrow(ConflictError)

    expectNoHardDeleteWrites()
  })

  it('sí borra a un ADMIN cuando queda otro administrador', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: TEAM_MEMBER_ID, staffId: STAFF_ID, role: StaffRole.ADMIN }])
    prismaMock.staffVenue.count.mockResolvedValue(1)

    await expect(hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true)).resolves.toEqual(
      expect.objectContaining({ deletedRecords: expect.objectContaining({ staffVenue: 1 }) }),
    )
  })

  it('no cuenta administradores cuando el rol no es de administración', async () => {
    // Un mesero nunca puede ser el último administrador: la consulta extra sobra.
    await expect(hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true)).resolves.toBeDefined()

    expect(prismaMock.staffVenue.count).not.toHaveBeenCalled()
  })

  it('cuenta sólo administradores activos de ESTE negocio, excluyendo al que se borra', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: TEAM_MEMBER_ID, staffId: STAFF_ID, role: StaffRole.ADMIN }])

    await hardDeleteTeamMember(VENUE_ID, TEAM_MEMBER_ID, true)

    expect(prismaMock.staffVenue.count).toHaveBeenCalledWith({
      where: {
        venueId: VENUE_ID,
        role: { in: [StaffRole.OWNER, StaffRole.ADMIN] },
        active: true,
        id: { not: TEAM_MEMBER_ID },
      },
    })
  })
})

/**
 * GET .../team/:teamMemberId/deactivation-impact — aviso (no candado) para que la
 * pantalla de baja de personal muestre si esa persona trae inventario serializado
 * en custodia o verificaciones de venta pendientes antes de confirmar la baja.
 *
 * `teamMemberId` es el id de StaffVenue, NO el de Staff — el mismo id que usa
 * removeTeamMember. Confundirlos (usar teamMemberId donde va staffId) hace que el
 * conteo salga en cero SIEMPRE, que es el peor resultado posible: un aviso que nunca
 * avisa. Varias pruebas de abajo verifican explícitamente que las consultas usan
 * staffVenue.staffId y no el teamMemberId crudo.
 */
describe('getDeactivationImpact — aviso de custodia al dar de baja', () => {
  const ORGANIZATION_ID = 'org-1'

  beforeEach(() => {
    prismaMock.staffVenue.findFirst.mockReset()
    prismaMock.venue.findUnique.mockReset()
    prismaMock.serializedItem.count.mockReset()
    prismaMock.saleVerification.count.mockReset()

    prismaMock.staffVenue.findFirst.mockResolvedValue({
      id: TEAM_MEMBER_ID,
      staffId: STAFF_ID,
      venueId: VENUE_ID,
      staff: { firstName: 'Isela Judith', lastName: 'Chavez Leal' },
    } as any)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORGANIZATION_ID } as any)
    prismaMock.serializedItem.count.mockResolvedValue(0)
    prismaMock.saleVerification.count.mockResolvedValue(0)
  })

  it('lanza NotFoundError en español cuando el teamMemberId no pertenece a este venue', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)

    await expect(getDeactivationImpact(VENUE_ID, TEAM_MEMBER_ID)).rejects.toThrow(NotFoundError)
    await expect(getDeactivationImpact(VENUE_ID, TEAM_MEMBER_ID)).rejects.toThrow('Miembro del equipo no encontrado en este venue')

    expect(prismaMock.serializedItem.count).not.toHaveBeenCalled()
    expect(prismaMock.saleVerification.count).not.toHaveBeenCalled()
  })

  it('busca al miembro del equipo acotado al venueId de la ruta (aislamiento de tenant)', async () => {
    await getDeactivationImpact(VENUE_ID, TEAM_MEMBER_ID)

    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TEAM_MEMBER_ID, venueId: VENUE_ID } }),
    )
  })

  it('arma staffName con nombre y apellido de la persona', async () => {
    const result = await getDeactivationImpact(VENUE_ID, TEAM_MEMBER_ID)

    expect(result.staffName).toBe('Isela Judith Chavez Leal')
  })

  it('cuenta serializedItemsInCustody usando el staffId de Staff, NUNCA el teamMemberId de StaffVenue', async () => {
    prismaMock.serializedItem.count.mockResolvedValue(93)

    const result = await getDeactivationImpact(VENUE_ID, TEAM_MEMBER_ID)

    expect(result.serializedItemsInCustody).toBe(93)
    const callArg = prismaMock.serializedItem.count.mock.calls[0][0] as any
    expect(callArg.where.assignedPromoterId).toBe(STAFF_ID)
    expect(callArg.where.assignedPromoterId).not.toBe(TEAM_MEMBER_ID)
  })

  it('excluye los artículos ya vendidos (custodyState=SOLD) del conteo de custodia', async () => {
    await getDeactivationImpact(VENUE_ID, TEAM_MEMBER_ID)

    const callArg = prismaMock.serializedItem.count.mock.calls[0][0] as any
    expect(callArg.where.custodyState).toEqual({ not: 'SOLD' })
  })

  it('incluye el pool a nivel organización (venueId=null) sin salirse del tenant del venue', async () => {
    await getDeactivationImpact(VENUE_ID, TEAM_MEMBER_ID)

    const callArg = prismaMock.serializedItem.count.mock.calls[0][0] as any
    expect(callArg.where.OR).toEqual(expect.arrayContaining([{ venueId: VENUE_ID }, { organizationId: ORGANIZATION_ID, venueId: null }]))
  })

  it('cae a filtrar sólo por venueId si el venue no resuelve organizationId', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(null)

    await getDeactivationImpact(VENUE_ID, TEAM_MEMBER_ID)

    const callArg = prismaMock.serializedItem.count.mock.calls[0][0] as any
    expect(callArg.where.venueId).toBe(VENUE_ID)
    expect(callArg.where.OR).toBeUndefined()
  })

  it('cuenta pendingSaleVerifications sólo en estados NO finales (PENDING, PROCESSING, FAILED), acotado a este venue y persona', async () => {
    prismaMock.saleVerification.count.mockResolvedValue(4)

    const result = await getDeactivationImpact(VENUE_ID, TEAM_MEMBER_ID)

    expect(result.pendingSaleVerifications).toBe(4)
    expect(prismaMock.saleVerification.count).toHaveBeenCalledWith({
      where: {
        venueId: VENUE_ID,
        staffId: STAFF_ID,
        status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
      },
    })
  })

  it('devuelve cero limpio cuando la persona no trae nada', async () => {
    prismaMock.serializedItem.count.mockResolvedValue(0)
    prismaMock.saleVerification.count.mockResolvedValue(0)

    const result = await getDeactivationImpact(VENUE_ID, TEAM_MEMBER_ID)

    expect(result).toEqual({
      staffName: 'Isela Judith Chavez Leal',
      serializedItemsInCustody: 0,
      pendingSaleVerifications: 0,
    })
  })
})
