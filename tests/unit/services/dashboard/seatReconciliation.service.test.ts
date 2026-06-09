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
  return { __esModule: true, ...actual, getActiveSeatCount: jest.fn() }
})
jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  retrievePlanSubscription: jest.fn(),
}))

import * as planState from '@/services/dashboard/planState.service'
import { getActiveSeatCount } from '@/services/access/seatCap.service'
import {
  getDowngradePreview,
  scheduleDowngradeToFree,
  executeSeatReconciliation,
  reactivateSeatCapDeactivated,
  clearPendingReconciliation,
  getVenueSeatStatus,
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
      prismaMock.staffVenue.findMany.mockResolvedValue([
        sv('o', StaffRole.OWNER),
        sv('a', StaffRole.MANAGER),
        sv('b', StaffRole.WAITER),
      ])
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'o', staffId: 'staff_o' }) // owner
      activeCountMock.mockResolvedValue(3) // over cap (2)
    }

    it('over cap: schedules cancel-at-period-end and persists the selection', async () => {
      overCapSetup()
      const result = await scheduleDowngradeToFree('venue_1', ['o', 'a'])

      expect(cancelPlanMock).toHaveBeenCalledWith('venue_1')
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
      expect(cancelPlanMock).toHaveBeenCalledWith('venue_1')
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
  })

  // ── executeSeatReconciliation ────────────────────────────────────────────────────────────
  describe('executeSeatReconciliation', () => {
    it('deactivates exactly the non-kept active seats, then clears the field', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({
        pendingSeatReconciliation: { keepStaffVenueIds: ['o', 'a'], scheduledFor: future.toISOString(), createdAt: '' },
      })
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 1 })

      const deactivated = await executeSeatReconciliation('venue_1')
      expect(deactivated).toBe(1)

      const where = prismaMock.staffVenue.updateMany.mock.calls[0][0].where
      expect(where.venueId).toBe('venue_1')
      expect(where.active).toBe(true)
      expect(where.role).toEqual({ not: StaffRole.SUPERADMIN }) // SUPERADMIN never deactivated
      expect(where.id).toEqual({ notIn: ['o', 'a'] }) // only the non-kept seats
      const data = prismaMock.staffVenue.updateMany.mock.calls[0][0].data
      expect(data.active).toBe(false)
      expect(data.endDate).toBeInstanceOf(Date)
      // Marks these rows as cap-deactivated so a later re-upgrade can reactivate exactly them.
      expect(data.deactivatedBySeatCap).toBe(true)

      // Field cleared after execution.
      expect(prismaMock.venue.update).toHaveBeenCalledWith({
        where: { id: 'venue_1' },
        data: { pendingSeatReconciliation: null },
      })
    })

    it('is idempotent: no pending field → no-op (no deactivation, no clear)', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ pendingSeatReconciliation: null })
      const deactivated = await executeSeatReconciliation('venue_1')
      expect(deactivated).toBe(0)
      expect(prismaMock.staffVenue.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.venue.update).not.toHaveBeenCalled()
    })

    it('idempotent on a second call: once cleared, the re-run is a no-op', async () => {
      // 1st call: pending present.
      prismaMock.venue.findUnique.mockResolvedValueOnce({
        pendingSeatReconciliation: { keepStaffVenueIds: ['o'], scheduledFor: '', createdAt: '' },
      })
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 2 })
      expect(await executeSeatReconciliation('venue_1')).toBe(2)

      // 2nd call: field now cleared.
      prismaMock.venue.findUnique.mockResolvedValueOnce({ pendingSeatReconciliation: null })
      expect(await executeSeatReconciliation('venue_1')).toBe(0)
      expect(prismaMock.staffVenue.updateMany).toHaveBeenCalledTimes(1) // not called the 2nd time
    })

    it('empty keep list deactivates all cap-counting seats (sentinel notIn avoids matching nothing)', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({
        pendingSeatReconciliation: { keepStaffVenueIds: [], scheduledFor: '', createdAt: '' },
      })
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 0 })
      await executeSeatReconciliation('venue_1')
      // With an empty keep list, the sentinel ['__none__'] ensures notIn doesn't match-everything-then-skip.
      expect(prismaMock.staffVenue.updateMany.mock.calls[0][0].where.id).toEqual({ notIn: ['__none__'] })
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
