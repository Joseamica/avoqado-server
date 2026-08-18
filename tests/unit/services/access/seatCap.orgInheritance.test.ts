/**
 * Free-plan seat cap when the exemption comes from the ORGANIZATION rather than the venue.
 *
 * The seat cap is the user-visible half of grandfathering: an exempt org must lift the cap on
 * every one of its venues, including stores created long after the rollout backfill. Without
 * this, a legacy client's new store silently caps at 2 users and the block only surfaces when
 * someone tries to invite the third employee.
 *
 * Mocking mirrors seatCap.service.test.ts.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    staffVenue: { count: jest.fn() },
    invitation: { count: jest.fn() },
  },
}))
jest.mock('../../../../src/services/access/basePlan.service', () => {
  const actual = jest.requireActual('../../../../src/services/access/basePlan.service')
  return {
    __esModule: true,
    ...actual,
    getVenueBaseTier: jest.fn(),
  }
})

import prisma from '../../../../src/utils/prismaClient'
import { getVenueBaseTier } from '../../../../src/services/access/basePlan.service'
import { getVenueSeatCap, canAddSeat, assertCanAddSeat, FREE_TIER_SEAT_CAP } from '../../../../src/services/access/seatCap.service'
import { ForbiddenError } from '../../../../src/errors/AppError'

const findUnique = (prisma as any).venue.findUnique as jest.Mock
const seatCount = (prisma as any).staffVenue.count as jest.Mock
const inviteCount = (prisma as any).invitation.count as jest.Mock
const baseTier = getVenueBaseTier as jest.Mock

/** Venue row as the service selects it: own flag + parent organization's flag. */
function venueRow(opts: { own?: boolean; org?: boolean }) {
  return {
    seatCapExempt: opts.own ?? false,
    organization: { seatCapExempt: opts.org ?? false },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  baseTier.mockResolvedValue(null) // no paid plan — the Free cap would apply if not exempt
  inviteCount.mockResolvedValue(0)
  seatCount.mockResolvedValue(0)
})

describe('Seat cap with organization-level exemption', () => {
  it('an exempt ORGANIZATION lifts the cap on a venue that carries no flag of its own', async () => {
    findUnique.mockResolvedValue(venueRow({ own: false, org: true }))
    await expect(getVenueSeatCap('v')).resolves.toBeNull()
  })

  it('lets an exempt org invite past the Free cap — the PlayTelecom case (9 seats used, cap 2)', async () => {
    findUnique.mockResolvedValue(venueRow({ own: false, org: true }))
    seatCount.mockResolvedValue(7)
    inviteCount.mockResolvedValue(2)

    const result = await canAddSeat('v')

    expect(result.allowed).toBe(true)
    expect(result.cap).toBeNull()
    await expect(assertCanAddSeat('v')).resolves.not.toThrow()
  })

  // ─── REGRESSION ───

  it('still lifts the cap from the venue OWN flag when the org is not exempt', async () => {
    findUnique.mockResolvedValue(venueRow({ own: true, org: false }))
    await expect(getVenueSeatCap('v')).resolves.toBeNull()
  })

  it('still enforces the Free cap when NEITHER the venue nor its organization is exempt', async () => {
    findUnique.mockResolvedValue(venueRow({ own: false, org: false }))
    await expect(getVenueSeatCap('v')).resolves.toBe(FREE_TIER_SEAT_CAP)

    seatCount.mockResolvedValue(2)
    const result = await canAddSeat('v')
    expect(result.allowed).toBe(false)
    await expect(assertCanAddSeat('v')).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('still fails open (null) for a venue that does not exist', async () => {
    findUnique.mockResolvedValue(null)
    await expect(getVenueSeatCap('missing')).resolves.toBeNull()
    expect(baseTier).not.toHaveBeenCalled()
  })
})
