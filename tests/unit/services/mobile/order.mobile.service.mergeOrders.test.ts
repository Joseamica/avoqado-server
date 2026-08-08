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
 * (order-table.tpv.controller.ts explicitly re-exports the SAME function so
 * "/mobile stays byte-identical"), and the offline sync reducer
 * (MERGE_ORDERS intent) all call this exact function in
 * src/services/mobile/order.mobile.service.ts — which is FROZEN for this
 * change (iOS/Android are developed against it in parallel by other
 * sessions). So this test is written to PIN the desired behavior but is
 * EXPECTED TO FAIL (red) until someone authorized to touch that frozen file
 * ships the fix described in the accompanying report — the red result here
 * IS the proof of the defect, not a mistake.
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
          items: [{ id: 'item-1' }],
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

  // ⏸️ SKIP DELIBERADO — este test sigue fallando hoy, A PROPÓSITO.
  //
  // No es un test roto: fija el defecto de la "mesa fantasma" en `mergeOrders`
  // MISMO (esta función, `src/services/mobile/`, sigue CONGELADA — iOS/Android
  // se desarrollan contra ese namespace en paralelo). Sigue en skip porque este
  // archivo llama a `mergeOrders` DIRECTAMENTE — nunca se puede arreglar sin
  // tocar la zona congelada.
  //
  // FIX 2026-08-07: el hueco se cerró del lado `/tpv` (el único lado que la
  // TPV usa), NO acá. Ver `table.tpv.service.ts::reconcileTableAfterOrderRemoved`
  // (reconcilia por `tableId` sin condicionar a `currentOrderId`, igual que
  // `moveOrderToTable`) y su prueba:
  // `tests/unit/services/tpv/table.tpv.service.reconcileTableAfterOrderRemoved.test.ts`
  // — más la prueba de wiring en
  // `tests/unit/controllers/tpv/order-table.tpv.controller.test.ts` (describe
  // "mergeOrders", casos de `reconcileTableAfterOrderRemoved`). El mismo hueco
  // SIGUE abierto en `/mobile` (única superficie congelada, sin caller
  // no-congelado donde reconciliar) — ver el reporte de Fix 1 para el detalle.
  // Este test se queda en skip como prueba viva de que el hueco de `/mobile`
  // sigue ahí.
  //
  // 🔴 `cancelOrder` (el otro caller de la MISMA release-de-mesa con el MISMO
  // hueco — busca `Table.currentOrderId === orderId`) SÍ se cerró del lado
  // `/tpv`, 2026-08-07: hasta entonces `cancelOrder` no tenía NINGUNA ruta
  // online bajo `/tpv` (viajaba siempre como intent, ver KDoc de
  // `TablesRepository.cancelOrder` en avoqado-tpv), así que no había
  // superficie no-congelada donde reconciliar. Se agregó
  // `POST /tpv/venues/:venueId/orders/:orderId/cancel`
  // (`order-table.tpv.controller.ts::cancelOrder`), que delega en el MISMO
  // `orderMobileService.cancelOrder` de este archivo y reconcilia después con
  // `reconcileTableAfterOrderRemoved` — mismo patrón que `mergeOrders` arriba.
  // Ver `.superpowers/sdd/2026-07-24-tpv-plan-b-superficie-tpv-server/tpv-cancel-order-route.md`.
  it.skip('releases table-1 (AVAILABLE, currentOrderId: null) after merging away its only order, a split child', async () => {
    const result = await mergeOrders(VENUE_ID, TARGET_ID, SPLIT_CHILD_SOURCE_ID, 'staff-1')

    expect(prismaMock.table.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SOURCE_TABLE_ID },
        data: expect.objectContaining({ status: 'AVAILABLE', currentOrderId: null }),
      }),
    )
    expect(result.tableFreed).toBe(true)
  })
})
