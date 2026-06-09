/**
 * Free-plan seat cap (max 2 users per venue = active seats + pending invitations), with
 * grandfathering.
 *
 * Mocking strategy (mirrors the access test style):
 *   - prismaClient is fully mocked: venue.findUnique + staffVenue.count + invitation.count
 *     are the only reads seatCap.service makes directly.
 *   - basePlan.service is mocked so we can drive the venue's tier per test without
 *     wiring up venueFeature rows.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    staffVenue: { count: jest.fn() },
    invitation: { count: jest.fn() },
  },
}))
jest.mock('../../../../src/services/access/basePlan.service', () => ({
  __esModule: true,
  getVenueBaseTier: jest.fn(),
}))

import { InvitationStatus, StaffRole } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { getVenueBaseTier } from '../../../../src/services/access/basePlan.service'
import {
  getVenueSeatCap,
  getActiveSeatCount,
  getPendingInvitationCount,
  canAddSeat,
  assertCanAddSeat,
  FREE_TIER_SEAT_CAP,
  SEAT_CAP_REACHED_CODE,
} from '../../../../src/services/access/seatCap.service'
import { ForbiddenError } from '../../../../src/errors/AppError'

const findUnique = (prisma as any).venue.findUnique as jest.Mock
const count = (prisma as any).staffVenue.count as jest.Mock
const inviteCount = (prisma as any).invitation.count as jest.Mock
const baseTier = getVenueBaseTier as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  // Default: no pending invitations. Individual tests override via `pending`.
  inviteCount.mockResolvedValue(0)
})

/**
 * Configure the venue's exempt flag + entitled tier + ACTIVE seat count + PENDING invite count.
 * `seats` = active StaffVenue rows; `pending` = outstanding invitations (defaults to 0 so the
 * existing assertions that pass `seats` as the full usage keep their meaning).
 */
function setup(opts: { exempt: boolean; tier: 'PRO' | 'PREMIUM' | null; seats: number; pending?: number }) {
  findUnique.mockResolvedValue({ seatCapExempt: opts.exempt })
  baseTier.mockResolvedValue(opts.tier)
  count.mockResolvedValue(opts.seats)
  inviteCount.mockResolvedValue(opts.pending ?? 0)
}

describe('getVenueSeatCap', () => {
  it('exempt (grandfathered) venue → null (unlimited), tier never consulted', async () => {
    setup({ exempt: true, tier: null, seats: 99 })
    expect(await getVenueSeatCap('v')).toBeNull()
    expect(baseTier).not.toHaveBeenCalled()
  })

  it('Free non-exempt venue → cap = FREE_TIER_SEAT_CAP (2)', async () => {
    setup({ exempt: false, tier: null, seats: 0 })
    expect(await getVenueSeatCap('v')).toBe(FREE_TIER_SEAT_CAP)
    expect(FREE_TIER_SEAT_CAP).toBe(2)
  })

  it('Pro venue → null (unlimited)', async () => {
    setup({ exempt: false, tier: 'PRO', seats: 50 })
    expect(await getVenueSeatCap('v')).toBeNull()
  })

  it('Premium venue → null (unlimited)', async () => {
    setup({ exempt: false, tier: 'PREMIUM', seats: 50 })
    expect(await getVenueSeatCap('v')).toBeNull()
  })

  it('unknown venue → null (fail open), tier never consulted', async () => {
    findUnique.mockResolvedValue(null)
    expect(await getVenueSeatCap('missing')).toBeNull()
    expect(baseTier).not.toHaveBeenCalled()
  })
})

describe('getActiveSeatCount', () => {
  it('counts active, non-SUPERADMIN StaffVenue rows for the venue', async () => {
    count.mockResolvedValue(3)
    const n = await getActiveSeatCount('v')
    expect(n).toBe(3)
    expect(count).toHaveBeenCalledWith({
      where: { venueId: 'v', active: true, role: { not: StaffRole.SUPERADMIN } },
    })
  })

  it('SUPERADMIN rows are excluded from the cap count (where filter proves it)', async () => {
    // The count query filters role != SUPERADMIN, so support seats never count.
    count.mockResolvedValue(2)
    await getActiveSeatCount('v')
    const where = count.mock.calls[0][0].where
    expect(where.role).toEqual({ not: StaffRole.SUPERADMIN })
    expect(where.active).toBe(true)
  })
})

describe('getPendingInvitationCount', () => {
  it('counts PENDING, not-yet-expired, non-SUPERADMIN invites for the venue', async () => {
    inviteCount.mockResolvedValue(3)
    const n = await getPendingInvitationCount('v')
    expect(n).toBe(3)
    const where = inviteCount.mock.calls[0][0].where
    expect(where.venueId).toBe('v')
    expect(where.status).toBe(InvitationStatus.PENDING)
    expect(where.role).toEqual({ not: StaffRole.SUPERADMIN })
    // expired-but-pending must not count → filters expiresAt > now
    expect(where.expiresAt.gt).toBeInstanceOf(Date)
    // no exclusion by default
    expect(where.id).toBeUndefined()
  })

  it('excludeInvitationId drops one specific invite from the count (off-by-one guard for accept)', async () => {
    inviteCount.mockResolvedValue(0)
    await getPendingInvitationCount('v', { excludeInvitationId: 'inv-being-accepted' })
    const where = inviteCount.mock.calls[0][0].where
    expect(where.id).toEqual({ not: 'inv-being-accepted' })
  })
})

