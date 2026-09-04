/**
 * Task 5e: an offline PAY_IN/PAY_OUT belongs to the drawer where it happened, not to
 * whichever drawer happens to be open when the device reconnects.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { syncEvents } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const OTHER_VENUE = 'venue-2'
const STAFF = 'staff-1'
const OPENED_A = new Date('2026-09-01T08:00:00.000Z')
const CLOSED_A = new Date('2026-09-01T16:00:00.000Z')
const OPENED_B = new Date('2026-09-02T08:00:00.000Z')

type Drawer = ReturnType<typeof drawer>

/**
 * El `overShort` que se escribió en la gaveta.
 *
 * `find` devuelve `T | undefined` y los tres sitios lo indexaban directo: TypeScript lo
 * marca, y en ejecución habría reventado con un `TypeError` ilegible. Aquí falla diciendo
 * lo que faltó. No cambia qué comprueba la prueba, sólo cómo se queja cuando no se cumple.
 */
function overShortEscrito(calls: any[][]): any {
  const call = calls.find((c: any) => c[0].data?.overShort !== undefined)
  if (!call) throw new Error('se esperaba una escritura con `overShort` en la gaveta, y no hubo ninguna')
  return call[0].data.overShort
}

function drawer(over: Record<string, unknown> = {}) {
  return {
    id: 'drawer-a',
    venueId: VENUE,
    status: 'CLOSED',
    openedAt: OPENED_A,
    closedAt: CLOSED_A,
    startingAmount: new Prisma.Decimal('1000.00'),
    actualAmount: null,
    overShort: null,
    shiftId: null,
    // Sin el tipo, `[]` se infiere `never[]` y `row.type` / `row.amount` no existen:
    // el archivo dejaba de compilar aunque jest (transpile-only) lo diera por verde.
    events: [] as Array<{ type: string; amount: Prisma.Decimal }>,
    ...over,
  }
}

function event(over: Record<string, unknown> = {}) {
  return {
    type: 'PAY_OUT',
    amount: 50,
    staffId: STAFF,
    staffName: 'Cajero',
    localId: 'local-1',
    sessionId: 'drawer-a',
    createdAt: '2026-09-01T12:00:00.000Z',
    ...over,
  }
}

