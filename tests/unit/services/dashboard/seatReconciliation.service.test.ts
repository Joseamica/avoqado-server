/**
 * Pro→Free DOWNGRADE seat reconciliation ("choose who stays").
 *
 * Mocking strategy (mirrors planState.service / seatCap.service tests):
 *   - prismaClient is fully mocked via the shared __helpers__/setup mock (prismaMock).
 *   - planState.service.cancelPlan is mocked (we assert it's called to schedule the
 *     cancel-at-period-end; we don't exercise the real Stripe flip here — that's planState's
 *     own test).
 *   - seatCap.service.getActiveSeatCount is mocked so we drive the current seat count per test
 *     without wiring counts; FREE_TIER_SEAT_CAP (2) is used as the real constant.
 *   - stripe.service.retrievePlanSubscription is mocked for the period-end fallback path.
 */
import { prismaMock } from '../../../__helpers__/setup'
import { InvitationStatus, StaffRole } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'

jest.mock('@/services/dashboard/planState.service', () => ({
  __esModule: true,
  cancelPlan: jest.fn(),
  getPlanState: jest.fn(),
}))
jest.mock('@/services/access/seatCap.service', () => {
  const actual = jest.requireActual('@/services/access/seatCap.service')
  // getVenueSeatCap stays REAL by default (getVenueSeatStatus tests need it); the execute tests drive it.
  return { __esModule: true, ...actual, getActiveSeatCount: jest.fn(), getVenueSeatCap: jest.fn(actual.getVenueSeatCap) }
})
jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  retrievePlanSubscription: jest.fn(),
}))

import * as planState from '@/services/dashboard/planState.service'
import { getActiveSeatCount, getVenueSeatCap } from '@/services/access/seatCap.service'
import {
  getDowngradePreview,
  scheduleDowngradeToFree,
  executeSeatReconciliation,
  reactivateSeatCapDeactivated,
  clearPendingReconciliation,
  getVenueSeatStatus,
  assertKeepSelection,
} from '@/services/dashboard/seatReconciliation.service'

const cancelPlanMock = planState.cancelPlan as jest.Mock
const activeCountMock = getActiveSeatCount as jest.Mock

const future = new Date(Date.now() + 30 * 86400000)

/** A cap-counting StaffVenue row as returned by getCapCountingStaffVenues' select. */
function sv(id: string, role: StaffRole, overrides: Record<string, unknown> = {}) {
  return {
    id,
    staffId: `staff_${id}`,
    role,
    staff: { firstName: `F${id}`, lastName: `L${id}`, email: `${id}@x.com`, lastLoginAt: null },
    ...overrides,
  }
}

/** Default plan state returned by the mocked cancelPlan. */
function planStateResult(overrides: Record<string, unknown> = {}) {
  return {
    hasPlan: true,
    state: 'canceling',
    planTier: 'PRO',
    currentPeriodEnd: future.toISOString(),
    cancelAtPeriodEnd: true,
    stripeSubscriptionId: 'sub_123',
    ...overrides,
  }
}

