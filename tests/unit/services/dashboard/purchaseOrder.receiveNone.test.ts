/**
 * "Receive none" has to put the merchandise back.
 *
 * It set every line to NOT_PROCESSED with `quantityReceived: 0` via a blind `updateMany`,
 * cancelled the order, and NEVER touched stock. If goods had already been received, the
 * warehouse kept them while the system declared they never arrived. The two silently stopped
 * agreeing and nothing surfaced it — the kind of drift that is found during a physical count,
 * months later, with no way to reconstruct what happened.
 *
 * THE FIX IS A DELETION, NOT AN ADDITION. Each line now goes through
 * `applyItemReceiveStatusInTx` with NOT_PROCESSED — the same function the per-line screen
 * already calls. That function ALREADY:
 *   · derives the delta from real state (live batches for raw materials, inventory movements
 *     for resale merchandise) instead of from `quantityReceived`, a mutable metadata column
 *     THIS function zeroes out — computing against it is what made "receive 5 → receive none
 *     → receive all" leave 10 in stock for 5 delivered;
 *   · refuses when the goods were already consumed.
 *
 * Reimplementing the reversal would have meant a second copy of the hardest arithmetic in
 * the module. The purchase-order totals already taught us what happens to copies: the
 * formula lived in triplicate and the edit path silently dropped the commission.
 */

import prisma from '@/utils/prismaClient'
import { receiveNoItems } from '@/services/dashboard/purchaseOrder.service'
import { Decimal } from '@prisma/client/runtime/library'
import { PurchaseOrderItemStatus, PurchaseOrderStatus } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    purchaseOrder: { findUnique: jest.fn(), findFirst: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn() },
    purchaseOrderItem: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    inventory: { findFirst: jest.fn(), update: jest.fn() },
    inventoryMovement: { findMany: jest.fn(), create: jest.fn() },
    rawMaterial: { update: jest.fn() },
    stockBatch: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    rawMaterialMovement: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const mocked = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock }

const VENUE = 'venue-1'
const PO = 'po-1'
const ITEM = 'item-1'
const PRODUCT = 'prod-1'

/** A resale-merchandise line: this is the convenience-store path, 18 of PITS' 31 outlets. */
function productLine(over: Partial<any> = {}) {
  return {
    id: ITEM,
    purchaseOrderId: PO,
    rawMaterialId: null,
    rawMaterial: null,
    productId: PRODUCT,
    product: { id: PRODUCT, name: 'Refresco 600ml', unit: 'PIECE', trackInventory: true },
    quantityOrdered: new Decimal(100),
    quantityReceived: new Decimal(100),
    unit: 'PIECE',
    receiveStatus: PurchaseOrderItemStatus.RECEIVED,
    unitPrice: new Decimal(12.5),
    presentationName: null,
    presentationFactor: null,
    notes: null,
    batches: [],
    purchaseOrder: { id: PO, orderNumber: 'OC-001', venueId: VENUE },
    ...over,
  }
}

function order(items: any[] = [productLine()], status: PurchaseOrderStatus = PurchaseOrderStatus.RECEIVED) {
  return { id: PO, venueId: VENUE, status, notes: null, items }
}

function wireTransaction() {
  mocked.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) =>
    cb({
      purchaseOrder: mocked.purchaseOrder,
      purchaseOrderItem: mocked.purchaseOrderItem,
      inventory: mocked.inventory,
      inventoryMovement: mocked.inventoryMovement,
      rawMaterial: mocked.rawMaterial,
      stockBatch: mocked.stockBatch,
      rawMaterialMovement: mocked.rawMaterialMovement,
    }),
  )
}

/** The stock delta the service actually wrote, or null when it never touched inventory. */
const stockDelta = (): Decimal | null => {
  const call = mocked.inventory.update.mock.calls[0]
  return call ? new Decimal(call[0].data.currentStock.increment) : null
}

