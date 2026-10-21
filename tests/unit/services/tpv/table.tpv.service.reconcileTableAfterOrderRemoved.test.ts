/**
 * reconcileTableAfterOrderRemoved — Fix 1, "zombie table" (2026-08-07), see
 * .superpowers/sdd/2026-07-24-tpv-plan-b-superficie-tpv-server/zombie-table-and-staff-picker.md.
 *
 * The shared `mergeOrders` (src/services/mobile/order.mobile.service.ts —
 * FROZEN, iOS/Android build against it in parallel sessions) only frees the
 * source table when `Table.currentOrderId === source.id`. A child order
 * created by SPLIT_ORDER/SPLIT_BY_SEAT never gets `Table.currentOrderId`
 * pointed at it, so when it is later merged away as the table's LAST open
 * order, that lookup misses and the table stays OCCUPIED forever
 * ("zombie table" — reproduced twice on hardware).
 *
 * This function reconciles from the `/tpv` layer instead — by the removed
 * order's OWN `tableId` (the FK, always correct), unconditionally, mirroring
 * `moveOrderToTable`'s sibling-reconciliation. These tests pin BOTH the case
 * the bug lived in (no sibling → must release) and the case that must keep
 * working (a sibling exists → repoint, don't release a table that's still in
 * use).
 */
