/**
 * Unit tests for `checkExternalBusyBlock` (Phase 1 — Task 23).
 *
 * Exhaustive overlap matrix per spec §16.1:
 *   - scope × {venue-only, staff-only, both, neither}
 *   - overlap kind × {exact bounds, partial inside, fully inside, fully outside,
 *                     adjacent (touching), spans whole}
 *   - staffId × {null, set}
 *
 * The function builds a `Prisma.ExternalBusyBlockWhereInput` filter — we assert
 * on the filter shape passed to `findFirst` rather than executing real SQL.
 * Behaviour-level checks (does a row that overlaps actually match?) are pinned
 * by additional emulation-style tests that walk a fake row collection through
 * the same overlap predicate.
 */
import { checkExternalBusyBlock } from '@/services/reservation/external-busy-block.service'

const VENUE_A = 'venue-A'
const VENUE_B = 'venue-B'
const STAFF_1 = 'staff-1'

type FakeBlock = {
  id: string
  venueId: string | null
  staffId: string | null
  startsAt: Date
  endsAt: Date
}

/**
 * Local emulation of the half-open overlap predicate used by the SQL filter
 * (`startsAt < range.end AND endsAt > range.start`). Used for behaviour tests.
 */
function rowMatches(
  block: FakeBlock,
  scope: { venueId: string; staffId?: string | null },
  range: { startsAt: Date; endsAt: Date },
): boolean {
  const scopeMatch = block.venueId === scope.venueId || (!!scope.staffId && block.staffId === scope.staffId)
  if (!scopeMatch) return false
  return block.startsAt < range.endsAt && block.endsAt > range.startsAt
}

function makeTx(rows: FakeBlock[]): {
  tx: any
  findFirstMock: jest.Mock
} {
  const findFirstMock = jest.fn(async ({ where }: { where: any }) => {
    const scope: { venueId: string; staffId?: string | null } = {
      venueId: where.OR[0].venueId,
      staffId: where.OR[1]?.staffId ?? null,
    }
    const range = { startsAt: where.endsAt.gt, endsAt: where.startsAt.lt }
    return rows.find(r => rowMatches(r, scope, range)) ?? null
  })
  const tx = { externalBusyBlock: { findFirst: findFirstMock } }
  return { tx, findFirstMock }
}

const at = (iso: string) => new Date(iso)

