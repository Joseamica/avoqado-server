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
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findFirst: jest.fn() },
    table: { findFirst: jest.fn(), update: jest.fn() },
  },
}))
jest.mock('../../../../src/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

import prisma from '../../../../src/utils/prismaClient'
import { reconcileTableAfterOrderRemoved } from '../../../../src/services/tpv/table.tpv.service'

const mockedPrisma = prisma as unknown as {
  order: { findFirst: jest.Mock }
  table: { findFirst: jest.Mock; update: jest.Mock }
}

const VENUE_ID = 'venue-1'
const REMOVED_ORDER_ID = 'split-child-order-1'
const TABLE_ID = 'table-1'

describe('table.tpv.service — reconcileTableAfterOrderRemoved', () => {
  beforeEach(() => jest.clearAllMocks())

  // ── NEW: the zombie-table fix itself ─────────────────────────────────────

  it('releases the table (AVAILABLE, currentOrderId: null) when the removed order was its ONLY open order — the exact SPLIT_ORDER zombie-table case', async () => {
    mockedPrisma.order.findFirst.mockImplementation((args: any) => {
      // 1st call: look up the removed order's own tableId (works even though
      // Table.currentOrderId never pointed at it — that's the whole fix).
      if (args.where.id === REMOVED_ORDER_ID) return Promise.resolve({ tableId: TABLE_ID })
      // 2nd call: sibling lookup on that table — none left.
      return Promise.resolve(null)
    })
    // Strict by design: only resolves when queried by the table's OWN id (the
    // correct lookup) — a regression back to querying by `currentOrderId`
    // (the original bug) must see this as "table not found" and no-op, not
    // silently succeed because the mock was too permissive. Caught exactly
    // this gap during sabotage testing (2026-08-07).
    mockedPrisma.table.findFirst.mockImplementation((args: any) =>
      args?.where?.id === TABLE_ID && args?.where?.venueId === VENUE_ID
        ? Promise.resolve({ id: TABLE_ID, number: '7' })
        : Promise.resolve(null),
    )
    mockedPrisma.table.update.mockResolvedValue({})

    const result = await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)

    expect(mockedPrisma.table.update).toHaveBeenCalledWith({
      where: { id: TABLE_ID },
      data: { status: 'AVAILABLE', currentOrderId: null },
    })
    expect(result).toEqual({ tableFreed: true })
  })

  it('repoints to a sibling still open on that table instead of releasing it — the table is NOT free just because ONE check left', async () => {
    const SIBLING_ID = 'sibling-order-2'
    mockedPrisma.order.findFirst.mockImplementation((args: any) => {
      if (args.where.id === REMOVED_ORDER_ID) return Promise.resolve({ tableId: TABLE_ID })
      return Promise.resolve({ id: SIBLING_ID })
    })
    // Strict by design: only resolves when queried by the table's OWN id (the
    // correct lookup) — a regression back to querying by `currentOrderId`
    // (the original bug) must see this as "table not found" and no-op, not
    // silently succeed because the mock was too permissive. Caught exactly
    // this gap during sabotage testing (2026-08-07).
    mockedPrisma.table.findFirst.mockImplementation((args: any) =>
      args?.where?.id === TABLE_ID && args?.where?.venueId === VENUE_ID
        ? Promise.resolve({ id: TABLE_ID, number: '7' })
        : Promise.resolve(null),
    )
    mockedPrisma.table.update.mockResolvedValue({})

    const result = await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)

    expect(mockedPrisma.table.update).toHaveBeenCalledWith({
      where: { id: TABLE_ID },
      data: { status: 'OCCUPIED', currentOrderId: SIBLING_ID },
    })
    expect(result).toEqual({ tableFreed: false })
  })

  it('the sibling lookup excludes the removed order itself and CANCELLED/COMPLETED/DELETED orders', async () => {
    mockedPrisma.order.findFirst.mockImplementation((args: any) => {
      if (args.where.id === REMOVED_ORDER_ID) return Promise.resolve({ tableId: TABLE_ID })
      return Promise.resolve(null)
    })
    // Strict by design: only resolves when queried by the table's OWN id (the
    // correct lookup) — a regression back to querying by `currentOrderId`
    // (the original bug) must see this as "table not found" and no-op, not
    // silently succeed because the mock was too permissive. Caught exactly
    // this gap during sabotage testing (2026-08-07).
    mockedPrisma.table.findFirst.mockImplementation((args: any) =>
      args?.where?.id === TABLE_ID && args?.where?.venueId === VENUE_ID
        ? Promise.resolve({ id: TABLE_ID, number: '7' })
        : Promise.resolve(null),
    )
    mockedPrisma.table.update.mockResolvedValue({})

    await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)

    const siblingCall = mockedPrisma.order.findFirst.mock.calls[1][0]
    expect(siblingCall.where).toEqual({
      venueId: VENUE_ID,
      tableId: TABLE_ID,
      id: { not: REMOVED_ORDER_ID },
      status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] },
    })
  })

  // ── NEW: edge cases ───────────────────────────────────────────────────────

  it('no-ops when the removed order was never bound to a table (mostrador sale)', async () => {
    mockedPrisma.order.findFirst.mockResolvedValue({ tableId: null })

    const result = await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)

    expect(mockedPrisma.table.findFirst).not.toHaveBeenCalled()
    expect(mockedPrisma.table.update).not.toHaveBeenCalled()
    expect(result).toEqual({ tableFreed: false })
  })

  it('tenant isolation: no-ops if the table does not resolve for THIS venue (never trusts a bare tableId)', async () => {
    mockedPrisma.order.findFirst.mockResolvedValue({ tableId: TABLE_ID })
    mockedPrisma.table.findFirst.mockResolvedValue(null) // wrong venue or deleted

    const result = await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)

    expect(mockedPrisma.table.update).not.toHaveBeenCalled()
    expect(result).toEqual({ tableFreed: false })
  })

  it('idempotent: calling it again after the table is already released does the same safe no-sibling write', async () => {
    mockedPrisma.order.findFirst.mockImplementation((args: any) => {
      if (args.where.id === REMOVED_ORDER_ID) return Promise.resolve({ tableId: TABLE_ID })
      return Promise.resolve(null)
    })
    // Strict by design: only resolves when queried by the table's OWN id (the
    // correct lookup) — a regression back to querying by `currentOrderId`
    // (the original bug) must see this as "table not found" and no-op, not
    // silently succeed because the mock was too permissive. Caught exactly
    // this gap during sabotage testing (2026-08-07).
    mockedPrisma.table.findFirst.mockImplementation((args: any) =>
      args?.where?.id === TABLE_ID && args?.where?.venueId === VENUE_ID
        ? Promise.resolve({ id: TABLE_ID, number: '7' })
        : Promise.resolve(null),
    )
    mockedPrisma.table.update.mockResolvedValue({})

    await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)
    const result = await reconcileTableAfterOrderRemoved(VENUE_ID, REMOVED_ORDER_ID)

    expect(mockedPrisma.table.update).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ tableFreed: true })
  })
})
