/**
 * Sale-verification list pagination stability (Asana 1217127206664238)
 *
 * Bug: Isaac reported 4 ICCIDs that were SOLD in the DB but missing from the org
 * "ventas históricas" Excel — while the manual-upload screen refused them with
 * "ICCID ya vendido". Both screens were right: the sale existed, the EXPORT lost it.
 *
 * Root cause: both paginated lists ordered by `createdAt` alone. Manual uploads
 * ("Subir ventas fuera de TPV") backdate every sale of a given day to the SAME
 * noon-anchored instant (manualSale.service.ts), so one busy day is a large group of
 * rows with a byte-identical `createdAt`. A non-unique sort key lets Postgres order
 * ties differently per query; the Excel export reads the list page-by-page
 * (skip/take), so a tie group straddling a page boundary lands a row twice on one
 * page and never on the next. Reproduced against prod: 5 of 5552 sales silently
 * dropped, including 2 of the 4 ICCIDs Isaac reported.
 *
 * Fix: append the unique `id` as a tiebreak so the sort key is total.
 *
 * These tests page through a fake Postgres that is free to shuffle ties (exactly the
 * latitude the real planner has). Without the `id` tiebreak the sweep loses rows.
 */

import { listOrgSaleVerifications } from '@/services/dashboard/sale-verification.org.dashboard.service'
import { listSaleVerificationsWithDetails } from '@/services/dashboard/sale-verification.dashboard.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn(), count: jest.fn() },
    saleVerification: { findMany: jest.fn() },
    staffVenue: { findMany: jest.fn() },
    terminal: { findMany: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const mockPrisma = prisma as unknown as {
  payment: { findMany: jest.Mock; count: jest.Mock }
  terminal: { findMany: jest.Mock }
}

const ORG_ID = 'org_playtelecom'
const VENUE_ID = 'venue_bae_ricardo_b_anaya'
const PAGE_SIZE = 20

/**
 * Sales over 5 calendar days, all sales of a day sharing ONE identical timestamp —
 * exactly how a manual upload backdates a day's sales to the same noon anchor.
 *
 * The per-day counts are deliberately UNEVEN (23/19/31/17/25 — the real shape of
 * PlayTelecom's prod data) so tie groups do NOT line up with page boundaries. That
 * misalignment is the hazard: a tie group split across two pages is what lets an
 * unstable sort serve a row twice on one page and never on the next. Even day counts
 * would hide the bug, because each page would hold one whole tie group.
 */
const SALES_PER_DAY = [23, 19, 31, 17, 25] // 115 total, none a multiple of PAGE_SIZE

function buildSales() {
  const rows: Array<{ id: string; createdAt: Date; serial: string }> = []
  let idx = 0
  SALES_PER_DAY.forEach((count, day) => {
    const createdAt = new Date(Date.UTC(2026, 6, 20 + day, 18, 0, 0)) // noon Mexico → 18:00Z
    for (let n = 0; n < count; n++, idx++) {
      rows.push({ id: `pay_${String(idx).padStart(3, '0')}`, createdAt, serial: `895214000000000${String(idx).padStart(4, '0')}F` })
    }
  })
  return rows
}

/** Pages needed to sweep the whole fixture — the last page is partial, like the real export. */
const TOTAL_SALES = SALES_PER_DAY.reduce((a, b) => a + b, 0)
const TOTAL_PAGES = Math.ceil(TOTAL_SALES / PAGE_SIZE)

/** Deterministic per-page shuffle — a stand-in for the planner's freedom to reorder ties. */
function shuffleForPage<T>(rows: T[], seed: number): T[] {
  const out = [...rows]
  for (let i = out.length - 1; i > 0; i--) {
    const j = (i * 7 + seed * 13 + 5) % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Applies `orderBy` the way Postgres legitimately may: ties (rows equal on every
 * supplied key) are shuffled per query. A total sort key leaves nothing to shuffle.
 */
function applyOrderBy(
  rows: Array<{ id: string; createdAt: Date }>,
  orderBy: unknown,
  pageSeed: number,
): Array<{ id: string; createdAt: Date }> {
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, 'asc' | 'desc'>>
  const shuffled = shuffleForPage(rows, pageSeed)
  return [...shuffled].sort((a, b) => {
    for (const key of keys) {
      const [field, dir] = Object.entries(key)[0] as [keyof typeof a, 'asc' | 'desc']
      const av = a[field] instanceof Date ? (a[field] as Date).getTime() : a[field]
      const bv = b[field] instanceof Date ? (b[field] as Date).getTime() : b[field]
      if (av === bv) continue
      const cmp = av < bv ? -1 : 1
      return dir === 'desc' ? -cmp : cmp
    }
    return 0 // fully tied — keeps the shuffled order, which is the whole hazard
  })
}

describe('Sale-verification list pagination stability (Asana 1217127206664238)', () => {
  beforeEach(() => jest.clearAllMocks())

  // ── NEW BEHAVIOUR: a full paginated sweep must not lose or duplicate a sale ──

  it('org list: paging through every page returns each sale exactly once, even when ties are reordered', async () => {
    const sales = buildSales()
    let pageSeed = 0

    mockPrisma.payment.count.mockResolvedValue(sales.length)
    mockPrisma.payment.findMany.mockImplementation(async ({ orderBy, skip, take }: any) => {
      const ordered = applyOrderBy(sales, orderBy, pageSeed++)
      return ordered.slice(skip, skip + take).map(r => ({
        id: r.id,
        amount: 0,
        method: 'OTHER',
        status: 'COMPLETED',
        createdAt: r.createdAt,
        order: { id: `ord_${r.id}`, venue: { id: VENUE_ID, name: 'BAE RICARDO B ANAYA', city: 'Querétaro', slug: 'bae' }, items: [] },
        saleVerification: null,
      }))
    })

    const collected: string[] = []
    for (let page = 1; page <= TOTAL_PAGES; page++) {
      const res = await listOrgSaleVerifications(ORG_ID, { pageNumber: page, pageSize: PAGE_SIZE })
      collected.push(...res.data.map(r => r.paymentId))
    }

    expect(collected).toHaveLength(sales.length)
    expect(new Set(collected).size).toBe(sales.length) // no duplicates → no silent losses
    expect([...collected].sort()).toEqual(sales.map(s => s.id).sort())
  })

  it('venue list: paging through every page returns each sale exactly once', async () => {
    const sales = buildSales()
    let pageSeed = 100

    mockPrisma.payment.count.mockResolvedValue(sales.length)
    mockPrisma.payment.findMany.mockImplementation(async ({ orderBy, skip, take }: any) => {
      const ordered = applyOrderBy(sales, orderBy, pageSeed++)
      return ordered.slice(skip, skip + take).map(r => ({
        id: r.id,
        amount: 0,
        method: 'OTHER',
        status: 'COMPLETED',
        createdAt: r.createdAt,
        tipAmount: 0,
        order: { id: `ord_${r.id}`, orderNumber: `ORD-${r.id}`, total: 0, tags: [] },
        saleVerification: null,
      }))
    })

    const collected: string[] = []
    for (let page = 1; page <= TOTAL_PAGES; page++) {
      const res = await listSaleVerificationsWithDetails(VENUE_ID, { pageNumber: page, pageSize: PAGE_SIZE })
      collected.push(...res.data.map((r: any) => r.paymentId))
    }

    expect(collected).toHaveLength(sales.length)
    expect(new Set(collected).size).toBe(sales.length)
  })

  // ── The invariant that makes the above possible: a UNIQUE trailing sort key ──

  it('org list orders by a unique tiebreak, not createdAt alone', async () => {
    mockPrisma.payment.count.mockResolvedValue(0)
    mockPrisma.payment.findMany.mockResolvedValue([])

    await listOrgSaleVerifications(ORG_ID, { pageNumber: 1, pageSize: PAGE_SIZE })

    const { orderBy } = mockPrisma.payment.findMany.mock.calls[0][0]
    expect(Array.isArray(orderBy)).toBe(true)
    expect(orderBy[0]).toEqual({ createdAt: 'desc' })
    expect(orderBy[orderBy.length - 1]).toHaveProperty('id') // unique → total sort key
  })

  it('venue list orders by a unique tiebreak, not createdAt alone', async () => {
    mockPrisma.payment.count.mockResolvedValue(0)
    mockPrisma.payment.findMany.mockResolvedValue([])

    await listSaleVerificationsWithDetails(VENUE_ID, { pageNumber: 1, pageSize: PAGE_SIZE })

    const { orderBy } = mockPrisma.payment.findMany.mock.calls[0][0]
    expect(Array.isArray(orderBy)).toBe(true)
    expect(orderBy[0]).toEqual({ createdAt: 'desc' })
    expect(orderBy[orderBy.length - 1]).toHaveProperty('id')
  })

  // ── REGRESSION: the fix must not disturb ordering, filtering or paging ──

  it('still returns sales newest-first', async () => {
    const sales = buildSales()
    mockPrisma.payment.count.mockResolvedValue(sales.length)
    mockPrisma.payment.findMany.mockImplementation(async ({ orderBy, skip, take }: any) =>
      applyOrderBy(sales, orderBy, 0)
        .slice(skip, skip + take)
        .map(r => ({
          id: r.id,
          amount: 0,
          method: 'OTHER',
          status: 'COMPLETED',
          createdAt: r.createdAt,
          order: { id: `ord_${r.id}`, venue: { id: VENUE_ID, name: 'BAE', city: 'Querétaro', slug: 'bae' }, items: [] },
          saleVerification: null,
        })),
    )

    const res = await listOrgSaleVerifications(ORG_ID, { pageNumber: 1, pageSize: PAGE_SIZE })
    const dates = res.data.map(r => new Date(r.createdAt).getTime())
    expect(dates).toEqual([...dates].sort((a, b) => b - a))
  })

  it('still scopes to the org and to COMPLETED payments, and still pages', async () => {
    mockPrisma.payment.count.mockResolvedValue(0)
    mockPrisma.payment.findMany.mockResolvedValue([])

    await listOrgSaleVerifications(ORG_ID, { pageNumber: 3, pageSize: PAGE_SIZE })

    const arg = mockPrisma.payment.findMany.mock.calls[0][0]
    expect(arg.where.status).toBe('COMPLETED')
    expect(arg.where.order).toMatchObject({ venue: { organizationId: ORG_ID } })
    expect(arg.skip).toBe(2 * PAGE_SIZE)
    expect(arg.take).toBe(PAGE_SIZE)
  })
})
