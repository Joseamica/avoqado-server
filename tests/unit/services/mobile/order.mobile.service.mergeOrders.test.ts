/**
 * mergeOrders — zombie table when the source order came from a SPLIT
 * (Defect 2, 2026-08 hardware repro).
 *
 * Root cause (confirmed by reading splitOrderItems/splitOrderBySeat and
 * mergeOrders in src/services/mobile/order.mobile.service.ts): a child order
 * created by SPLIT_ORDER/SPLIT_BY_SEAT NEVER gets `Table.currentOrderId` set
 * to it — the comment on splitOrderItems says so explicitly ("The table stays
 * OCCUPIED; currentOrderId keeps pointing at the source"). mergeOrders' own
 * table-release step only frees/repoints a table when
 * `Table.currentOrderId === source.id` — a split child never satisfies that,
 * so when it is later the table's LAST open order and gets merged away, the
 * lookup misses, the free-up silently no-ops, and the table stays OCCUPIED
 * with openOrders: [] forever ("zombie table", already seen live on a
 * tablet). The endpoint's own response admits it (`tableFreed: false`).
 *
 * `mergeOrders` is SHARED: /mobile (avoqado-android/ios), /tpv
 * (order-table.tpv.controller.ts) and the offline sync reducer (MERGE_ORDERS
 * intent) all call this exact function. The /tpv controller already
 * reconciled from its own layer (`reconcileTableAfterOrderRemoved`, 2026-08-07);
 * R2-TABLE-01 (auditoría Mesas 40, 2026-10-05) closes the same gap for /mobile
 * and the reducer: when the pointer lookup misses, the shared service calls
 * the same idempotent helper by the order's own `tableId`.
 */

jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

jest.mock('@/services/mobile/service-charge.mobile.service', () => ({
  __esModule: true,
  syncAutomaticServiceCharges: jest.fn().mockResolvedValue(null),
}))

import { Decimal } from '@prisma/client/runtime/library'
import { mergeOrders } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE_ID = 'venue-1'
const TARGET_ID = 'target-order-1'
// The order being merged AWAY. It was created by splitOrderItems earlier in
// its life — no `Table` row was ever written with currentOrderId pointing at
// it, exactly as splitOrderItems/splitOrderBySeat leave things.
const SPLIT_CHILD_SOURCE_ID = 'split-child-order-1'
const SOURCE_TABLE_ID = 'table-1'

describe('mergeOrders frees the source table even when the source order came from a split', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    // Diseño §C.6: la fusión toma el candado de LAS DOS órdenes (`$queryRaw … FOR UPDATE`, 2 filas) y consulta el
    // cobro de terminal vivo del origen DENTRO de la tx.
    prismaMock.$queryRaw.mockResolvedValue([{ id: SPLIT_CHILD_SOURCE_ID }, { id: TARGET_ID }])
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)

    // order.findFirst is called for: target lookup, source lookup, freshSource,
    // freshTarget (all keyed by `where.id`), and — in a correct fix — the
    // sibling-on-this-table lookup (keyed by `where.tableId`). Route by args
    // instead of a fixed call sequence so this test doesn't depend on the
    // exact number/order of calls a future fix makes.
    prismaMock.order.findFirst.mockImplementation((args: any) => {
      const where = args?.where ?? {}
      if (where.id === TARGET_ID) {
        return Promise.resolve({
          id: TARGET_ID,
          orderNumber: 'ORD-TARGET',
          status: 'CONFIRMED',
          paymentStatus: 'PENDING',
          paidAmount: new Decimal(0),
          tableId: 'table-2',
          specialRequests: null,
          contratoDePrecio: 'IVA_INCLUIDO',
          originSystem: null,
        })
      }
      if (where.id === SPLIT_CHILD_SOURCE_ID) {
        return Promise.resolve({
          id: SPLIT_CHILD_SOURCE_ID,
          orderNumber: 'ORD-SPLIT-CHILD',
          status: 'PENDING',
          paymentStatus: 'PENDING',
          tableId: SOURCE_TABLE_ID,
          customerName: null,
          specialRequests: null,
          contratoDePrecio: 'IVA_INCLUIDO',
          originSystem: null,
          taxAmount: new Decimal(0),
          items: [{ id: 'item-1' }],
          _count: { items: 1 },
          orderDiscounts: [],
          serviceCharges: [],
        })
      }
      if (where.tableId === SOURCE_TABLE_ID) {
        // The split child was the table's ONLY open order — no sibling to
        // repoint to, so the table must be released.
        return Promise.resolve(null)
      }
      return Promise.resolve(null)
    })

    // Split children never get a Table row pointing at them via currentOrderId
    // — this is the literal root cause, reproduced here.
    prismaMock.table.findFirst.mockImplementation((args: any) => {
      const where = args?.where ?? {}
      if (where.currentOrderId === SPLIT_CHILD_SOURCE_ID) return Promise.resolve(null)
      if (where.id === SOURCE_TABLE_ID) {
        return Promise.resolve({ id: SOURCE_TABLE_ID, number: 7, currentOrderId: 'some-earlier-closed-order' })
      }
      return Promise.resolve(null)
    })
    prismaMock.table.update.mockResolvedValue({})

    prismaMock.orderItem.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.orderServiceCharge.deleteMany.mockResolvedValue({ count: 0 })
    prismaMock.orderItem.findMany.mockResolvedValue([{ total: new Decimal(100) }])
    prismaMock.orderDiscount.findMany.mockResolvedValue([])
    prismaMock.orderServiceCharge.findMany.mockResolvedValue([])
    prismaMock.order.update.mockResolvedValue({
      subtotal: new Decimal(100),
      discountAmount: new Decimal(0),
      serviceChargeAmount: new Decimal(0),
      total: new Decimal(100),
      version: 2,
    })
  })

  // R2-TABLE-01: este caso estuvo en skip mientras `/mobile` estaba congelado (sólo `/tpv` reconciliaba). Ahora el
  // servicio compartido reconcilia por el `tableId` propio de la orden cuando el puntero no la encuentra.
  it('releases table-1 (AVAILABLE, currentOrderId: null) after merging away its only order, a split child', async () => {
    const result = await mergeOrders(VENUE_ID, TARGET_ID, SPLIT_CHILD_SOURCE_ID, 'staff-1')

    expect(prismaMock.table.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SOURCE_TABLE_ID },
        data: expect.objectContaining({ status: 'AVAILABLE', currentOrderId: null }),
      }),
    )
    expect(result.tableFreed).toBe(true)
  })

  it('regression: when the table pointer DOES point at the source, repoints/frees through the pointer path as before', async () => {
    prismaMock.table.findFirst.mockImplementation((args: any) => {
      const where = args?.where ?? {}
      if (where.currentOrderId === SPLIT_CHILD_SOURCE_ID) return Promise.resolve({ id: SOURCE_TABLE_ID, number: 7 })
      return Promise.resolve(null)
    })

    const result = await mergeOrders(VENUE_ID, TARGET_ID, SPLIT_CHILD_SOURCE_ID, 'staff-1')

    expect(prismaMock.table.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.table.update).toHaveBeenCalledWith({
      where: { id: SOURCE_TABLE_ID },
      data: { status: 'AVAILABLE', currentOrderId: null },
    })
    expect(result.tableFreed).toBe(true)
  })
})
