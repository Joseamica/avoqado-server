/**
 * TPV remote-command list pagination stability (Asana 1217127206664238)
 *
 * This controller owns five paginated lists, and the command-history one was the WORST
 * instance of the defect found anywhere in the codebase: `executedAt` is NULL on every
 * single row in prod (299 of 299), so ordering by `executedAt` alone left the entire
 * table as ONE tie group that Postgres could arrange however it liked per query.
 *
 * Measured against prod by paging the list with N separate OFFSET/LIMIT queries:
 * 6 of 299 rows came back twice and 6 never appeared at all. Re-running the same sweep
 * with the unique `id` appended returned all 299 exactly once.
 *
 * Fix: append the unique `id` so the sort key is total. Do NOT reduce any of these back
 * to a single non-unique key.
 *
 * The sweep below pages through a fake Postgres that is free to shuffle ties (exactly
 * the latitude the real planner has). Without the `id` tiebreak it loses rows.
 */

// The controller pulls this in at module load; stub it so importing has no side effects.
jest.mock('@/services/tpv/command-execution.service', () => ({
  tpvCommandExecutionService: {
    sendCommand: jest.fn(),
    sendBulkCommand: jest.fn(),
    cancelCommand: jest.fn(),
    retryCommand: jest.fn(),
  },
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    tpvCommandHistory: { findMany: jest.fn(), count: jest.fn() },
    tpvCommandQueue: { findMany: jest.fn(), count: jest.fn() },
    bulkCommandOperation: { findMany: jest.fn(), count: jest.fn() },
    scheduledCommand: { findMany: jest.fn(), count: jest.fn() },
    geofenceRule: { findMany: jest.fn(), count: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import type { NextFunction, Request, Response } from 'express'
import {
  getCommandHistory,
  getCommands,
  getBulkOperations,
  getScheduledCommands,
  getGeofenceRules,
} from '@/controllers/dashboard/tpv-command.dashboard.controller'
import prisma from '@/utils/prismaClient'

const mockPrisma = prisma as unknown as Record<string, { findMany: jest.Mock; count: jest.Mock }>

const VENUE_ID = 'venue_bae_ricardo_b_anaya'
const PAGE_SIZE = 20 // the controller default

/**
 * 299 rows that ALL share the same sort value — the real prod shape, where `executedAt`
 * is NULL everywhere. 299 is not a multiple of PAGE_SIZE, so the last page is partial
 * and the single tie group spans every page boundary there is.
 */
const TOTAL = 299
const TOTAL_PAGES = Math.ceil(TOTAL / PAGE_SIZE)

function buildHistory() {
  return Array.from({ length: TOTAL }, (_, i) => ({
    id: `hist_${String(i).padStart(4, '0')}`,
    executedAt: null as Date | null, // NULL on every row, exactly like prod
    commandType: 'LOCK',
    resultStatus: 'SUCCESS',
    venueId: VENUE_ID,
  }))
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
 * are shuffled per query. NULLs compare equal to each other, so a NULL-everywhere column
 * ties the whole table. A total sort key leaves nothing to shuffle.
 */
function applyOrderBy(rows: Array<Record<string, any>>, orderBy: unknown, seed: number) {
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, 'asc' | 'desc'>>
  return [...shuffleForPage(rows, seed)].sort((a, b) => {
    for (const key of keys) {
      const [field, dir] = Object.entries(key)[0] as [string, 'asc' | 'desc']
      const av = a[field] instanceof Date ? a[field].getTime() : a[field]
      const bv = b[field] instanceof Date ? b[field].getTime() : b[field]
      if (av === bv || av == null || bv == null) continue // NULLs tie
      return dir === 'desc' ? (av < bv ? 1 : -1) : av < bv ? -1 : 1
    }
    return 0 // fully tied — keeps the shuffled order, which is the whole hazard
  })
}

function serve(model: string, rows: Array<Record<string, any>>, startSeed = 0) {
  let seed = startSeed
  mockPrisma[model].count.mockResolvedValue(rows.length)
  mockPrisma[model].findMany.mockImplementation(async ({ orderBy, skip, take }: any) =>
    applyOrderBy(rows, orderBy, seed++).slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length)),
  )
}

/** Minimal express doubles — these handlers only read params/query and call res.json. */
function ctx(query: Record<string, unknown> = {}) {
  const json = jest.fn()
  const res = { status: jest.fn().mockReturnValue({ json }), json } as unknown as Response
  const next = jest.fn() as unknown as NextFunction
  const req = { params: { venueId: VENUE_ID }, query } as unknown as Request<any, any, any, any>
  return { req, res, next, json }
}

describe('TPV remote-command list pagination stability (Asana 1217127206664238)', () => {
  beforeEach(() => jest.clearAllMocks())

  // ── NEW BEHAVIOUR: the reproduced prod failure must not happen again ──

  it('command history: paging every page returns each row exactly once, even though executedAt is NULL on all of them', async () => {
    const rows = buildHistory()
    serve('tpvCommandHistory', rows)

    const collected: string[] = []
    for (let page = 1; page <= TOTAL_PAGES; page++) {
      const { req, res, next, json } = ctx({ page, pageSize: PAGE_SIZE })
      await getCommandHistory(req as any, res, next)
      expect(next).not.toHaveBeenCalled()
      collected.push(...json.mock.calls[0][0].data.map((r: any) => r.id))
    }

    expect(collected).toHaveLength(TOTAL)
    expect(new Set(collected).size).toBe(TOTAL) // no duplicates → nothing was dropped
    expect([...collected].sort()).toEqual(rows.map(r => r.id).sort())
  })

  // ── The invariant behind it: every list carries a UNIQUE trailing sort key ──

  it.each([
    ['command history', 'tpvCommandHistory', getCommandHistory, 'executedAt', 'desc'],
    ['commands', 'tpvCommandQueue', getCommands, 'createdAt', 'desc'],
    ['bulk operations', 'bulkCommandOperation', getBulkOperations, 'createdAt', 'desc'],
    ['scheduled commands', 'scheduledCommand', getScheduledCommands, 'nextExecution', 'asc'],
    ['geofence rules', 'geofenceRule', getGeofenceRules, 'createdAt', 'desc'],
  ])('%s orders by a unique tiebreak, not %s alone', async (_label, model, handler, field, dir) => {
    serve(model as string, [])

    const { req, res, next } = ctx({ page: 1, pageSize: PAGE_SIZE })
    await (handler as any)(req as any, res, next)
    expect(next).not.toHaveBeenCalled()

    const { orderBy } = mockPrisma[model as string].findMany.mock.calls[0][0] as any
    expect(Array.isArray(orderBy)).toBe(true)
    expect(orderBy[0]).toEqual({ [field as string]: dir })
    expect(orderBy[orderBy.length - 1]).toHaveProperty('id') // unique → total sort key
  })

  // ── REGRESSION: scoping, filtering, paging and the response envelope are unchanged ──

  it('still scopes to the venue and still pages', async () => {
    serve('tpvCommandHistory', [])

    const { req, res, next } = ctx({ page: 3, pageSize: PAGE_SIZE })
    await getCommandHistory(req as any, res, next)

    const arg = mockPrisma.tpvCommandHistory.findMany.mock.calls[0][0] as any
    expect(arg.where).toMatchObject({ venueId: VENUE_ID })
    expect(arg.skip).toBe(2 * PAGE_SIZE)
    expect(arg.take).toBe(PAGE_SIZE)
  })

  it('still applies the terminal and result-status filters', async () => {
    serve('tpvCommandHistory', [])

    const { req, res, next } = ctx({ page: 1, pageSize: PAGE_SIZE, terminalId: 'term_1', resultStatus: 'FAILED' })
    await getCommandHistory(req as any, res, next)

    const arg = mockPrisma.tpvCommandHistory.findMany.mock.calls[0][0] as any
    expect(arg.where).toMatchObject({ venueId: VENUE_ID, terminalId: 'term_1', resultStatus: 'FAILED' })
  })

  it('still returns the { data, meta } envelope with the total from count()', async () => {
    serve('tpvCommandHistory', buildHistory())

    const { req, res, next, json } = ctx({ page: 1, pageSize: PAGE_SIZE })
    await getCommandHistory(req as any, res, next)

    const body = json.mock.calls[0][0]
    expect(body.data).toHaveLength(PAGE_SIZE)
    expect(body.meta).toMatchObject({ total: TOTAL, page: 1, pageSize: PAGE_SIZE, pageCount: TOTAL_PAGES })
  })
})
