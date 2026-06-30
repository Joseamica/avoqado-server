/**
 * Batch Free-tier seat cap — assertCanAddSeatsBulk.
 *
 * Mirrors getVenueSeatCap + canAddSeat semantics for a SET of venues in a constant number of
 * queries. This is the path the OWNER `inviteToAllVenues` fan-out uses so the accept transaction
 * stays O(1) round-trips (prod P2028, 2026-06-30). We assert: exempt/paid short-circuits, the
 * Free-tier cap math (active + pending), and the primary-venue off-by-one exclusion.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findMany: jest.fn() },
    venueFeature: { findMany: jest.fn() },
    staffVenue: { groupBy: jest.fn() },
    invitation: { groupBy: jest.fn(), count: jest.fn() },
  },
}))

import prisma from '../../../../src/utils/prismaClient'
import { assertCanAddSeatsBulk, SEAT_CAP_REACHED_CODE } from '../../../../src/services/access/seatCap.service'
import { ForbiddenError } from '../../../../src/errors/AppError'

const venueFindMany = (prisma as any).venue.findMany as jest.Mock
const featureFindMany = (prisma as any).venueFeature.findMany as jest.Mock
const svGroupBy = (prisma as any).staffVenue.groupBy as jest.Mock
const invGroupBy = (prisma as any).invitation.groupBy as jest.Mock
const invCount = (prisma as any).invitation.count as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  // Defaults: no paid plans, no active seats, no pending invites.
  featureFindMany.mockResolvedValue([])
  svGroupBy.mockResolvedValue([])
  invGroupBy.mockResolvedValue([])
  invCount.mockResolvedValue(0)
})

describe('assertCanAddSeatsBulk', () => {
  it('empty venueIds → no-op, no queries', async () => {
    await expect(assertCanAddSeatsBulk([])).resolves.toBeUndefined()
    expect(venueFindMany).not.toHaveBeenCalled()
  })

  it('all venues exempt (grandfathered) → short-circuits after ONE query, never throws', async () => {
    venueFindMany.mockResolvedValue([
      { id: 'v1', seatCapExempt: true },
      { id: 'v2', seatCapExempt: true },
    ])

    await expect(assertCanAddSeatsBulk(['v1', 'v2'])).resolves.toBeUndefined()

    expect(venueFindMany).toHaveBeenCalledTimes(1)
    // exempt short-circuit: no tier / seat / pending queries
    expect(featureFindMany).not.toHaveBeenCalled()
    expect(svGroupBy).not.toHaveBeenCalled()
  })

  it('unknown venue (not found) → fails open (no cap), never throws', async () => {
    venueFindMany.mockResolvedValue([]) // none of the ids exist
    await expect(assertCanAddSeatsBulk(['ghost'])).resolves.toBeUndefined()
    expect(featureFindMany).not.toHaveBeenCalled()
  })

  it('paid venue (active PLAN_PRO) → unlimited, never throws, no seat counting', async () => {
    venueFindMany.mockResolvedValue([{ id: 'v1', seatCapExempt: false }])
    featureFindMany.mockResolvedValue([{ venueId: 'v1' }]) // has an active paid plan

    await expect(assertCanAddSeatsBulk(['v1'])).resolves.toBeUndefined()
    expect(svGroupBy).not.toHaveBeenCalled()
  })

  it('Free venue under cap (1 active, 0 pending) → allowed', async () => {
    venueFindMany.mockResolvedValue([{ id: 'v1', seatCapExempt: false }])
    svGroupBy.mockResolvedValue([{ venueId: 'v1', _count: { _all: 1 } }])
    await expect(assertCanAddSeatsBulk(['v1'])).resolves.toBeUndefined()
  })

  it('Free venue at cap (2 active) → throws SEAT_CAP_REACHED', async () => {
    venueFindMany.mockResolvedValue([{ id: 'v1', seatCapExempt: false }])
    svGroupBy.mockResolvedValue([{ venueId: 'v1', _count: { _all: 2 } }])

    await expect(assertCanAddSeatsBulk(['v1'])).rejects.toMatchObject({ code: SEAT_CAP_REACHED_CODE })
    await expect(assertCanAddSeatsBulk(['v1'])).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('Free venue at cap via pending (1 active + 1 pending) → throws', async () => {
    venueFindMany.mockResolvedValue([{ id: 'v1', seatCapExempt: false }])
    svGroupBy.mockResolvedValue([{ venueId: 'v1', _count: { _all: 1 } }])
    invGroupBy.mockResolvedValue([{ venueId: 'v1', _count: { _all: 1 } }])
    await expect(assertCanAddSeatsBulk(['v1'])).rejects.toMatchObject({ code: SEAT_CAP_REACHED_CODE })
  })

  it('mixed set: one exempt + one Free-at-cap → throws for the Free one', async () => {
    venueFindMany.mockResolvedValue([
      { id: 'exempt', seatCapExempt: true },
      { id: 'free', seatCapExempt: false },
    ])
    svGroupBy.mockResolvedValue([{ venueId: 'free', _count: { _all: 2 } }])
    await expect(assertCanAddSeatsBulk(['exempt', 'free'])).rejects.toMatchObject({ code: SEAT_CAP_REACHED_CODE })
  })

  it('off-by-one: primary Free venue whose only pending row IS the invite being accepted → allowed', async () => {
    venueFindMany.mockResolvedValue([{ id: 'primary', seatCapExempt: false }])
    svGroupBy.mockResolvedValue([{ venueId: 'primary', _count: { _all: 1 } }]) // 1 active (cap-1)
    invGroupBy.mockResolvedValue([{ venueId: 'primary', _count: { _all: 1 } }]) // groupBy counts the invite itself
    invCount.mockResolvedValue(0) // exclusion query: 0 pending once THIS invite is dropped

    await expect(assertCanAddSeatsBulk(['primary'], { primaryVenueId: 'primary', excludeInvitationId: 'inv-1' })).resolves.toBeUndefined()

    // The exclusion override ran for the primary venue, dropping the invite from the pending count.
    expect(invCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: 'primary', id: { not: 'inv-1' } }) }),
    )
  })
})
