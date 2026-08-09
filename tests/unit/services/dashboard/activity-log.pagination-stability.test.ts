/**
 * Activity-log list pagination stability (Asana 1217127206664238)
 *
 * Same defect as the sale-verification lists, on the table an owner audits. Audit rows
 * are written in BURSTS — one request that touches several entities, a bulk import, a
 * fan-out over a venue's staff — so many rows land on a byte-identical `createdAt`.
 * Measured on prod: 15,508 rows with tie groups of up to 71.
 *
 * Ordering on `createdAt` alone leaves those ties for Postgres to arrange however it
 * likes per query, and all three of these lists are read page-by-page (skip/take). A tie
 * group straddling a page boundary serves a row twice on one page and never on the next,
 * so entries silently disappear from the audit trail — the one thing an audit trail
 * cannot be allowed to do.
 *
 * Fix: append the unique `id` so the sort key is total.
 *
 * These tests page through a fake Postgres that is free to shuffle ties (exactly the
 * latitude the real planner has). Without the `id` tiebreak the sweep loses rows.
 */

// `tests/__helpers__/setup.ts` mocks this whole service GLOBALLY (its `logAction` is
// fire-and-forget, so most suites never want the real thing) and the global mock exposes
// ONLY `logAction`. Without this unmock the query functions under test are `undefined`
// and every assertion below fails with "is not a function".
jest.unmock('@/services/dashboard/activity-log.service')