describe('seatReconciliation.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    cancelPlanMock.mockResolvedValue(planStateResult())
    prismaMock.venue.update.mockResolvedValue({})
  })

  // ── getDowngradePreview ──────────────────────────────────────────────────────────────────
  describe('getDowngradePreview', () => {
    it('required=true when active seats exceed the cap; OWNER row flagged isOwner', async () => {
      const rows = [sv('o', StaffRole.OWNER), sv('a', StaffRole.MANAGER), sv('b', StaffRole.WAITER)]
      prismaMock.staffVenue.findMany.mockResolvedValue(rows)
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'o', staffId: 'staff_o' }) // owner lookup
      activeCountMock.mockResolvedValue(3)

      const preview = await getDowngradePreview('venue_1')
      expect(preview.required).toBe(true)
      expect(preview.cap).toBe(2)
      expect(preview.keepMax).toBe(2)
      expect(preview.currentActive).toBe(3)
      expect(preview.staff).toHaveLength(3)
      expect(preview.staff.find(s => s.staffVenueId === 'o')?.isOwner).toBe(true)
      expect(preview.staff.find(s => s.staffVenueId === 'a')?.isOwner).toBe(false)
    })

    it('required=false when active seats are at/under the cap', async () => {
      prismaMock.staffVenue.findMany.mockResolvedValue([sv('o', StaffRole.OWNER), sv('a', StaffRole.MANAGER)])
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'o', staffId: 'staff_o' })
      activeCountMock.mockResolvedValue(2)

      const preview = await getDowngradePreview('venue_1')
      expect(preview.required).toBe(false)
    })

    it('maps lastLoginAt → lastActiveAt ISO (null when never logged in)', async () => {
      const loggedIn = new Date('2026-01-01T00:00:00.000Z')
      prismaMock.staffVenue.findMany.mockResolvedValue([
        sv('o', StaffRole.OWNER, { staff: { firstName: 'A', lastName: 'B', email: 'o@x.com', lastLoginAt: loggedIn } }),
        sv('a', StaffRole.WAITER),
      ])
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'o', staffId: 'staff_o' })
      activeCountMock.mockResolvedValue(2)

      const preview = await getDowngradePreview('venue_1')
      expect(preview.staff.find(s => s.staffVenueId === 'o')?.lastActiveAt).toBe(loggedIn.toISOString())
      expect(preview.staff.find(s => s.staffVenueId === 'a')?.lastActiveAt).toBeNull()
    })
  })

  // ── scheduleDowngradeToFree ──────────────────────────────────────────────────────────────
  describe('scheduleDowngradeToFree', () => {
    function overCapSetup() {
      prismaMock.staffVenue.findMany.mockResolvedValue([sv('o', StaffRole.OWNER), sv('a', StaffRole.MANAGER), sv('b', StaffRole.WAITER)])
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'o', staffId: 'staff_o' }) // owner
      activeCountMock.mockResolvedValue(3) // over cap (2)
    }

    it('over cap: schedules cancel-at-period-end and persists the selection', async () => {
      overCapSetup()
      const result = await scheduleDowngradeToFree('venue_1', ['o', 'a'])

      expect(cancelPlanMock).toHaveBeenCalledWith('venue_1', {})
      // Persisted pending selection with the period end + selection.
      const updateArg = prismaMock.venue.update.mock.calls[0][0]
      expect(updateArg.where).toEqual({ id: 'venue_1' })
      const pending = updateArg.data.pendingSeatReconciliation
      expect(pending.keepStaffVenueIds).toEqual(['o', 'a'])
      expect(pending.scheduledFor).toBe(future.toISOString())
      expect(typeof pending.createdAt).toBe('string')
      expect(result.state).toBe('canceling')
    })

    it('rejects when the OWNER is not in the keep list', async () => {
      overCapSetup()
      await expect(scheduleDowngradeToFree('venue_1', ['a', 'b'])).rejects.toThrow(BadRequestError)
      await expect(scheduleDowngradeToFree('venue_1', ['a', 'b'])).rejects.toThrow('propietario debe conservar')
      expect(cancelPlanMock).not.toHaveBeenCalled()
    })

    it('rejects when more than the cap (2) are selected', async () => {
      overCapSetup()
      await expect(scheduleDowngradeToFree('venue_1', ['o', 'a', 'b'])).rejects.toThrow('Solo puedes conservar 2')
      expect(cancelPlanMock).not.toHaveBeenCalled()
    })

    it('rejects a StaffVenue id that is not an active seat of THIS venue', async () => {
      overCapSetup()
      await expect(scheduleDowngradeToFree('venue_1', ['o', 'foreign'])).rejects.toThrow('no pertenece a este venue')
      expect(cancelPlanMock).not.toHaveBeenCalled()
    })

    it('rejects an empty selection while over cap (selection required)', async () => {
      overCapSetup()
      await expect(scheduleDowngradeToFree('venue_1', [])).rejects.toThrow('Debes elegir')
      expect(cancelPlanMock).not.toHaveBeenCalled()
    })

    it('under cap: empty selection allowed (skip), still schedules cancel and persists empty keep', async () => {
      prismaMock.staffVenue.findMany.mockResolvedValue([sv('o', StaffRole.OWNER), sv('a', StaffRole.WAITER)])
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'o', staffId: 'staff_o' })
      activeCountMock.mockResolvedValue(2) // at cap → no selection needed

      const result = await scheduleDowngradeToFree('venue_1', [])
      expect(cancelPlanMock).toHaveBeenCalledWith('venue_1', {})
      expect(prismaMock.venue.update.mock.calls[0][0].data.pendingSeatReconciliation.keepStaffVenueIds).toEqual([])
      expect(result.state).toBe('canceling')
    })

    it('rejects when over cap but the venue has no active OWNER', async () => {
      prismaMock.staffVenue.findMany.mockResolvedValue([sv('a', StaffRole.MANAGER), sv('b', StaffRole.WAITER), sv('c', StaffRole.CASHIER)])
      prismaMock.staffVenue.findFirst.mockResolvedValue(null) // no owner
      activeCountMock.mockResolvedValue(3)
      await expect(scheduleDowngradeToFree('venue_1', ['a', 'b'])).rejects.toThrow('no tiene un propietario')
      expect(cancelPlanMock).not.toHaveBeenCalled()
    })

    it('forwards the owner reason and the actor to cancelPlan', async () => {
      overCapSetup()
      await scheduleDowngradeToFree('venue_1', ['o', 'a'], { reason: 'TOO_EXPENSIVE', comment: 'Caro', staffId: 'staff_o' })
      expect(cancelPlanMock).toHaveBeenCalledWith('venue_1', { reason: 'TOO_EXPENSIVE', comment: 'Caro', staffId: 'staff_o' })
    })
  })

  describe('assertKeepSelection: a "who stays" choice carried by the hybrid checkout', () => {
    beforeEach(() => {
      prismaMock.staffVenue.findMany.mockResolvedValue([sv('o', StaffRole.OWNER), sv('a', StaffRole.MANAGER), sv('b', StaffRole.WAITER)])
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'o', staffId: 'staff_o' })
    })

    it('accepts the owner plus one more', async () => {
      await expect(assertKeepSelection('venue_1', ['o', 'a'])).resolves.toBeUndefined()
    })

    it.each([
      [['o', 'a', 'b'], 'Solo puedes conservar 2'],
      [['o', 'foreign'], 'no pertenece a este venue'],
      [['a', 'b'], 'propietario debe conservar'],
    ])('rejects %j', async (keep, message) => {
      await expect(assertKeepSelection('venue_1', keep)).rejects.toThrow(message)
    })

    it('rejects when the venue has no owner', async () => {
      prismaMock.staffVenue.findFirst.mockResolvedValue(null)
      await expect(assertKeepSelection('venue_1', ['a'])).rejects.toThrow('no tiene un propietario')
    })
  })

  // ── executeSeatReconciliation ────────────────────────────────────────────────────────────
  // Runs when the paid plan ACTUALLY ends. Rule (founder, 2026-09-27 — Shopify's model): whoever doesn't fit in the
  // Free cap is deactivated automatically, pending invitations first (most recent first), then the users inactive the
  // longest (never-logged-in first). The owner's explicit "who stays" choice goes first; the OWNER always stays.
  describe('executeSeatReconciliation', () => {
    const capMock = getVenueSeatCap as jest.Mock
    const at = (iso: string | null) => (iso ? new Date(iso) : null)
    /** A cap-counting StaffVenue row with a last-login date. */
    const seat = (id: string, role: StaffRole, lastLoginAt: string | null) =>
      sv(id, role, { staff: { firstName: `F${id}`, lastName: `L${id}`, email: `${id}@x.com`, lastLoginAt: at(lastLoginAt) } })
    const pendingWith = (keepStaffVenueIds: string[]) => ({
      pendingSeatReconciliation: { keepStaffVenueIds, scheduledFor: future.toISOString(), createdAt: '' },
    })
    const deactivatedIds = () => prismaMock.staffVenue.updateMany.mock.calls[0]?.[0]?.where?.id?.in

    beforeEach(() => {
      capMock.mockResolvedValue(2) // dropped to Free
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 0 })
      prismaMock.invitation.findMany.mockResolvedValue([])
      prismaMock.invitation.updateMany.mockResolvedValue({ count: 0 })
    })
    afterEach(() => capMock.mockImplementation(jest.requireActual('@/services/access/seatCap.service').getVenueSeatCap))

    it('explicit selection: deactivates exactly the non-kept seats (flagged for re-upgrade), never an OWNER, then clears the field', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith(['o', 'a']))
      prismaMock.staffVenue.findMany.mockResolvedValue([
        seat('o', StaffRole.OWNER, null),
        seat('a', StaffRole.MANAGER, null),
        seat('b', StaffRole.WAITER, null),
      ])
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 1 })

      expect(await executeSeatReconciliation('venue_1')).toBe(1)

      const { where, data } = prismaMock.staffVenue.updateMany.mock.calls[0][0]
      expect(where).toMatchObject({ venueId: 'venue_1', active: true, id: { in: ['b'] } })
      expect(where.role).toEqual({ notIn: [StaffRole.SUPERADMIN, StaffRole.OWNER] })
      expect(data.active).toBe(false)
      expect(data.endDate).toBeInstanceOf(Date)
      expect(data.deactivatedBySeatCap).toBe(true) // a later re-upgrade reactivates exactly these rows
      expect(prismaMock.venue.update).toHaveBeenCalledWith({ where: { id: 'venue_1' }, data: { pendingSeatReconciliation: null } })
    })

    it('🔴 no selection was needed and the team still fits → nobody is deactivated, field cleared', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith([]))
      prismaMock.staffVenue.findMany.mockResolvedValue([seat('o', StaffRole.OWNER, null), seat('a', StaffRole.WAITER, null)])

      expect(await executeSeatReconciliation('venue_1')).toBe(0)
      expect(prismaMock.staffVenue.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.venue.update).toHaveBeenCalledWith({ where: { id: 'venue_1' }, data: { pendingSeatReconciliation: null } })
    })

    it('🔴 the team grew after scheduling (no selection) → keeps the owner + the most recently active; never-logged-in go first', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith([]))
      prismaMock.staffVenue.findMany.mockResolvedValue([
        seat('o', StaffRole.OWNER, '2026-09-01T12:00:00Z'),
        seat('a', StaffRole.MANAGER, '2026-09-01T12:00:00Z'),
        seat('b', StaffRole.CASHIER, '2026-09-20T12:00:00Z'),
        seat('c', StaffRole.WAITER, null),
      ])

      await executeSeatReconciliation('venue_1')

      expect(deactivatedIds()).toEqual(['a', 'c']) // b logged in most recently and keeps the one free seat
    })

    it('🔴 the team grew after scheduling WITH a selection → whoever is outside the selection is deactivated', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith(['o', 'a']))
      prismaMock.staffVenue.findMany.mockResolvedValue([
        seat('o', StaffRole.OWNER, null),
        seat('a', StaffRole.MANAGER, null),
        seat('n', StaffRole.WAITER, '2026-09-26T12:00:00Z'),
      ])

      await executeSeatReconciliation('venue_1')

      expect(deactivatedIds()).toEqual(['n'])
    })

    it('🔴 ownership moved after scheduling → the new owner stays and the cap still holds (most recent of the selection keeps the seat)', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith(['x', 'a'])) // x was the owner when choosing
      prismaMock.staffVenue.findMany.mockResolvedValue([
        seat('y', StaffRole.OWNER, '2026-09-26T12:00:00Z'),
        seat('x', StaffRole.ADMIN, '2026-09-10T12:00:00Z'),
        seat('a', StaffRole.MANAGER, '2026-09-25T12:00:00Z'),
      ])

      await executeSeatReconciliation('venue_1')

      expect(deactivatedIds()).toEqual(['x'])
    })

    it('🔴 plan ended through a plain cancel (no downgrade record) → the same rule applies', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ pendingSeatReconciliation: null })
      prismaMock.staffVenue.findMany.mockResolvedValue([
        seat('o', StaffRole.OWNER, null),
        seat('a', StaffRole.MANAGER, '2026-09-25T12:00:00Z'),
        seat('b', StaffRole.WAITER, '2026-09-02T12:00:00Z'),
      ])

      await executeSeatReconciliation('venue_1')

      expect(deactivatedIds()).toEqual(['b'])
      expect(prismaMock.venue.update).not.toHaveBeenCalled() // nothing pending to clear
    })

    it('🔴 pending invitations lose their seat first, most recent first (the oldest keeps a free seat)', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith([]))
      prismaMock.staffVenue.findMany.mockResolvedValue([seat('o', StaffRole.OWNER, null)])
      prismaMock.invitation.findMany.mockResolvedValue([{ id: 'inv_oldest' }])
      prismaMock.invitation.updateMany.mockResolvedValue({ count: 2 })

      await executeSeatReconciliation('venue_1')

      const find = prismaMock.invitation.findMany.mock.calls[0][0]
      expect(find.take).toBe(1) // one seat left after the owner
      expect(find.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])
      const { where, data } = prismaMock.invitation.updateMany.mock.calls[0][0]
      expect(where).toMatchObject({ venueId: 'venue_1', status: InvitationStatus.PENDING, id: { notIn: ['inv_oldest'] } })
      expect(where.role).toEqual({ not: StaffRole.SUPERADMIN })
      expect(data).toEqual({ status: InvitationStatus.REVOKED })
      expect(prismaMock.staffVenue.updateMany).not.toHaveBeenCalled()
    })

    it('🔴 no seat left for invitations → every pending invitation is revoked', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith([]))
      prismaMock.staffVenue.findMany.mockResolvedValue([seat('o', StaffRole.OWNER, null), seat('a', StaffRole.WAITER, null)])

      await executeSeatReconciliation('venue_1')

      expect(prismaMock.invitation.findMany).not.toHaveBeenCalled()
      const { where } = prismaMock.invitation.updateMany.mock.calls[0][0]
      expect(where).toMatchObject({ venueId: 'venue_1', status: InvitationStatus.PENDING })
      expect(where.id).toBeUndefined()
    })

    // 🔴 Codex (3rd audit): a late webhook of an OLD subscription must not wipe the selection of a LATER downgrade
    // while another paid plan is live. Only a real execution (or undoing the downgrade) clears it.
    it('🔴 still on a paid plan or grandfathered (unlimited) → touches nobody and keeps the pending selection', async () => {
      capMock.mockResolvedValue(null)
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith(['o']))

      expect(await executeSeatReconciliation('venue_1')).toBe(0)
      expect(prismaMock.staffVenue.findMany).not.toHaveBeenCalled()
      expect(prismaMock.staffVenue.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.invitation.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.venue.update).not.toHaveBeenCalled()
    })

    it('idempotent: nothing pending and the team fits → no writes at all', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ pendingSeatReconciliation: null })
      prismaMock.staffVenue.findMany.mockResolvedValue([seat('o', StaffRole.OWNER, null), seat('a', StaffRole.WAITER, null)])

      expect(await executeSeatReconciliation('venue_1')).toBe(0)
      expect(prismaMock.staffVenue.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.venue.update).not.toHaveBeenCalled()
    })

    it('audits what the cap turned off in ActivityLog', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith([]))
      prismaMock.staffVenue.findMany.mockResolvedValue([
        seat('o', StaffRole.OWNER, null),
        seat('a', StaffRole.MANAGER, '2026-09-25T12:00:00Z'),
        seat('b', StaffRole.WAITER, null),
      ])
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 1 })

      await executeSeatReconciliation('venue_1')

      expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          venueId: 'venue_1',
          action: 'SEAT_CAP_ENFORCED',
          entity: 'Venue',
          entityId: 'venue_1',
          data: expect.objectContaining({ cap: 2, deactivatedStaffVenueIds: ['b'] }),
        }),
      })
    })

    // 🔴 Codex (3rd audit): deactivations, revocations, clearing the field and the audit row were separate writes. If the
    // second failed, users stayed off with no audit row and the retry had nothing left to record. One transaction.
    it('🔴 every write happens inside ONE transaction (all or nothing, audit row included)', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith([]))
      prismaMock.staffVenue.findMany.mockResolvedValue([
        seat('o', StaffRole.OWNER, null),
        seat('a', StaffRole.MANAGER, '2026-09-25T12:00:00Z'),
        seat('b', StaffRole.WAITER, null),
      ])
      let inside = false
      const outside: string[] = []
      prismaMock.$transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
        inside = true
        try {
          return await cb(prismaMock)
        } finally {
          inside = false
        }
      })
      const track = (name: string, value: unknown) => async () => {
        if (!inside) outside.push(name)
        return value
      }
      prismaMock.staffVenue.updateMany.mockImplementation(track('staffVenue.updateMany', { count: 1 }))
      prismaMock.invitation.updateMany.mockImplementation(track('invitation.updateMany', { count: 0 }))
      prismaMock.venue.update.mockImplementation(track('venue.update', {}))
      prismaMock.activityLog.create.mockImplementation(track('activityLog.create', {}))

      await executeSeatReconciliation('venue_1')

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
      expect(outside).toEqual([])
      expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    })

    // 🔴 Codex (4th audit, reproduced): the team was read BEFORE the transaction, so an accept landing in between added a
    // seat the count never saw (3 active on Free). Now the venue's pending invitations are locked first, inside it.
    it('🔴 locks the pending invitations inside the transaction BEFORE reading the team', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith([]))
      const team = [seat('o', StaffRole.OWNER, null), seat('a', StaffRole.WAITER, null)]
      let inside = false
      const readOutside: string[] = []
      prismaMock.$transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
        inside = true
        try {
          return await cb(prismaMock)
        } finally {
          inside = false
        }
      })
      prismaMock.$queryRaw.mockImplementation(async () => {
        if (!inside) readOutside.push('lock')
        return []
      })
      prismaMock.staffVenue.findMany.mockImplementation(async () => {
        if (!inside) readOutside.push('team')
        return team
      })

      await executeSeatReconciliation('venue_1')

      expect(readOutside).toEqual([])
      const sql = (prismaMock.$queryRaw.mock.calls[0][0] as string[]).join('?')
      expect(sql).toContain('"Invitation"')
      expect(sql).toContain('FOR UPDATE')
      expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.staffVenue.findMany.mock.invocationCallOrder[0])
    })

    it('🔴 a failure midway propagates, so the webhook event stays FAILED and the cron replays it', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith([]))
      prismaMock.staffVenue.findMany.mockResolvedValue([seat('o', StaffRole.OWNER, null), seat('a', StaffRole.WAITER, null)])
      prismaMock.invitation.updateMany.mockRejectedValueOnce(new Error('db down'))

      await expect(executeSeatReconciliation('venue_1')).rejects.toThrow('db down')
    })

    it('an explicit selection (the hybrid checkout) wins over a pending one', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith(['o', 'b']))
      prismaMock.staffVenue.findMany.mockResolvedValue([
        seat('o', StaffRole.OWNER, null),
        seat('a', StaffRole.MANAGER, null),
        seat('b', StaffRole.WAITER, null),
      ])
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 1 })
      await executeSeatReconciliation('venue_1', { keepStaffVenueIds: ['o', 'a'] })
      expect(deactivatedIds()).toEqual(['b'])
    })

    it('an empty explicit selection falls back to the pending one', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(pendingWith(['o', 'a']))
      prismaMock.staffVenue.findMany.mockResolvedValue([
        seat('o', StaffRole.OWNER, null),
        seat('a', StaffRole.MANAGER, null),
        seat('b', StaffRole.WAITER, null),
      ])
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 1 })
      await executeSeatReconciliation('venue_1', { keepStaffVenueIds: [] })
      expect(deactivatedIds()).toEqual(['b'])
    })

    // The checkout choice is validated only at quote time and stored as sent: by the time the invoice is paid it may name
    // someone who left, repeat an id, or miss an owner who took over. None of that may fail or cost the owner the business.
    it('🔴 an explicit selection with a departed member, a repeated id and no owner → never fails, the owner stays', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ pendingSeatReconciliation: null })
      prismaMock.staffVenue.findMany.mockResolvedValue([
        seat('o', StaffRole.OWNER, null),
        seat('a', StaffRole.MANAGER, null),
        seat('b', StaffRole.WAITER, '2026-09-25T12:00:00Z'), // the automatic order would keep b and drop a
      ])
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 1 })
      await executeSeatReconciliation('venue_1', { keepStaffVenueIds: ['a', 'a', 'gone'] })
      expect(deactivatedIds()).toEqual(['b'])
      expect(prismaMock.staffVenue.updateMany.mock.calls[0][0].where.role).toEqual({ notIn: [StaffRole.SUPERADMIN, StaffRole.OWNER] })
    })
  })

  // ── reactivateSeatCapDeactivated ─────────────────────────────────────────────────────────
  describe('reactivateSeatCapDeactivated', () => {
    it('reactivates exactly the cap-deactivated rows (active, endDate null, flag cleared) and returns the count', async () => {
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 3 })

      const reactivated = await reactivateSeatCapDeactivated('venue_1')
      expect(reactivated).toBe(3)

      // Targets ONLY rows the cap turned off — never people who were fired/quit.
      const where = prismaMock.staffVenue.updateMany.mock.calls[0][0].where
      expect(where).toEqual({ venueId: 'venue_1', deactivatedBySeatCap: true })

      const data = prismaMock.staffVenue.updateMany.mock.calls[0][0].data
      expect(data.active).toBe(true)
      expect(data.endDate).toBeNull()
      expect(data.deactivatedBySeatCap).toBe(false) // cleared so a re-run is a no-op
    })

    it('is idempotent: no cap-deactivated rows → returns 0 (still a single no-op updateMany)', async () => {
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 0 })

      const reactivated = await reactivateSeatCapDeactivated('venue_1')
      expect(reactivated).toBe(0)
      expect(prismaMock.staffVenue.updateMany).toHaveBeenCalledTimes(1)
    })
  })

  // ── clearPendingReconciliation ───────────────────────────────────────────────────────────
  describe('clearPendingReconciliation', () => {
    it('clears a pending reconciliation and returns true', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({
        pendingSeatReconciliation: { keepStaffVenueIds: ['o'], scheduledFor: '', createdAt: '' },
      })
      const cleared = await clearPendingReconciliation('venue_1')
      expect(cleared).toBe(true)
      expect(prismaMock.venue.update).toHaveBeenCalledWith({
        where: { id: 'venue_1' },
        data: { pendingSeatReconciliation: null },
      })
    })

    it('returns false (no-op) when nothing is pending', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ pendingSeatReconciliation: null })
      const cleared = await clearPendingReconciliation('venue_1')
      expect(cleared).toBe(false)
      expect(prismaMock.venue.update).not.toHaveBeenCalled()
    })
  })

  // ── getVenueSeatStatus (active + pending breakdown) ──────────────────────────────────────────
  describe('getVenueSeatStatus', () => {
    // getActiveSeatCount is mocked (drives `active`); getPendingInvitationCount is REAL and reads
    // prismaMock.invitation.count (drives `pending`); getVenueBaseTier is REAL and reads
    // prismaMock.venueFeature.findMany (→ [] = Free tier → cap 2). seatCapExempt comes from
    // prismaMock.venue.findUnique.
    beforeEach(() => {
      prismaMock.venueFeature.findMany.mockResolvedValue([]) // no paid base plan → Free tier
    })

    it('Free venue: current = active + pending; blocked when current === cap', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false })
      activeCountMock.mockResolvedValue(1)
      prismaMock.invitation.count.mockResolvedValue(1) // one outstanding invite
      const status = await getVenueSeatStatus('venue_1')
      expect(status).toEqual({ cap: 2, active: 1, pending: 1, current: 2, allowed: false, exempt: false })
    })

    it('Free venue under cap: 1 active + 0 pending → allowed', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false })
      activeCountMock.mockResolvedValue(1)
      prismaMock.invitation.count.mockResolvedValue(0)
      const status = await getVenueSeatStatus('venue_1')
      expect(status).toEqual({ cap: 2, active: 1, pending: 0, current: 1, allowed: true, exempt: false })
    })

    it('exempt (grandfathered) venue: cap null, always allowed, still reports active/pending', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: true })
      activeCountMock.mockResolvedValue(5)
      prismaMock.invitation.count.mockResolvedValue(4)
      const status = await getVenueSeatStatus('venue_1')
      expect(status).toEqual({ cap: null, active: 5, pending: 4, current: 9, allowed: true, exempt: true })
    })

    it('pending invitation count filters PENDING, not-yet-expired, non-SUPERADMIN', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false })
      activeCountMock.mockResolvedValue(0)
      prismaMock.invitation.count.mockResolvedValue(0)
      await getVenueSeatStatus('venue_1')
      const where = prismaMock.invitation.count.mock.calls[0][0].where
      expect(where.venueId).toBe('venue_1')
      expect(where.status).toBe(InvitationStatus.PENDING)
      expect(where.role).toEqual({ not: StaffRole.SUPERADMIN })
      expect(where.expiresAt.gt).toBeInstanceOf(Date)
    })
  })
})