function world(
  options: {
    explicit?: Drawer[]
    legacy?: Drawer[]
    existing?: any[]
    transactionExisting?: any[]
    insertedKeyed?: any[]
    insertCounts?: Record<string, number>
    lockCounts?: Record<string, number>
    shifts?: Record<string, any>
    shiftUpdateCount?: number
  } = {},
) {
  const explicit = options.explicit ?? [drawer()]
  const legacy = options.legacy ?? []
  const existing = options.existing ?? []
  const sessionById = new Map([...explicit, ...legacy].map(s => [s.id, s]))

  const rootSessionFindMany = jest.fn(async (args: any) => (args.where?.id?.in ? explicit : legacy))
  const fullExistingRows = existing.map(row => ({
    id: row.id ?? 'db-existing',
    venueId: VENUE,
    type: 'PAY_OUT',
    amount: new Prisma.Decimal('50.00'),
    note: null,
    staffId: STAFF,
    staffName: 'Cajero',
    orderId: null,
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    ...row,
  }))
  const rootEventFindMany = jest.fn(async (args: any) => {
    if (args.select?.localId) return existing
    return fullExistingRows
  })
  const staffFindMany = jest.fn().mockResolvedValue([{ staffId: STAFF }])
  const lockUpdateMany = jest.fn(async (args: any) => {
    if (args.data?.overShort !== undefined) return { count: 1 }
    const id = args.where.id
    return { count: options.lockCounts?.[id] ?? (sessionById.has(id) ? 1 : 0) }
  })
  const sessionFindFirst = jest.fn(async (args: any) => sessionById.get(args.where.id) ?? null)
  const createMany = jest.fn(async (args: any) => {
    const id = args.data[0]?.sessionId
    return { count: options.insertCounts?.[id] ?? args.data.length }
  })
  const createManyAndReturn = jest.fn(async (args: any) => {
    if (options.insertedKeyed) return options.insertedKeyed
    const usedBySession = new Map<string, number>()
    return args.data.flatMap((row: any, index: number) => {
      const used = usedBySession.get(row.sessionId) ?? 0
      const limit = options.insertCounts?.[row.sessionId] ?? Number.POSITIVE_INFINITY
      if (used >= limit) return []
      usedBySession.set(row.sessionId, used + 1)
      return [{ id: `db-keyed-${index + 1}`, localId: row.localId, sessionId: row.sessionId }]
    })
  })
  let created = 0
  const create = jest.fn(async (args: any) => ({ id: `db-new-${++created}`, ...args.data }))
  const transactionEventRows = (options.transactionExisting ?? existing).map(row => ({
    id: row.id ?? 'db-existing',
    venueId: VENUE,
    type: 'PAY_OUT',
    amount: new Prisma.Decimal('50.00'),
    note: null,
    staffId: STAFF,
    staffName: 'Cajero',
    orderId: null,
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    ...row,
  }))
  const transactionEventFindMany = jest.fn().mockResolvedValue(transactionEventRows)
  const transactionSessionFindMany = jest.fn(async (args: any) =>
    args.where.id.in
      .map((id: string) => sessionById.get(id))
      .filter((session: Drawer | undefined) => session?.status === 'CLOSED' && session.actualAmount !== null),
  )
  const transactionEventGroupBy = jest.fn(async (args: any) =>
    args.where.sessionId.in.flatMap((sessionId: string) => {
      const session = sessionById.get(sessionId)
      const totals = new Map<string, Prisma.Decimal>()
      for (const row of session?.events ?? []) {
        const before = totals.get(row.type) ?? new Prisma.Decimal(0)
        totals.set(row.type, before.plus(row.amount))
      }
      return [...totals.entries()].map(([type, amount]) => ({ sessionId, type, _sum: { amount } }))
    }),
  )
  const shiftFindFirst = jest.fn(async (args: any) => options.shifts?.[args.where.id] ?? null)
  const shiftFindMany = jest.fn(async (args: any) => args.where.id.in.map((id: string) => options.shifts?.[id]).filter(Boolean))
  const shiftUpdateMany = jest.fn().mockResolvedValue({ count: options.shiftUpdateCount ?? 1 })
  const tx = {
    cashDrawerSession: { updateMany: lockUpdateMany, findFirst: sessionFindFirst, findMany: transactionSessionFindMany },
    cashDrawerEvent: { createMany, createManyAndReturn, create, findMany: transactionEventFindMany, groupBy: transactionEventGroupBy },
    shift: { findFirst: shiftFindFirst, findMany: shiftFindMany, updateMany: shiftUpdateMany },
  }

  ;(prismaMock as any).cashDrawerSession = { findMany: rootSessionFindMany, findFirst: jest.fn(), updateMany: jest.fn() }
  ;(prismaMock as any).cashDrawerEvent = { findMany: rootEventFindMany, createMany: jest.fn(), create: jest.fn() }
  ;(prismaMock as any).staffVenue = { findMany: staffFindMany, findFirst: jest.fn() }
  ;(prismaMock as any).shift = { findFirst: jest.fn(), updateMany: jest.fn() }
  ;(prismaMock as any).$transaction = jest.fn((callback: any) => callback(tx))

  return {
    rootSessionFindMany,
    rootEventFindMany,
    staffFindMany,
    lockUpdateMany,
    sessionFindFirst,
    transactionSessionFindMany,
    createMany,
    createManyAndReturn,
    create,
    transactionEventFindMany,
    transactionEventGroupBy,
    shiftFindFirst,
    shiftFindMany,
    shiftUpdateMany,
  }
}

beforeEach(() => jest.clearAllMocks())

