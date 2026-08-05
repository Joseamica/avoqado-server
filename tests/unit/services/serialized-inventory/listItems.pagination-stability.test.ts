/**
 * Serialized-item list pagination stability (Asana 1217127206664238)
 *
 * Same defect as the sale-verification lists, with a much larger blast radius: a bulk
 * SIM upload inserts the whole batch in ONE statement, so every item in it carries a
 * byte-identical `createdAt`. Prod (PlayTelecom) holds tie groups of 500 SIMs on a
 * single timestamp — far bigger than any page. Ordering on `createdAt` alone leaves
 * that group for Postgres to arrange however it likes per query, so paging through the
 * list repeats some SIMs and silently drops others.
 *
 * Fix: append the unique `id` so the sort key is total.
 */

import { SerializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const VENUE_ID = 'venue_bae_ricardo_b_anaya'
const ORG_ID = 'org_playtelecom'
const PAGE_SIZE = 50

/**
 * 3 bulk uploads of 500/500/400 SIMs — the real prod shape. None is a multiple of
 * PAGE_SIZE relative to the running offset, so tie groups straddle page boundaries,
 * which is exactly where an unstable sort loses rows.
 */
const BATCH_SIZES = [500, 500, 400]
const TOTAL_ITEMS = BATCH_SIZES.reduce((a, b) => a + b, 0)
const TOTAL_PAGES = Math.ceil(TOTAL_ITEMS / PAGE_SIZE)

function buildItems() {
  const rows: Array<{ id: string; createdAt: Date; serialNumber: string }> = []
  let idx = 0
  BATCH_SIZES.forEach((count, batch) => {
    // One `createMany` → one identical timestamp for the whole batch.
    const createdAt = new Date(Date.UTC(2026, 5, 28 + batch, 23, 37, 26, 391))
    for (let n = 0; n < count; n++, idx++) {
      rows.push({ id: `sim_${String(idx).padStart(4, '0')}`, createdAt, serialNumber: `89521400${String(idx).padStart(12, '0')}F` })
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

function applyOrderBy(rows: Array<{ id: string; createdAt: Date }>, orderBy: unknown, seed: number) {
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, 'asc' | 'desc'>>
  return [...shuffleForPage(rows, seed)].sort((a, b) => {
    for (const key of keys) {
      const [field, dir] = Object.entries(key)[0] as [keyof typeof a, 'asc' | 'desc']
      const av = a[field] instanceof Date ? (a[field] as Date).getTime() : a[field]
      const bv = b[field] instanceof Date ? (b[field] as Date).getTime() : b[field]
      if (av === bv) continue
      return dir === 'desc' ? (av < bv ? 1 : -1) : av < bv ? -1 : 1
    }
    return 0 // fully tied — keeps the shuffled order, which is the hazard
  })
}

function makeDb(items: ReturnType<typeof buildItems>) {
  let seed = 0
  const findMany = jest.fn(async ({ orderBy, skip, take }: any) =>
    applyOrderBy(items, orderBy, seed++)
      .slice(skip ?? 0, (skip ?? 0) + (take ?? items.length))
      .map(r => ({ ...r, category: { id: 'cat_1', name: 'SIM de Caja Vinculado' } })),
  )
  return { db: { serializedItem: { findMany, count: jest.fn(async () => items.length) } } as any, findMany }
}

describe('Serialized-item list pagination stability (Asana 1217127206664238)', () => {
  // ── NEW BEHAVIOUR: a full paginated sweep must not lose or duplicate a SIM ──

  it('listItems: paging through every page returns each SIM exactly once, even when ties are reordered', async () => {
    const items = buildItems()
    const { db } = makeDb(items)
    const svc = new SerializedInventoryService(db)

    const collected: string[] = []
    for (let page = 0; page < TOTAL_PAGES; page++) {
      const res = await svc.listItems({ venueId: VENUE_ID, skip: page * PAGE_SIZE, take: PAGE_SIZE })
      collected.push(...res.items.map(i => i.id))
    }

    expect(collected).toHaveLength(TOTAL_ITEMS)
    expect(new Set(collected).size).toBe(TOTAL_ITEMS) // no duplicates → nothing was dropped
  })

  it('listOrgItems: paging through every page returns each SIM exactly once', async () => {
    const items = buildItems()
    const { db } = makeDb(items)
    const svc = new SerializedInventoryService(db)

    const collected: string[] = []
    for (let page = 0; page < TOTAL_PAGES; page++) {
      const res = await svc.listOrgItems({ orgId: ORG_ID, allowedVenueIds: [VENUE_ID], skip: page * PAGE_SIZE, take: PAGE_SIZE })
      collected.push(...res.items.map(i => i.id))
    }

    expect(collected).toHaveLength(TOTAL_ITEMS)
    expect(new Set(collected).size).toBe(TOTAL_ITEMS)
  })

  // ── The invariant behind it: a UNIQUE trailing sort key ──

  it('both lists order by a unique tiebreak, not createdAt alone', async () => {
    const { db, findMany } = makeDb([])
    const svc = new SerializedInventoryService(db)

    await svc.listItems({ venueId: VENUE_ID, skip: 0, take: PAGE_SIZE })
    await svc.listOrgItems({ orgId: ORG_ID, allowedVenueIds: [VENUE_ID], skip: 0, take: PAGE_SIZE })

    for (const call of findMany.mock.calls) {
      const { orderBy } = call[0] as any
      expect(Array.isArray(orderBy)).toBe(true)
      expect(orderBy[0]).toEqual({ createdAt: 'desc' })
      expect(orderBy[orderBy.length - 1]).toHaveProperty('id')
    }
  })

  // ── REGRESSION: ordering, scoping and paging must be unchanged ──

  it('still returns SIMs newest-first', async () => {
    const items = buildItems()
    const { db } = makeDb(items)
    const svc = new SerializedInventoryService(db)

    const res = await svc.listItems({ venueId: VENUE_ID, skip: 0, take: PAGE_SIZE })
    const dates = res.items.map(i => i.createdAt.getTime())
    expect(dates).toEqual([...dates].sort((a, b) => b - a))
  })

  it('still scopes listItems to the venue and honours skip/take', async () => {
    const { db, findMany } = makeDb([])
    const svc = new SerializedInventoryService(db)

    await svc.listItems({ venueId: VENUE_ID, categoryId: 'cat_1', skip: 100, take: PAGE_SIZE })

    const arg = findMany.mock.calls[0][0] as any
    expect(arg.where).toMatchObject({ venueId: VENUE_ID, categoryId: 'cat_1' })
    expect(arg.skip).toBe(100)
    expect(arg.take).toBe(PAGE_SIZE)
  })
})
