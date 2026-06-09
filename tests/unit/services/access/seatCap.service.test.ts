/**
 * Free-plan seat cap (max 2 active users per venue), with grandfathering.
 *
 * Mocking strategy (mirrors the access test style):
 *   - prismaClient is fully mocked: venue.findUnique + staffVenue.count are the only
 *     reads seatCap.service makes directly.
 *   - basePlan.service is mocked so we can drive the venue's tier per test without
 *     wiring up venueFeature rows.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    staffVenue: { count: jest.fn() },
  },
}))
jest.mock('../../../../src/services/access/basePlan.service', () => ({
  __esModule: true,
  getVenueBaseTier: jest.fn(),
}))

import { StaffRole } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { getVenueBaseTier } from '../../../../src/services/access/basePlan.service'
import {
  getVenueSeatCap,
  getActiveSeatCount,
  canAddSeat,
  assertCanAddSeat,
  FREE_TIER_SEAT_CAP,
  SEAT_CAP_REACHED_CODE,
} from '../../../../src/services/access/seatCap.service'
import { ForbiddenError } from '../../../../src/errors/AppError'

const findUnique = (prisma as any).venue.findUnique as jest.Mock
const count = (prisma as any).staffVenue.count as jest.Mock
const baseTier = getVenueBaseTier as jest.Mock

beforeEach(() => jest.clearAllMocks())

/** Configure the venue's exempt flag + entitled tier + active seat count. */
function setup(opts: { exempt: boolean; tier: 'PRO' | 'PREMIUM' | null; seats: number }) {
  findUnique.mockResolvedValue({ seatCapExempt: opts.exempt })
  baseTier.mockResolvedValue(opts.tier)
  count.mockResolvedValue(opts.seats)
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

describe('canAddSeat', () => {
  it('exempt venue → always allowed (cap null)', async () => {
    setup({ exempt: true, tier: null, seats: 47 })
    expect(await canAddSeat('v')).toEqual({ allowed: true, cap: null, current: 47 })
  })

  it('Free venue at 1 seat → allowed (1 < 2)', async () => {
    setup({ exempt: false, tier: null, seats: 1 })
    expect(await canAddSeat('v')).toEqual({ allowed: true, cap: 2, current: 1 })
  })

  it('Free venue at 2 seats → blocked (2 is the cap)', async () => {
    setup({ exempt: false, tier: null, seats: 2 })
    expect(await canAddSeat('v')).toEqual({ allowed: false, cap: 2, current: 2 })
  })

  it('Free venue over cap (3 seats, e.g. just-downgraded) → blocked', async () => {
    setup({ exempt: false, tier: null, seats: 3 })
    expect(await canAddSeat('v')).toEqual({ allowed: false, cap: 2, current: 3 })
  })

  it('Pro venue → unlimited, allowed regardless of seat count', async () => {
    setup({ exempt: false, tier: 'PRO', seats: 100 })
    expect(await canAddSeat('v')).toEqual({ allowed: true, cap: null, current: 100 })
  })
})

describe('assertCanAddSeat', () => {
  it('no-op for exempt venue', async () => {
    setup({ exempt: true, tier: null, seats: 99 })
    await expect(assertCanAddSeat('v')).resolves.toBeUndefined()
  })

  it('no-op for Pro/Premium venue', async () => {
    setup({ exempt: false, tier: 'PREMIUM', seats: 99 })
    await expect(assertCanAddSeat('v')).resolves.toBeUndefined()
  })

  it('no-op for Free venue under the cap', async () => {
    setup({ exempt: false, tier: null, seats: 1 })
    await expect(assertCanAddSeat('v')).resolves.toBeUndefined()
  })

  it('throws SEAT_CAP_REACHED (403) for a full Free venue', async () => {
    setup({ exempt: false, tier: null, seats: 2 })
    await expect(assertCanAddSeat('v')).rejects.toMatchObject({
      statusCode: 403,
      code: SEAT_CAP_REACHED_CODE,
    })
  })

  it('thrown error is a ForbiddenError with a Spanish, user-facing message naming the cap', async () => {
    setup({ exempt: false, tier: null, seats: 2 })
    let err: any
    try {
      await assertCanAddSeat('v')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ForbiddenError)
    expect(err.message).toContain('límite de 2 usuarios del plan Gratis')
    expect(err.message).toContain('Mejora a Pro')
  })
})