describe('checkExternalBusyBlock — overlap matrix (Task 23)', () => {
  // ============================================================
  // NEW FEATURE TESTS — venue-master block (staffId = null in query)
  // ============================================================

  describe('venue-master block, staffId null in query', () => {
    const block: FakeBlock = {
      id: 'b1',
      venueId: VENUE_A,
      staffId: null,
      startsAt: at('2026-05-15T10:00:00Z'),
      endsAt: at('2026-05-15T11:00:00Z'),
    }

    it('exact-bound overlap → returns block', async () => {
      const { tx } = makeTx([block])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: null,
        startsAt: at('2026-05-15T10:00:00Z'),
        endsAt: at('2026-05-15T11:00:00Z'),
      })
      expect(r?.id).toBe('b1')
    })

    it('partial-inside (request straddles block end) → returns block', async () => {
      const { tx } = makeTx([block])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: null,
        startsAt: at('2026-05-15T10:30:00Z'),
        endsAt: at('2026-05-15T11:30:00Z'),
      })
      expect(r?.id).toBe('b1')
    })

    it('fully-inside (block contains request) → returns block', async () => {
      const { tx } = makeTx([block])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: null,
        startsAt: at('2026-05-15T10:15:00Z'),
        endsAt: at('2026-05-15T10:45:00Z'),
      })
      expect(r?.id).toBe('b1')
    })

    it('spans-whole (request contains block) → returns block', async () => {
      const { tx } = makeTx([block])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: null,
        startsAt: at('2026-05-15T09:00:00Z'),
        endsAt: at('2026-05-15T12:00:00Z'),
      })
      expect(r?.id).toBe('b1')
    })

    it('fully-outside (before) → returns null', async () => {
      const { tx } = makeTx([block])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: null,
        startsAt: at('2026-05-15T08:00:00Z'),
        endsAt: at('2026-05-15T09:00:00Z'),
      })
      expect(r).toBeNull()
    })

    it('fully-outside (after) → returns null', async () => {
      const { tx } = makeTx([block])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: null,
        startsAt: at('2026-05-15T12:00:00Z'),
        endsAt: at('2026-05-15T13:00:00Z'),
      })
      expect(r).toBeNull()
    })

    it('adjacent-left (request ends exactly when block starts) → returns null', async () => {
      const { tx } = makeTx([block])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: null,
        startsAt: at('2026-05-15T09:00:00Z'),
        endsAt: at('2026-05-15T10:00:00Z'),
      })
      expect(r).toBeNull()
    })

    it('adjacent-right (request starts exactly when block ends) → returns null', async () => {
      const { tx } = makeTx([block])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: null,
        startsAt: at('2026-05-15T11:00:00Z'),
        endsAt: at('2026-05-15T12:00:00Z'),
      })
      expect(r).toBeNull()
    })

    it('different venue → returns null', async () => {
      const { tx } = makeTx([block])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_B,
        staffId: null,
        startsAt: at('2026-05-15T10:00:00Z'),
        endsAt: at('2026-05-15T11:00:00Z'),
      })
      expect(r).toBeNull()
    })
  })

  // ============================================================
  // NEW FEATURE TESTS — staff-personal block
  // ============================================================

  describe('staff-personal block', () => {
    const staffBlock: FakeBlock = {
      id: 'sb',
      venueId: null,
      staffId: STAFF_1,
      startsAt: at('2026-05-15T14:00:00Z'),
      endsAt: at('2026-05-15T15:00:00Z'),
    }

    it('matches when query passes staffId', async () => {
      const { tx } = makeTx([staffBlock])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: STAFF_1,
        startsAt: at('2026-05-15T14:00:00Z'),
        endsAt: at('2026-05-15T15:00:00Z'),
      })
      expect(r?.id).toBe('sb')
    })

    it('does NOT match when staffId is omitted from query', async () => {
      const { tx } = makeTx([staffBlock])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: null,
        startsAt: at('2026-05-15T14:00:00Z'),
        endsAt: at('2026-05-15T15:00:00Z'),
      })
      expect(r).toBeNull()
    })

    it('does NOT match a different staff member', async () => {
      const { tx } = makeTx([staffBlock])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: 'staff-other',
        startsAt: at('2026-05-15T14:00:00Z'),
        endsAt: at('2026-05-15T15:00:00Z'),
      })
      expect(r).toBeNull()
    })

    it('staff-personal block applies at venue A AND venue B (multi-venue staff regression)', async () => {
      const { tx } = makeTx([staffBlock])
      const atA = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: STAFF_1,
        startsAt: at('2026-05-15T14:00:00Z'),
        endsAt: at('2026-05-15T15:00:00Z'),
      })
      const atB = await checkExternalBusyBlock(tx, {
        venueId: VENUE_B,
        staffId: STAFF_1,
        startsAt: at('2026-05-15T14:00:00Z'),
        endsAt: at('2026-05-15T15:00:00Z'),
      })
      expect(atA?.id).toBe('sb')
      expect(atB?.id).toBe('sb')
    })
  })

  // ============================================================
  // NEW FEATURE TESTS — both venue + staff blocks coexisting
  // ============================================================

  describe('venue-master + staff-personal blocks', () => {
    it('venue block matches when staff has no block', async () => {
      const { tx } = makeTx([
        {
          id: 'v',
          venueId: VENUE_A,
          staffId: null,
          startsAt: at('2026-05-15T10:00:00Z'),
          endsAt: at('2026-05-15T11:00:00Z'),
        },
      ])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: STAFF_1,
        startsAt: at('2026-05-15T10:00:00Z'),
        endsAt: at('2026-05-15T11:00:00Z'),
      })
      expect(r?.id).toBe('v')
    })

    it('staff block matches when venue has no block', async () => {
      const { tx } = makeTx([
        {
          id: 's',
          venueId: null,
          staffId: STAFF_1,
          startsAt: at('2026-05-15T10:00:00Z'),
          endsAt: at('2026-05-15T11:00:00Z'),
        },
      ])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: STAFF_1,
        startsAt: at('2026-05-15T10:00:00Z'),
        endsAt: at('2026-05-15T11:00:00Z'),
      })
      expect(r?.id).toBe('s')
    })

    it('returns null when neither block overlaps even though both exist', async () => {
      const { tx } = makeTx([
        {
          id: 'v',
          venueId: VENUE_A,
          staffId: null,
          startsAt: at('2026-05-15T08:00:00Z'),
          endsAt: at('2026-05-15T09:00:00Z'),
        },
        {
          id: 's',
          venueId: null,
          staffId: STAFF_1,
          startsAt: at('2026-05-15T20:00:00Z'),
          endsAt: at('2026-05-15T21:00:00Z'),
        },
      ])
      const r = await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: STAFF_1,
        startsAt: at('2026-05-15T10:00:00Z'),
        endsAt: at('2026-05-15T11:00:00Z'),
      })
      expect(r).toBeNull()
    })
  })

  // ============================================================
  // WHERE-CLAUSE SHAPE — pin the filter the helper builds
  // ============================================================

  describe('where clause shape', () => {
    it('omits staff OR-branch when staffId is null', async () => {
      const { tx, findFirstMock } = makeTx([])
      await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: null,
        startsAt: at('2026-05-15T10:00:00Z'),
        endsAt: at('2026-05-15T11:00:00Z'),
      })
      const call = findFirstMock.mock.calls[0][0]
      expect(call.where.OR).toEqual([{ venueId: VENUE_A }])
    })

    it('omits staff OR-branch when staffId is undefined', async () => {
      const { tx, findFirstMock } = makeTx([])
      await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        startsAt: at('2026-05-15T10:00:00Z'),
        endsAt: at('2026-05-15T11:00:00Z'),
      })
      const call = findFirstMock.mock.calls[0][0]
      expect(call.where.OR).toEqual([{ venueId: VENUE_A }])
    })

    it('adds staff OR-branch when staffId is provided', async () => {
      const { tx, findFirstMock } = makeTx([])
      await checkExternalBusyBlock(tx, {
        venueId: VENUE_A,
        staffId: STAFF_1,
        startsAt: at('2026-05-15T10:00:00Z'),
        endsAt: at('2026-05-15T11:00:00Z'),
      })
      const call = findFirstMock.mock.calls[0][0]
      expect(call.where.OR).toEqual([{ venueId: VENUE_A }, { staffId: STAFF_1 }])
    })

    it('uses half-open interval predicate (startsAt < endsAt, endsAt > startsAt)', async () => {
      const { tx, findFirstMock } = makeTx([])
      const startsAt = at('2026-05-15T10:00:00Z')
      const endsAt = at('2026-05-15T11:00:00Z')
      await checkExternalBusyBlock(tx, { venueId: VENUE_A, startsAt, endsAt })
      const call = findFirstMock.mock.calls[0][0]
      expect(call.where.startsAt).toEqual({ lt: endsAt })
      expect(call.where.endsAt).toEqual({ gt: startsAt })
    })
  })
})