import { queryActivityLogs, queryVenueActivityLogs, querySuperadminActivityLogs } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    activityLog: { findMany: jest.fn(), count: jest.fn() },
    venue: { findMany: jest.fn(), findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const mockPrisma = prisma as unknown as {
  activityLog: { findMany: jest.Mock; count: jest.Mock }
  venue: { findMany: jest.Mock; findUnique: jest.Mock }
}

const ORG_ID = 'org_playtelecom'
const VENUE_ID = 'venue_bae_ricardo_b_anaya'
const PAGE_SIZE = 25 // the service default

/**
 * 6 write bursts of deliberately UNEVEN size, each burst sharing ONE timestamp — the
 * real shape of audit traffic. None of the running offsets lands on a page boundary,
 * so tie groups straddle pages, which is precisely where an unstable sort loses rows.
 * Even-sized bursts would HIDE the bug, because each page would hold whole tie groups.
 */
const BURST_SIZES = [71, 18, 43, 9, 34, 27] // 202 total, none a multiple of PAGE_SIZE
const TOTAL = BURST_SIZES.reduce((a, b) => a + b, 0)
const TOTAL_PAGES = Math.ceil(TOTAL / PAGE_SIZE)

function buildLogs() {
  const rows: Array<{ id: string; createdAt: Date; action: string }> = []
  let idx = 0
  BURST_SIZES.forEach((count, burst) => {
    // One burst → one identical timestamp for every row it wrote.
    const createdAt = new Date(Date.UTC(2026, 7, 1 + burst, 17, 42, 11, 508))
    for (let n = 0; n < count; n++, idx++) {
      rows.push({ id: `log_${String(idx).padStart(4, '0')}`, createdAt, action: 'ITEM_COMPED' })
    }
  })
  return rows
}

/** Deterministic per-query shuffle — stands in for the planner's freedom to reorder ties. */
function shuffleForPage<T>(rows: T[], seed: number): T[] {
  const out = [...rows]
  for (let i = out.length - 1; i > 0; i--) {
    const j = (i * 7 + seed * 13 + 5) % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Applies `orderBy` the way Postgres legitimately may: rows equal on every supplied key
 * are shuffled per query. A total sort key leaves nothing to shuffle.
 */
function applyOrderBy<T extends { id: string; createdAt: Date }>(rows: T[], orderBy: unknown, seed: number): T[] {
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, 'asc' | 'desc'>>
  return [...shuffleForPage(rows, seed)].sort((a, b) => {
    for (const key of keys) {
      const [field, dir] = Object.entries(key)[0] as [keyof typeof a, 'asc' | 'desc']
      const av = a[field] instanceof Date ? (a[field] as Date).getTime() : a[field]
      const bv = b[field] instanceof Date ? (b[field] as Date).getTime() : b[field]
      if (av === bv) continue
      return dir === 'desc' ? (av < bv ? 1 : -1) : av < bv ? -1 : 1
    }
    return 0 // fully tied — keeps the shuffled order, which is the whole hazard
  })
}

/** Wires the fake planner into activityLog.findMany, one fresh plan per query. */
function serveLogs(rows: ReturnType<typeof buildLogs>, startSeed = 0) {
  let seed = startSeed
  mockPrisma.activityLog.count.mockResolvedValue(rows.length)
  mockPrisma.activityLog.findMany.mockImplementation(async ({ orderBy, skip, take }: any) =>
    applyOrderBy(rows, orderBy, seed++)
      .slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length))
      .map(r => ({
        id: r.id,
        action: r.action,
        entity: 'OrderItem',
        entityId: 'oi_1',
        data: null,
        ipAddress: null,
        createdAt: r.createdAt,
        staffId: 'staff_1',
        venueId: VENUE_ID,
        staff: { id: 'staff_1', firstName: 'Fatima', lastName: 'Flores' },
      })),
  )
}

describe('Activity-log pagination stability (Asana 1217127206664238)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPrisma.venue.findMany.mockResolvedValue([{ id: VENUE_ID, name: 'BAE RICARDO B ANAYA' }])
    mockPrisma.venue.findUnique.mockResolvedValue({ id: VENUE_ID, name: 'BAE RICARDO B ANAYA', timezone: 'America/Mexico_City' })
  })

  // ── NEW BEHAVIOUR: a full paginated sweep must not lose or duplicate an audit row ──

  it('org list: paging through every page returns each entry exactly once, even when ties are reordered', async () => {
    const logs = buildLogs()
    serveLogs(logs)

    const collected: string[] = []
    for (let page = 1; page <= TOTAL_PAGES; page++) {
      const res = await queryActivityLogs({ organizationId: ORG_ID, page, pageSize: PAGE_SIZE })
      collected.push(...res.logs.map(l => l.id))
    }

    expect(collected).toHaveLength(TOTAL)
    expect(new Set(collected).size).toBe(TOTAL) // no duplicates → nothing was dropped
    expect([...collected].sort()).toEqual(logs.map(l => l.id).sort())
  })

  it('venue list (owner audit screen): paging returns each entry exactly once', async () => {
    const logs = buildLogs()
    serveLogs(logs, 100)

    const collected: string[] = []
    for (let page = 1; page <= TOTAL_PAGES; page++) {
      const res = await queryVenueActivityLogs({ venueId: VENUE_ID, page, pageSize: PAGE_SIZE })
      collected.push(...res.logs.map(l => l.id))
    }

    expect(collected).toHaveLength(TOTAL)
    expect(new Set(collected).size).toBe(TOTAL)
  })

  it('superadmin list: paging returns each entry exactly once', async () => {
    const logs = buildLogs()
    serveLogs(logs, 200)

    const collected: string[] = []
    for (let page = 1; page <= TOTAL_PAGES; page++) {
      const res = await querySuperadminActivityLogs({ page, pageSize: PAGE_SIZE })
      collected.push(...res.logs.map(l => l.id))
    }

    expect(collected).toHaveLength(TOTAL)
    expect(new Set(collected).size).toBe(TOTAL)
  })

  // ── The invariant behind it: a UNIQUE trailing sort key ──

  it('all three lists order by a unique tiebreak, not createdAt alone', async () => {
    serveLogs([])

    await queryActivityLogs({ organizationId: ORG_ID, page: 1, pageSize: PAGE_SIZE })
    await queryVenueActivityLogs({ venueId: VENUE_ID, page: 1, pageSize: PAGE_SIZE })
    await querySuperadminActivityLogs({ page: 1, pageSize: PAGE_SIZE })

    expect(mockPrisma.activityLog.findMany).toHaveBeenCalledTimes(3)
    for (const call of mockPrisma.activityLog.findMany.mock.calls) {
      const { orderBy } = call[0] as any
      expect(Array.isArray(orderBy)).toBe(true)
      expect(orderBy[0]).toEqual({ createdAt: 'desc' })
      expect(orderBy[orderBy.length - 1]).toHaveProperty('id')
    }
  })

  // ── REGRESSION: ordering, scoping, filtering and paging must be unchanged ──

  it('still returns entries newest-first', async () => {
    const logs = buildLogs()
    serveLogs(logs)

    const res = await queryActivityLogs({ organizationId: ORG_ID, page: 1, pageSize: PAGE_SIZE })
    const dates = res.logs.map(l => new Date(l.createdAt).getTime())
    expect(dates).toEqual([...dates].sort((a, b) => b - a))
  })

  it('scopes the org list to authoritative org rows plus legacy rows from its venues and still pages', async () => {
    serveLogs([])

    await queryActivityLogs({ organizationId: ORG_ID, page: 3, pageSize: PAGE_SIZE })

    const arg = mockPrisma.activityLog.findMany.mock.calls[0][0] as any
    // H1 rows may have no venue, while legacy rows have no organizationId; the
    // tenant OR must remain the first AND branch so later filters cannot erase it.
    expect(arg.where.AND[0]).toEqual({
      OR: [{ organizationId: ORG_ID }, { organizationId: null, venueId: { in: [VENUE_ID] } }],
    })
    expect(arg.skip).toBe(2 * PAGE_SIZE)
    expect(arg.take).toBe(PAGE_SIZE)
  })

  it('still scopes the venue list to one venue and still applies the action filter', async () => {
    serveLogs([])

    await queryVenueActivityLogs({ venueId: VENUE_ID, action: 'ITEM_COMPED', page: 1, pageSize: PAGE_SIZE })

    const arg = mockPrisma.activityLog.findMany.mock.calls[0][0] as any
    expect(arg.where).toMatchObject({ venueId: VENUE_ID, action: 'ITEM_COMPED' })
  })

  it('still reports the total and page count from count(), not from the page length', async () => {
    const logs = buildLogs()
    serveLogs(logs)

    const res = await queryActivityLogs({ organizationId: ORG_ID, page: 1, pageSize: PAGE_SIZE })
    expect(res.pagination.total).toBe(TOTAL)
    expect(res.pagination.totalPages).toBe(TOTAL_PAGES)
  })
})