describe('syncEvents — durable drawer identity', () => {
  it('posts an explicitly identified old event to CLOSED drawer A while newer drawer B stays untouched', async () => {
    const a = drawer({
      id: 'drawer-a',
      actualAmount: new Prisma.Decimal('950.00'),
      overShort: new Prisma.Decimal('0.00'),
      events: [{ type: 'PAY_OUT', amount: new Prisma.Decimal('50.00') }],
    })
    const b = drawer({ id: 'drawer-b', status: 'OPEN', openedAt: OPENED_B, closedAt: null })
    const w = world({ explicit: [a] })

    await syncEvents(VENUE, [event()] as any, null, STAFF)

    expect(w.createManyAndReturn.mock.calls[0][0].data[0]).toMatchObject({
      sessionId: 'drawer-a',
      venueId: VENUE,
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
    })
    expect(w.lockUpdateMany.mock.calls.filter((c: any) => c[0].data?.overShort === undefined).map((c: any) => c[0].where.id)).toEqual([
      'drawer-a',
    ])
    expect(w.createManyAndReturn.mock.calls.flatMap((c: any) => c[0].data).some((row: any) => row.sessionId === b.id)).toBe(false)
  })

  it('never falls back when an explicit id is unknown or belongs to another venue', async () => {
    const w = world({ explicit: [] })

    await expect(syncEvents(VENUE, [event({ sessionId: 'drawer-cross-venue' })] as any, null, STAFF)).rejects.toMatchObject({
      statusCode: 400,
      code: 'CASH_DRAWER_SYNC_UNSAFE_IDENTITY',
    })

    expect(w.rootSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: VENUE, id: { in: ['drawer-cross-venue'] } } }),
    )
    expect((prismaMock as any).$transaction).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('CASH_DRAWER_SYNC_REJECTED'),
      expect.objectContaining({ venueId: VENUE, reason: 'EXPLICIT_SESSION_NOT_FOUND' }),
    )
  })

  it('resolves a legacy event only when exactly one tenant-scoped interval contains its timestamp', async () => {
    const a = drawer({ id: 'legacy-a' })
    const w = world({ explicit: [], legacy: [a] })

    await syncEvents(VENUE, [event({ sessionId: undefined, localId: 'legacy-1' })] as any, null, STAFF)

    expect(w.createManyAndReturn.mock.calls[0][0].data[0].sessionId).toBe('legacy-a')
    expect(w.rootSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE }), take: expect.any(Number) }),
    )
  })

  it.each([
    ['no interval', []],
    ['overlapping intervals', [drawer({ id: 'legacy-a' }), drawer({ id: 'legacy-b' })]],
  ])('rejects the whole legacy batch with zero writes for %s', async (_label, candidates) => {
    const w = world({ explicit: [], legacy: candidates as Drawer[] })

    await expect(syncEvents(VENUE, [event({ sessionId: undefined })] as any, null, STAFF)).rejects.toMatchObject({
      code: 'CASH_DRAWER_SYNC_UNSAFE_IDENTITY',
    })
    expect(w.createManyAndReturn).not.toHaveBeenCalled()
    expect(w.create).not.toHaveBeenCalled()
    expect((prismaMock as any).$transaction).not.toHaveBeenCalled()
  })

  it.each([undefined, '', 'not-a-date'])('rejects a legacy event with missing/invalid createdAt (%p)', async createdAt => {
    const w = world({ explicit: [], legacy: [drawer()] })

    await expect(syncEvents(VENUE, [event({ sessionId: undefined, createdAt })] as any, null, STAFF)).rejects.toMatchObject({
      code: 'CASH_DRAWER_SYNC_UNSAFE_IDENTITY',
    })
    expect((prismaMock as any).$transaction).not.toHaveBeenCalled()
    expect(w.createManyAndReturn).not.toHaveBeenCalled()
  })

  it('locks mixed target sessions in deterministic id order inside one transaction', async () => {
    const a = drawer({ id: 'drawer-a' })
    const z = drawer({ id: 'drawer-z', openedAt: OPENED_B, closedAt: null, status: 'OPEN' })
    const w = world({ explicit: [z, a] })

    await syncEvents(
      VENUE,
      [event({ sessionId: 'drawer-z', localId: 'z' }), event({ sessionId: 'drawer-a', localId: 'a' })] as any,
      null,
      STAFF,
    )

    expect((prismaMock as any).$transaction).toHaveBeenCalledTimes(1)
    expect(w.lockUpdateMany.mock.calls.filter((c: any) => c[0].data?.overShort === undefined).map((c: any) => c[0].where.id)).toEqual([
      'drawer-a',
      'drawer-z',
    ])
    for (const [args] of w.lockUpdateMany.mock.calls) expect(args.where.venueId).toBe(VENUE)
  })

  it('bulk-rereads changed closed drawers, event totals, and linked Shifts with explicit bounds', async () => {
    const a = drawer({
      id: 'drawer-a',
      shiftId: 'shift-a',
      actualAmount: new Prisma.Decimal('950.00'),
      events: [
        { type: 'PAY_OUT', amount: new Prisma.Decimal('50.00') },
        { type: 'PAY_OUT', amount: new Prisma.Decimal('50.00') },
      ],
    })
    const b = drawer({
      id: 'drawer-b',
      shiftId: 'shift-b',
      actualAmount: new Prisma.Decimal('490.00'),
      startingAmount: new Prisma.Decimal('500.00'),
      events: [{ type: 'PAY_OUT', amount: new Prisma.Decimal('10.00') }],
    })
    const w = world({
      explicit: [b, a],
      shifts: {
        'shift-a': {
          id: 'shift-a',
          venueId: VENUE,
          status: 'CLOSED',
          cashDeclared: new Prisma.Decimal('950.00'),
          cashDifference: new Prisma.Decimal('0.00'),
        },
        'shift-b': {
          id: 'shift-b',
          venueId: VENUE,
          status: 'CLOSED',
          cashDeclared: new Prisma.Decimal('490.00'),
          cashDifference: new Prisma.Decimal('0.00'),
        },
      },
    })

    await syncEvents(
      VENUE,
      [event({ sessionId: 'drawer-b', localId: 'b', amount: 10 }), event({ sessionId: 'drawer-a', localId: 'a' })] as any,
      null,
      STAFF,
    )

    expect(w.transactionSessionFindMany).toHaveBeenCalledTimes(1)
    expect(w.transactionSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: VENUE, id: { in: ['drawer-a', 'drawer-b'] }, status: 'CLOSED', actualAmount: { not: null } },
        take: 2,
      }),
    )
    expect(w.transactionEventGroupBy).toHaveBeenCalledTimes(1)
    expect(w.transactionEventGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['sessionId', 'type'],
        where: {
          venueId: VENUE,
          sessionId: { in: ['drawer-a', 'drawer-b'] },
          type: { in: ['PAY_IN', 'PAY_OUT', 'CASH_SALE'] },
        },
        take: 6,
      }),
    )
    expect(w.shiftFindMany).toHaveBeenCalledTimes(1)
    expect(w.shiftFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: VENUE, id: { in: ['shift-a', 'shift-b'] } }, take: 2 }),
    )
    expect(w.sessionFindFirst).not.toHaveBeenCalled()
    expect(w.shiftFindFirst).not.toHaveBeenCalled()
  })

  it('a keyed duplicate is echoed but does not recalculate or emit another audit', async () => {
    const existing = [{ id: 'db-existing', localId: 'local-1', sessionId: 'drawer-a' }]
    const w = world({ existing, insertCounts: { 'drawer-a': 0 } })

    const result = await syncEvents(VENUE, [event()] as any, null, STAFF)

    expect(result.syncedCount).toBe(0)
    expect(result.events).toHaveLength(1)
    expect(w.sessionFindFirst).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('audits only keyed rows inserted by this request, excluding a prior duplicate in the same closed drawer', async () => {
    const a = drawer({
      id: 'drawer-a',
      actualAmount: new Prisma.Decimal('900.00'),
      overShort: new Prisma.Decimal('0.00'),
      events: [
        { type: 'PAY_OUT', amount: new Prisma.Decimal('50.00') },
        { type: 'PAY_OUT', amount: new Prisma.Decimal('50.00') },
      ],
    })
    const durableRows = [
      { id: 'db-a', localId: 'duplicate-a', sessionId: 'drawer-a' },
      { id: 'db-b', localId: 'new-b', sessionId: 'drawer-a' },
    ]
    world({
      explicit: [a],
      existing: [durableRows[0]],
      transactionExisting: durableRows,
      insertedKeyed: [durableRows[1]],
      insertCounts: { 'drawer-a': 1 },
    })

    await syncEvents(VENUE, [event({ localId: 'duplicate-a' }), event({ localId: 'new-b', amount: 50 })] as any, null, STAFF)

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CASH_DRAWER_ADJUSTED_AFTER_CLOSE',
        entityId: 'drawer-a',
        data: expect.objectContaining({ insertedCount: 1, localIds: ['new-b'] }),
      }),
    )
  })

  it('aborts when a conflicting localId appears after preflight instead of acknowledging the winner row', async () => {
    const w = world({
      explicit: [drawer({ id: 'drawer-a' })],
      existing: [],
      insertCounts: { 'drawer-a': 0 },
      transactionExisting: [{ id: 'winner-row', localId: 'local-1', sessionId: 'drawer-other' }],
    })

    await expect(syncEvents(VENUE, [event()] as any, null, STAFF)).rejects.toMatchObject({
      statusCode: 400,
      code: 'CASH_DRAWER_SYNC_UNSAFE_IDENTITY',
    })

    expect(w.transactionEventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: VENUE, localId: { in: ['local-1'] } }, take: 1 }),
    )
    expect(logAction).not.toHaveBeenCalled()
    expect(w.rootEventFindMany).toHaveBeenCalledTimes(1)
  })

  it('repairs a counted CLOSED drawer and its eligible linked Shift with the exact same Decimal', async () => {
    const a = drawer({
      id: 'drawer-a',
      shiftId: 'shift-a',
      actualAmount: new Prisma.Decimal('950.00'),
      overShort: new Prisma.Decimal('0.00'),
      // Transaction reread is post-insert: prior PAY_OUT 50 + this PAY_OUT 50.
      events: [
        { type: 'PAY_OUT', amount: new Prisma.Decimal('50.00') },
        { type: 'PAY_OUT', amount: new Prisma.Decimal('50.00') },
      ],
    })
    const shift = {
      id: 'shift-a',
      venueId: VENUE,
      status: 'CLOSED',
      cashDeclared: new Prisma.Decimal('950.00'),
      cashDifference: new Prisma.Decimal('0.00'),
    }
    const w = world({ explicit: [a], shifts: { 'shift-a': shift } })

    await syncEvents(VENUE, [event()] as any, null, STAFF)

    const drawerRepair = overShortEscrito(w.lockUpdateMany.mock.calls)
    const shiftRepair = w.shiftUpdateMany.mock.calls[0][0].data.cashDifference
    expect(drawerRepair).toBeInstanceOf(Prisma.Decimal)
    expect(drawerRepair.toFixed(2)).toBe('50.00')
    expect(shiftRepair.toFixed(2)).toBe(drawerRepair.toFixed(2))
    expect(w.shiftUpdateMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        id: 'shift-a',
        venueId: VENUE,
        status: 'CLOSED',
        cashDeclared: shift.cashDeclared,
        cashDifference: shift.cashDifference,
      }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CASH_DRAWER_ADJUSTED_AFTER_CLOSE',
        entityId: 'drawer-a',
        data: expect.objectContaining({
          source: 'MOBILE_SYNC',
          insertedCount: 1,
          localIds: ['local-1'],
          expectedAfterPesos: '900.00',
          overShortBeforePesos: '0.00',
          overShortAfterPesos: '50.00',
        }),
      }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SHIFT_UPDATED',
        entityId: 'shift-a',
        data: expect.objectContaining({ cashDifferenceAfterPesos: '50.00' }),
      }),
    )
  })

  it('keeps the valid event/drawer repair but marks a mismatched linked Shift pending', async () => {
    const a = drawer({
      shiftId: 'shift-a',
      actualAmount: new Prisma.Decimal('950.00'),
      overShort: new Prisma.Decimal('50.00'),
      events: [{ type: 'PAY_OUT', amount: new Prisma.Decimal('50.00') }],
    })
    const w = world({
      explicit: [a],
      shifts: {
        'shift-a': {
          id: 'shift-a',
          venueId: VENUE,
          status: 'CLOSED',
          cashDeclared: new Prisma.Decimal('951.00'),
          cashDifference: new Prisma.Decimal('50.00'),
        },
      },
    })

    expect((await syncEvents(VENUE, [event()] as any, null, STAFF)).syncedCount).toBe(1)

    expect(w.shiftUpdateMany).not.toHaveBeenCalled()
    expect(w.lockUpdateMany.mock.calls.some((c: any) => c[0].data?.overShort !== undefined)).toBe(true)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('LATE_SHIFT_RECONCILIATION_PENDING'),
      expect.objectContaining({ reason: 'SHIFT_COUNT_MISMATCH' }),
    )
  })

  it('keeps the drawer repair when the linked Shift CAS loses a concurrent owner edit', async () => {
    const a = drawer({
      shiftId: 'shift-a',
      actualAmount: new Prisma.Decimal('950.00'),
      overShort: new Prisma.Decimal('0.00'),
      events: [
        { type: 'PAY_OUT', amount: new Prisma.Decimal('50.00') },
        { type: 'PAY_OUT', amount: new Prisma.Decimal('50.00') },
      ],
    })
    const w = world({
      explicit: [a],
      shifts: {
        'shift-a': {
          id: 'shift-a',
          venueId: VENUE,
          status: 'CLOSED',
          cashDeclared: new Prisma.Decimal('950.00'),
          cashDifference: new Prisma.Decimal('0.00'),
        },
      },
      shiftUpdateCount: 0,
    })

    expect((await syncEvents(VENUE, [event()] as any, null, STAFF)).syncedCount).toBe(1)

    expect(overShortEscrito(w.lockUpdateMany.mock.calls).toFixed(2)).toBe('50.00')
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('LATE_SHIFT_RECONCILIATION_PENDING'),
      expect.objectContaining({ reason: 'SHIFT_CONCURRENT_WRITE_LOST' }),
    )
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'SHIFT_UPDATED' }))
  })

  it('keeps the drawer repair but refuses a Shift difference wider than Decimal(10,2)', async () => {
    const maxCount = new Prisma.Decimal('99999999.99')
    const a = drawer({
      shiftId: 'shift-a',
      startingAmount: new Prisma.Decimal('0.00'),
      actualAmount: maxCount,
      overShort: new Prisma.Decimal('99999999.99'),
      events: [{ type: 'PAY_OUT', amount: new Prisma.Decimal('0.01') }],
    })
    const w = world({
      explicit: [a],
      shifts: {
        'shift-a': {
          id: 'shift-a',
          venueId: VENUE,
          status: 'CLOSED',
          cashDeclared: maxCount,
          cashDifference: new Prisma.Decimal('99999999.99'),
        },
      },
    })

    await syncEvents(VENUE, [event({ amount: 0.01 })] as any, null, STAFF)

    expect(overShortEscrito(w.lockUpdateMany.mock.calls).toFixed(2)).toBe(
      '100000000.00',
    )
    expect(w.shiftUpdateMany).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('LATE_SHIFT_RECONCILIATION_PENDING'),
      expect.objectContaining({ reason: 'SHIFT_DIFFERENCE_OVERFLOW' }),
    )
  })

  it('returns success for an all-dropped CASH_SALE/invalid batch without looking for any drawer', async () => {
    const w = world({ explicit: [], legacy: [] })
    const droppedOnly = [
      ...Array.from({ length: 500 }, (_, index) => event({ type: 'CASH_SALE', sessionId: undefined, localId: `sale-${index}` })),
      event({ type: 'OPEN', sessionId: undefined, localId: 'invalid-open' }),
    ]

    const result = await syncEvents(VENUE, droppedOnly as any, '2.40.0', STAFF)

    expect(result).toEqual({ syncedCount: 0, events: [] })
    expect(w.rootSessionFindMany).not.toHaveBeenCalled()
    expect((prismaMock as any).cashDrawerSession.findFirst).not.toHaveBeenCalled()
    expect((prismaMock as any).$transaction).not.toHaveBeenCalled()
  })

  it('rejects a request above the explicit full-offline-day cap', async () => {
    const w = world()
    const tooMany = Array.from({ length: 501 }, (_, i) => event({ localId: `local-${i}` }))

    await expect(syncEvents(VENUE, tooMany as any, null, STAFF)).rejects.toMatchObject({ statusCode: 400 })
    expect(w.rootSessionFindMany).not.toHaveBeenCalled()
  })

  it('rejects too many unique target drawers before opening the transaction', async () => {
    const drawers = Array.from({ length: 101 }, (_, index) => drawer({ id: `drawer-${String(index).padStart(3, '0')}` }))
    const w = world({ explicit: drawers })
    const events = drawers.map((session, index) =>
      event({ sessionId: session.id, localId: `local-${index}`, createdAt: '2026-09-01T12:00:00.000Z' }),
    )

    await expect(syncEvents(VENUE, events as any, null, STAFF)).rejects.toMatchObject({
      statusCode: 400,
      code: 'CASH_DRAWER_SYNC_UNSAFE_IDENTITY',
    })

    expect((prismaMock as any).$transaction).not.toHaveBeenCalled()
    expect(w.createManyAndReturn).not.toHaveBeenCalled()
  })

  it('rejects a legacy candidate scan that reaches its safety ceiling instead of guessing', async () => {
    const candidates = Array.from({ length: 101 }, (_, i) => drawer({ id: `legacy-${i}` }))
    const w = world({ explicit: [], legacy: candidates })

    await expect(syncEvents(VENUE, [event({ sessionId: undefined })] as any, null, STAFF)).rejects.toMatchObject({
      code: 'CASH_DRAWER_SYNC_UNSAFE_IDENTITY',
    })
    expect(w.rootSessionFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 101 }))
    expect((prismaMock as any).$transaction).not.toHaveBeenCalled()
  })

  it('bulk-validates staff once and scopes both keyed preflight and response reads to the venue', async () => {
    const existing = [{ id: 'db-existing', localId: 'local-1', sessionId: 'drawer-a' }]
    const w = world({ existing, insertCounts: { 'drawer-a': 0 } })

    await syncEvents(VENUE, [event()] as any, null, STAFF)

    expect(w.staffFindMany).toHaveBeenCalledTimes(1)
    expect(w.staffFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: VENUE, staffId: { in: [STAFF] } }, take: 1 }))
    expect(w.rootEventFindMany).toHaveBeenCalledTimes(1)
    for (const [args] of w.rootEventFindMany.mock.calls) {
      expect(args.where.venueId).toBe(VENUE)
      expect(args.where.venueId).not.toBe(OTHER_VENUE)
    }
    expect(w.transactionEventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: VENUE, localId: { in: ['local-1'] } }, take: 1 }),
    )
  })
})