describe('canAddSeat', () => {
  it('exempt venue → always allowed (cap null), reports active+pending breakdown', async () => {
    setup({ exempt: true, tier: null, seats: 47, pending: 3 })
    expect(await canAddSeat('v')).toEqual({ allowed: true, cap: null, current: 50, active: 47, pending: 3 })
  })

  it('Free venue at 1 active + 0 pending → allowed (1 < 2)', async () => {
    setup({ exempt: false, tier: null, seats: 1, pending: 0 })
    expect(await canAddSeat('v')).toEqual({ allowed: true, cap: 2, current: 1, active: 1, pending: 0 })
  })

  it('Free venue at 1 active + 1 pending → blocked (1+1 = cap)', async () => {
    setup({ exempt: false, tier: null, seats: 1, pending: 1 })
    expect(await canAddSeat('v')).toEqual({ allowed: false, cap: 2, current: 2, active: 1, pending: 1 })
  })

  it('Free venue at 2 active + 0 pending → blocked (2 is the cap)', async () => {
    setup({ exempt: false, tier: null, seats: 2, pending: 0 })
    expect(await canAddSeat('v')).toEqual({ allowed: false, cap: 2, current: 2, active: 2, pending: 0 })
  })

  it('Free venue over cap (2 active + 2 pending) → blocked', async () => {
    setup({ exempt: false, tier: null, seats: 2, pending: 2 })
    expect(await canAddSeat('v')).toEqual({ allowed: false, cap: 2, current: 4, active: 2, pending: 2 })
  })

  it('excludeInvitationId is threaded into the pending count (accept-time path)', async () => {
    setup({ exempt: false, tier: null, seats: 1, pending: 0 })
    await canAddSeat('v', { excludeInvitationId: 'inv-1' })
    expect(inviteCount.mock.calls[0][0].where.id).toEqual({ not: 'inv-1' })
  })

  it('Pro venue → unlimited, allowed regardless of seat + pending count', async () => {
    setup({ exempt: false, tier: 'PRO', seats: 100, pending: 5 })
    expect(await canAddSeat('v')).toEqual({ allowed: true, cap: null, current: 105, active: 100, pending: 5 })
  })
})

describe('assertCanAddSeat', () => {
  it('no-op for exempt venue, even with many pending invites', async () => {
    setup({ exempt: true, tier: null, seats: 99, pending: 99 })
    await expect(assertCanAddSeat('v')).resolves.toBeUndefined()
  })

  it('no-op for Pro/Premium venue, even with many pending invites', async () => {
    setup({ exempt: false, tier: 'PREMIUM', seats: 99, pending: 99 })
    await expect(assertCanAddSeat('v')).resolves.toBeUndefined()
  })

  it('no-op for Free venue under the cap (1 active + 0 pending)', async () => {
    setup({ exempt: false, tier: null, seats: 1, pending: 0 })
    await expect(assertCanAddSeat('v')).resolves.toBeUndefined()
  })

  it('THROWS for a Free venue at 1 active + 1 pending (the founder bug: can\'t send a 2nd invite)', async () => {
    setup({ exempt: false, tier: null, seats: 1, pending: 1 })
    await expect(assertCanAddSeat('v')).rejects.toMatchObject({
      statusCode: 403,
      code: SEAT_CAP_REACHED_CODE,
    })
  })

  it('throws SEAT_CAP_REACHED (403) for a Free venue at 2 active + 0 pending', async () => {
    setup({ exempt: false, tier: null, seats: 2, pending: 0 })
    await expect(assertCanAddSeat('v')).rejects.toMatchObject({
      statusCode: 403,
      code: SEAT_CAP_REACHED_CODE,
    })
  })

  it('off-by-one guard: at accept, excluding the invite being accepted keeps a legit accept allowed', async () => {
    // 1 active (the OWNER) + the single invite this person is accepting (still PENDING right now).
    // Without the exclusion this would be 1 + 1 = cap → wrongly blocked. With excludeInvitationId
    // the pending count drops to 0 → 1 < 2 → allowed.
    setup({ exempt: false, tier: null, seats: 1, pending: 0 }) // inviteCount mocked to honor the exclusion → 0
    await expect(assertCanAddSeat('v', { excludeInvitationId: 'inv-being-accepted' })).resolves.toBeUndefined()
    expect(inviteCount.mock.calls[0][0].where.id).toEqual({ not: 'inv-being-accepted' })
  })

  it('thrown error is a ForbiddenError with a Spanish, user-facing message naming the cap + pending invites', async () => {
    setup({ exempt: false, tier: null, seats: 1, pending: 1 })
    let err: any
    try {
      await assertCanAddSeat('v')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ForbiddenError)
    expect(err.message).toContain('límite de 2 usuarios del plan Gratis')
    expect(err.message).toContain('invitaciones pendientes')
    expect(err.message).toContain('Mejora a Pro')
  })
})