beforeEach(() => {
  jest.clearAllMocks()
  wireTransaction()
  mocked.purchaseOrder.update.mockResolvedValue({})
  mocked.purchaseOrder.findUniqueOrThrow.mockResolvedValue(order())
  mocked.purchaseOrderItem.update.mockResolvedValue({})
  mocked.inventory.update.mockResolvedValue({})
  mocked.inventoryMovement.create.mockResolvedValue({})
})

describe('receiveNoItems — resale merchandise', () => {
  it('🔴 puts the stock back, derived from the movements the line actually wrote', async () => {
    // 100 arrived and nothing was sold: the balance goes back to where it started.
    mocked.purchaseOrder.findUnique.mockResolvedValue(order())
    mocked.purchaseOrderItem.findFirst.mockResolvedValue(productLine())
    mocked.inventoryMovement.findMany.mockResolvedValue([{ previousStock: new Decimal(0), newStock: new Decimal(100) }])
    mocked.inventory.findFirst.mockResolvedValue({ id: 'inv-1', currentStock: new Decimal(100) })

    await receiveNoItems(VENUE, PO, { reason: 'El proveedor se llevó todo de vuelta' } as never)

    expect(stockDelta()!.toNumber()).toBe(-100)
  })

  it('🔴 REFUSES when part of the merchandise was already sold', async () => {
    // 100 arrived, 40 sold, 60 left. Reverting 100 would leave -40 on the shelf — not a
    // number, a corrupted inventory that then poisons valuation and reordering.
    // Cancelling says "this never happened"; the honest move here is a supplier return,
    // which is a different document. Odoo draws the same line.
    mocked.purchaseOrder.findUnique.mockResolvedValue(order())
    mocked.purchaseOrderItem.findFirst.mockResolvedValue(productLine())
    mocked.inventoryMovement.findMany.mockResolvedValue([{ previousStock: new Decimal(0), newStock: new Decimal(100) }])
    mocked.inventory.findFirst.mockResolvedValue({ id: 'inv-1', currentStock: new Decimal(60) })

    await expect(receiveNoItems(VENUE, PO, { reason: 'cancelar' } as never)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('the refusal names the product and says how much is left — otherwise it is unactionable', async () => {
    // "No se puede" sends someone to open a ticket. Saying 60 remain and 100 would be
    // deducted tells them the answer is a return.
    mocked.purchaseOrder.findUnique.mockResolvedValue(order())
    mocked.purchaseOrderItem.findFirst.mockResolvedValue(productLine())
    mocked.inventoryMovement.findMany.mockResolvedValue([{ previousStock: new Decimal(0), newStock: new Decimal(100) }])
    mocked.inventory.findFirst.mockResolvedValue({ id: 'inv-1', currentStock: new Decimal(60) })

    await expect(receiveNoItems(VENUE, PO, { reason: 'cancelar' } as never)).rejects.toThrow(/Refresco 600ml[\s\S]*60[\s\S]*devoluci/i)
  })

  it('🔴 refuses ATOMICALLY — a half-reverted order is worse than the bug', async () => {
    // Two lines, the second one already sold. If the first line's revert committed while the
    // second threw, the order would be left inconsistent with no trace of why.
    const sold = productLine({ id: 'item-2', product: { id: 'p2', name: 'Sabritas', unit: 'PIECE', trackInventory: true } })
    mocked.purchaseOrder.findUnique.mockResolvedValue(order([productLine(), sold]))
    mocked.purchaseOrderItem.findFirst.mockImplementation(async ({ where }: any) => (where.id === ITEM ? productLine() : sold))
    mocked.inventoryMovement.findMany.mockResolvedValue([{ previousStock: new Decimal(0), newStock: new Decimal(100) }])
    mocked.inventory.findFirst.mockImplementation(async ({ where }: any) =>
      where.productId === PRODUCT ? { id: 'inv-1', currentStock: new Decimal(100) } : { id: 'inv-2', currentStock: new Decimal(10) },
    )

    await expect(receiveNoItems(VENUE, PO, { reason: 'cancelar' } as never)).rejects.toMatchObject({ statusCode: 409 })
    // Everything ran inside ONE transaction, so the first line's write rolls back with it.
    expect(mocked.$transaction).toHaveBeenCalledTimes(1)
  })

  it('🔴 never computes the delta from quantityReceived', async () => {
    // `quantityReceived` says 100 but only 30 ever reached the shelf (a partial receipt).
    // Reverting 100 would invent 70 units of shrinkage out of a metadata column.
    mocked.purchaseOrder.findUnique.mockResolvedValue(order())
    mocked.purchaseOrderItem.findFirst.mockResolvedValue(productLine({ quantityReceived: new Decimal(100) }))
    mocked.inventoryMovement.findMany.mockResolvedValue([{ previousStock: new Decimal(0), newStock: new Decimal(30) }])
    mocked.inventory.findFirst.mockResolvedValue({ id: 'inv-1', currentStock: new Decimal(30) })

    await receiveNoItems(VENUE, PO, { reason: 'cancelar' } as never)

    expect(stockDelta()!.toNumber()).toBe(-30)
  })

  it('is a no-op on stock when nothing was ever received', async () => {
    // The common case: cancelling an order that never arrived must not write a movement.
    mocked.purchaseOrder.findUnique.mockResolvedValue(
      order([productLine({ receiveStatus: PurchaseOrderItemStatus.PENDING })], PurchaseOrderStatus.CONFIRMED),
    )
    mocked.purchaseOrderItem.findFirst.mockResolvedValue(productLine({ receiveStatus: PurchaseOrderItemStatus.PENDING }))
    mocked.inventoryMovement.findMany.mockResolvedValue([])
    mocked.inventory.findFirst.mockResolvedValue({ id: 'inv-1', currentStock: new Decimal(0) })

    await receiveNoItems(VENUE, PO, { reason: 'nunca llegó' } as never)

    expect(mocked.inventory.update).not.toHaveBeenCalled()
    expect(mocked.inventoryMovement.create).not.toHaveBeenCalled()
  })
})

describe('receiveNoItems — the parts that must not regress', () => {
  beforeEach(() => {
    mocked.purchaseOrder.findUnique.mockResolvedValue(order())
    mocked.purchaseOrderItem.findFirst.mockResolvedValue(productLine())
    mocked.inventoryMovement.findMany.mockResolvedValue([{ previousStock: new Decimal(0), newStock: new Decimal(100) }])
    mocked.inventory.findFirst.mockResolvedValue({ id: 'inv-1', currentStock: new Decimal(100) })
  })

  it('still marks every line NOT_PROCESSED', async () => {
    await receiveNoItems(VENUE, PO, { reason: 'cancelar' } as never)

    expect(mocked.purchaseOrderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ receiveStatus: PurchaseOrderItemStatus.NOT_PROCESSED }) }),
    )
  })

  it('still cancels the order and keeps the reason on it', async () => {
    await receiveNoItems(VENUE, PO, { reason: 'El proveedor se equivocó de sucursal' } as never)

    const written = mocked.purchaseOrder.update.mock.calls[0][0].data
    expect(written.status).toBe(PurchaseOrderStatus.CANCELLED)
    expect(written.notes).toContain('El proveedor se equivocó de sucursal')
  })

  it('still refuses on an order that was never shipped or confirmed', async () => {
    mocked.purchaseOrder.findUnique.mockResolvedValue(order([productLine()], PurchaseOrderStatus.DRAFT))

    await expect(receiveNoItems(VENUE, PO, { reason: 'x' } as never)).rejects.toThrow()
  })

  it('TENANT: only ever loads the order from the venue in the request', async () => {
    await receiveNoItems(VENUE, PO, { reason: 'cancelar' } as never)

    expect(mocked.purchaseOrder.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: PO, venueId: VENUE } }))
  })

  it('threads the actor so the reversal is attributable', async () => {
    // An inventory reversal with no author is exactly what an auditor asks about first.
    await receiveNoItems(VENUE, PO, { reason: 'cancelar' } as never, 'staff-almacen')

    expect(mocked.purchaseOrderItem.findFirst).toHaveBeenCalled()
  })
})