jest.mock('../../../../src/utils/prismaClient', () => {
  const client = {
    order: { findFirst: jest.fn(), findMany: jest.fn() },
    table: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
  }
  return { __esModule: true, default: { ...client, $transaction: jest.fn((fn: any) => fn(client)) } }
})
jest.mock('../../../../src/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

import prisma from '../../../../src/utils/prismaClient'
import { reconcileTableAfterOrderRemoved } from '../../../../src/services/tpv/table.tpv.service'

const mockedPrisma = prisma as unknown as {
  order: { findFirst: jest.Mock; findMany: jest.Mock }
  table: { findFirst: jest.Mock; findMany: jest.Mock; update: jest.Mock }
  $queryRaw: jest.Mock
}

const VENUE_ID = 'venue-1'
const REMOVED_ORDER_ID = 'split-child-order-1'
const TABLE_ID = 'table-1'
let siblingId: string | null = null
let removedTableId: string | null
let tableFixture: { id: string; number: string; status: string; currentOrderId: string | null } | null
const selectedTable = { id: true, number: true, status: true, currentOrderId: true }

describe('table.tpv.service — reconcileTableAfterOrderRemoved', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    siblingId = null
    removedTableId = TABLE_ID
    tableFixture = { id: TABLE_ID, number: '7', status: 'OCCUPIED', currentOrderId: null }
    mockedPrisma.order.findFirst.mockImplementation(async args =>
      args.where.id === REMOVED_ORDER_ID && args.where.venueId === VENUE_ID ? { id: REMOVED_ORDER_ID, tableId: removedTableId } : null,
    )
    mockedPrisma.order.findMany.mockImplementation(async args => {
      if (args.where.venueId !== VENUE_ID) return []
      const rows = [
        { id: REMOVED_ORDER_ID, tableId: removedTableId, status: 'PENDING', paymentStatus: 'PENDING', createdAt: new Date(0) },
        ...['CANCELLED', 'COMPLETED', 'DELETED'].map(status => ({
          id: `excluded-${status}`,
          tableId: TABLE_ID,
          status,
          paymentStatus: 'PAID',
          createdAt: new Date(0),
        })),
        ...(siblingId ? [{ id: siblingId, tableId: TABLE_ID, status: 'PENDING', paymentStatus: 'PENDING', createdAt: new Date(1) }] : []),
      ]
      return rows.filter(row =>
        args.where.id?.in
          ? args.where.id.in.includes(row.id)
          : args.where.tableId.in.includes(row.tableId) && !args.where.status.notIn.includes(row.status),
      )
    })
    mockedPrisma.table.findMany.mockImplementation(async args => {
      if (args.where.venueId !== VENUE_ID || args.where.currentOrderId) return []
      if (!args.where.id.in.includes(TABLE_ID)) return []
      return tableFixture ? [tableFixture] : []
    })
    mockedPrisma.$queryRaw.mockImplementation(async (query, ...values) => {
      const sql = Array.isArray(query) ? query.join('?') : query.sql
      if (sql.includes('FROM "Venue"') && sql.includes('FOR KEY SHARE')) return [{ id: VENUE_ID }]
      if (sql.includes('FROM "Order"') && sql.includes('FOR UPDATE')) return values[1].map((id: string) => ({ id }))
      if (sql.includes('FROM "Table"') && sql.includes('FOR NO KEY UPDATE')) return [{ id: TABLE_ID }]
      throw new Error(`Unexpected raw statement: ${sql}`)
    })
    mockedPrisma.table.update.mockImplementation(async args => ({ id: args.where.id, number: '7', ...args.data }))
  })

  // ── NEW: the zombie-table fix itself ─────────────────────────────────────

  it('releases the table (AVAILABLE, currentOrderId: null) when the removed order was its ONLY open order — the exact SPLIT_ORDER zombie-table case', async () => {
    // The fixture resolves only the table's own id AND tenant in findMany, never a bare pointer.

    const result = await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)

    expect(mockedPrisma.table.update).toHaveBeenCalledWith({
      where: { id: TABLE_ID },
      data: { status: 'AVAILABLE', currentOrderId: null },
      select: selectedTable,
    })
    expect(result).toEqual({ tableFreed: true })
  })

  it('repoints to a sibling still open on that table instead of releasing it — the table is NOT free just because ONE check left', async () => {
    const SIBLING_ID = 'sibling-order-2'
    siblingId = SIBLING_ID
    // The fixture resolves only the table's own id AND tenant in findMany, never a bare pointer.

    const result = await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)

    expect(mockedPrisma.table.update).toHaveBeenCalledWith({
      where: { id: TABLE_ID },
      data: { status: 'OCCUPIED', currentOrderId: SIBLING_ID },
      select: selectedTable,
    })
    expect(result).toEqual({ tableFreed: false })
  })

  it('the sibling lookup excludes the removed order itself and CANCELLED/COMPLETED/DELETED orders', async () => {
    // The fixture resolves only the table's own id AND tenant in findMany, never a bare pointer.

    await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)

    expect(mockedPrisma.order.findMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, tableId: { in: [TABLE_ID] }, status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] } },
      select: { id: true, tableId: true, status: true, paymentStatus: true, createdAt: true },
      orderBy: { id: 'asc' },
      take: 100,
    })
    // The captured removed row is live, but cannot count as its own sibling; closed rows are excluded by discovery.
    expect(mockedPrisma.table.update).toHaveBeenCalledWith({
      where: { id: TABLE_ID },
      data: { status: 'AVAILABLE', currentOrderId: null },
      select: selectedTable,
    })
    const orderLocks = mockedPrisma.$queryRaw.mock.calls.filter(
      ([query]) => Array.isArray(query) && query.join('').includes('FROM "Order"'),
    )
    expect(orderLocks.map(call => call[2])).toEqual([[REMOVED_ORDER_ID]])
  })

  // ── NEW: edge cases ───────────────────────────────────────────────────────

  it('no-ops when the removed order was never bound to a table (mostrador sale)', async () => {
    removedTableId = null

    const result = await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)

    expect(mockedPrisma.table.findFirst).not.toHaveBeenCalled()
    expect(mockedPrisma.table.update).not.toHaveBeenCalled()
    expect(result).toEqual({ tableFreed: false })
  })

  it('tenant isolation: no-ops if the table does not resolve for THIS venue (never trusts a bare tableId)', async () => {
    tableFixture = null // wrong venue or deleted

    const result = await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)

    expect(mockedPrisma.table.update).not.toHaveBeenCalled()
    expect(result).toEqual({ tableFreed: false })
  })

  it('idempotent: calling it again after the table is already released does the same safe no-sibling write', async () => {
    // The fixture resolves only the table's own id AND tenant in findMany, never a bare pointer.

    await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)
    const result = await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)

    expect(mockedPrisma.table.update).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ tableFreed: true })
  })
})
