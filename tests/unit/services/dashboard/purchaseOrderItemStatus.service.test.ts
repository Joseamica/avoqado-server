/**
 * Unit tests for the robust state-machine in updatePurchaseOrderItemStatus.
 *
 * Bug fixed (2026-05-11): the per-item endpoint used to flip
 * receiveStatus → RECEIVED without ever creating a StockBatch or incrementing
 * RawMaterial.currentStock. These tests pin the new behaviour so it doesn't
 * regress.
 */

import prisma from '@/utils/prismaClient'
import { updatePurchaseOrderItemStatus } from '@/services/dashboard/purchaseOrder.service'
import AppError from '@/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'
import { BatchStatus, PurchaseOrderItemStatus, RawMaterialMovementType } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    purchaseOrderItem: { findFirst: jest.fn(), update: jest.fn() },
    purchaseOrder: { findUnique: jest.fn(), update: jest.fn() },
    rawMaterial: { update: jest.fn() },
    stockBatch: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    rawMaterialMovement: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const mockedPrisma = prisma as unknown as {
  purchaseOrderItem: { findFirst: jest.Mock; update: jest.Mock }
  purchaseOrder: { findUnique: jest.Mock; update: jest.Mock }
  rawMaterial: { update: jest.Mock }
  stockBatch: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock }
  rawMaterialMovement: { create: jest.Mock }
  $transaction: jest.Mock
}

const VENUE_ID = 'venue-1'
const PO_ID = 'po-1'
const ITEM_ID = 'item-1'
const RM_ID = 'rm-1'

function makeItem(overrides: Partial<any> = {}) {
  return {
    id: ITEM_ID,
    purchaseOrderId: PO_ID,
    rawMaterialId: RM_ID,
    quantityOrdered: new Decimal(10),
    quantityReceived: new Decimal(0),
    unit: 'KILOGRAM',
    receiveStatus: PurchaseOrderItemStatus.PENDING,
    unitPrice: new Decimal(5),
    total: new Decimal(50),
    notes: null,
    rawMaterial: {
      id: RM_ID,
      name: 'Carne',
      unit: 'KILOGRAM',
      currentStock: new Decimal(0),
      perishable: false,
      shelfLifeDays: null,
    },
    batches: [],
    purchaseOrder: { id: PO_ID, orderNumber: 'PO-TEST-001' },
    ...overrides,
  }
}

/**
 * Wires up $transaction to invoke the callback with a tx mock that re-uses the
 * top-level prisma mocks. This matches how the real Prisma client behaves —
 * tx.* methods proxy to the same models.
 */
function wireTransaction() {
  mockedPrisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => {
    const tx = {
      purchaseOrderItem: mockedPrisma.purchaseOrderItem,
      purchaseOrder: mockedPrisma.purchaseOrder,
      rawMaterial: mockedPrisma.rawMaterial,
      stockBatch: mockedPrisma.stockBatch,
      rawMaterialMovement: mockedPrisma.rawMaterialMovement,
    }
    return cb(tx)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  wireTransaction()
  // updatePurchaseOrderStatusBasedOnItems → uses prisma.purchaseOrder.findUnique
  mockedPrisma.purchaseOrder.findUnique.mockResolvedValue({
    id: PO_ID,
    status: 'CONFIRMED',
    items: [],
  })
  mockedPrisma.stockBatch.findFirst.mockResolvedValue(null)
  mockedPrisma.stockBatch.create.mockImplementation(async ({ data }: any) => ({ id: 'batch-new', ...data }))
  mockedPrisma.purchaseOrderItem.update.mockResolvedValue({})
  mockedPrisma.rawMaterial.update.mockResolvedValue({})
  mockedPrisma.rawMaterialMovement.create.mockResolvedValue({})
  mockedPrisma.stockBatch.update.mockResolvedValue({})
})

describe('updatePurchaseOrderItemStatus — robust state machine', () => {
  // ────────────────────────────────────────────────────────────────────────
  // FORWARD TRANSITIONS
  // ────────────────────────────────────────────────────────────────────────
  describe('Forward: PENDING → RECEIVED', () => {
    it('creates a StockBatch, increments currentStock and writes a PURCHASE movement', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeItem())

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.RECEIVED,
        quantityReceived: 4,
      } as any)

      // Item updated with new status + qty
      expect(mockedPrisma.purchaseOrderItem.update).toHaveBeenCalledWith({
        where: { id: ITEM_ID },
        data: expect.objectContaining({
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: expect.any(Decimal),
        }),
      })

      // Batch created with the delta in RM unit
      expect(mockedPrisma.stockBatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          venueId: VENUE_ID,
          rawMaterialId: RM_ID,
          purchaseOrderItemId: ITEM_ID,
          initialQuantity: expect.any(Decimal),
          remainingQuantity: expect.any(Decimal),
          unit: 'KILOGRAM',
          status: BatchStatus.ACTIVE,
        }),
      })
      const batchData = mockedPrisma.stockBatch.create.mock.calls[0][0].data
      expect(batchData.initialQuantity.toString()).toBe('4')
      expect(batchData.remainingQuantity.toString()).toBe('4')

      // Stock incremented
      expect(mockedPrisma.rawMaterial.update).toHaveBeenCalledWith({
        where: { id: RM_ID },
        data: { currentStock: expect.any(Decimal) },
      })
      const stockUpdate = mockedPrisma.rawMaterial.update.mock.calls[0][0]
      expect(stockUpdate.data.currentStock.toString()).toBe('4')

      // PURCHASE movement logged
      expect(mockedPrisma.rawMaterialMovement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: RawMaterialMovementType.PURCHASE,
          quantity: expect.any(Decimal),
          previousStock: expect.any(Decimal),
          newStock: expect.any(Decimal),
        }),
      })
    })

    it('rejects a quantityReceived that exceeds quantityOrdered', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(makeItem({ quantityOrdered: new Decimal(5) }))

      await expect(
        updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: 10,
        } as any),
      ).rejects.toThrow(AppError)

      expect(mockedPrisma.stockBatch.create).not.toHaveBeenCalled()
      expect(mockedPrisma.rawMaterial.update).not.toHaveBeenCalled()
    })

    it('rejects when PO unit is dimensionally incompatible with RawMaterial unit', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(
        makeItem({
          unit: 'LITER',
          rawMaterial: { id: RM_ID, name: 'Carne', unit: 'KILOGRAM', currentStock: new Decimal(0), perishable: false, shelfLifeDays: null },
        }),
      )

      await expect(
        updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: 1,
        } as any),
      ).rejects.toThrow(/incompatible/i)
    })

    it('converts PO unit to RawMaterial unit when receiving 1 KG into a GRAM raw material', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(
        makeItem({
          unit: 'KILOGRAM',
          unitPrice: new Decimal(10), // $10 per KG
          rawMaterial: { id: RM_ID, name: 'Sal', unit: 'GRAM', currentStock: new Decimal(0), perishable: false, shelfLifeDays: null },
        }),
      )

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.RECEIVED,
        quantityReceived: 1,
      } as any)

      const batchData = mockedPrisma.stockBatch.create.mock.calls[0][0].data
      expect(batchData.unit).toBe('GRAM')
      expect(batchData.initialQuantity.toString()).toBe('1000')
      // costPerUnit must be normalized: $10/KG → $0.01/GRAM
      expect(batchData.costPerUnit.toString()).toBe('0.01')

      const stockUpdate = mockedPrisma.rawMaterial.update.mock.calls[0][0]
      expect(stockUpdate.data.currentStock.toString()).toBe('1000')
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // REVERSE TRANSITIONS
  // ────────────────────────────────────────────────────────────────────────
  describe('Reverse: RECEIVED → DAMAGED / NOT_PROCESSED', () => {
    it('drains the batch, decrements currentStock and logs a SPOILAGE movement when going to DAMAGED', async () => {
      const existingBatch = {
        id: 'batch-existing',
        initialQuantity: new Decimal(4),
        remainingQuantity: new Decimal(4),
        receivedDate: new Date('2026-05-10'),
        status: BatchStatus.ACTIVE,
        depletedAt: null,
      }
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(
        makeItem({
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: new Decimal(4),
          rawMaterial: { id: RM_ID, name: 'Carne', unit: 'KILOGRAM', currentStock: new Decimal(4), perishable: false, shelfLifeDays: null },
          batches: [existingBatch],
        }),
      )

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.DAMAGED,
      } as any)

      // Batch drained to 0 + quarantined
      expect(mockedPrisma.stockBatch.update).toHaveBeenCalledWith({
        where: { id: 'batch-existing' },
        data: expect.objectContaining({
          status: BatchStatus.QUARANTINED,
          remainingQuantity: expect.any(Decimal),
          initialQuantity: expect.any(Decimal),
        }),
      })
      const updateData = mockedPrisma.stockBatch.update.mock.calls[0][0].data
      expect(updateData.remainingQuantity.toString()).toBe('0')
      expect(updateData.initialQuantity.toString()).toBe('0')

      // currentStock decremented to 0
      const stockUpdate = mockedPrisma.rawMaterial.update.mock.calls[0][0]
      expect(stockUpdate.data.currentStock.toString()).toBe('0')

      // Movement type SPOILAGE for DAMAGED
      const movement = mockedPrisma.rawMaterialMovement.create.mock.calls[0][0].data
      expect(movement.type).toBe(RawMaterialMovementType.SPOILAGE)
      expect(movement.quantity.toString()).toBe('-4')

      // No new batch created on reversal
      expect(mockedPrisma.stockBatch.create).not.toHaveBeenCalled()
    })

    it('uses RETURN movement type when going to NOT_PROCESSED', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(
        makeItem({
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: new Decimal(2),
          rawMaterial: { id: RM_ID, name: 'Carne', unit: 'KILOGRAM', currentStock: new Decimal(2), perishable: false, shelfLifeDays: null },
          batches: [
            {
              id: 'batch-existing',
              initialQuantity: new Decimal(2),
              remainingQuantity: new Decimal(2),
              receivedDate: new Date('2026-05-10'),
              status: BatchStatus.ACTIVE,
              depletedAt: null,
            },
          ],
        }),
      )

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.NOT_PROCESSED,
      } as any)

      const movement = mockedPrisma.rawMaterialMovement.create.mock.calls[0][0].data
      expect(movement.type).toBe(RawMaterialMovementType.RETURN)
    })

    it('blocks the reversal when the batch has already been consumed by sales', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(
        makeItem({
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: new Decimal(4),
          rawMaterial: { id: RM_ID, name: 'Carne', unit: 'KILOGRAM', currentStock: new Decimal(1), perishable: false, shelfLifeDays: null },
          batches: [
            {
              id: 'batch-existing',
              initialQuantity: new Decimal(4),
              remainingQuantity: new Decimal(1), // 3 already consumed by recipes/sales
              receivedDate: new Date('2026-05-10'),
              status: BatchStatus.ACTIVE,
              depletedAt: null,
            },
          ],
        }),
      )

      await expect(
        updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
          receiveStatus: PurchaseOrderItemStatus.DAMAGED,
        } as any),
      ).rejects.toThrow(/consumieron/i)

      expect(mockedPrisma.stockBatch.update).not.toHaveBeenCalled()
      expect(mockedPrisma.rawMaterial.update).not.toHaveBeenCalled()
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // PARTIAL ADJUSTMENTS + IDEMPOTENCY
  // ────────────────────────────────────────────────────────────────────────
  describe('Partial adjustments + idempotency', () => {
    it('reduces stock by the delta when RECEIVED(5) → RECEIVED(3)', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(
        makeItem({
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: new Decimal(5),
          rawMaterial: { id: RM_ID, name: 'Carne', unit: 'KILOGRAM', currentStock: new Decimal(5), perishable: false, shelfLifeDays: null },
          batches: [
            {
              id: 'batch-existing',
              initialQuantity: new Decimal(5),
              remainingQuantity: new Decimal(5),
              receivedDate: new Date('2026-05-10'),
              status: BatchStatus.ACTIVE,
              depletedAt: null,
            },
          ],
        }),
      )

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.RECEIVED,
        quantityReceived: 3,
      } as any)

      // Batch reduced by 2
      const updateData = mockedPrisma.stockBatch.update.mock.calls[0][0].data
      expect(updateData.remainingQuantity.toString()).toBe('3')
      expect(updateData.initialQuantity.toString()).toBe('3')
      expect(updateData.status).toBe(BatchStatus.ACTIVE) // not fully reversed

      // Stock down to 3
      const stockUpdate = mockedPrisma.rawMaterial.update.mock.calls[0][0]
      expect(stockUpdate.data.currentStock.toString()).toBe('3')

      // ADJUSTMENT or RETURN/SPOILAGE? Same status → ADJUSTMENT (we're still RECEIVED, just less)
      // Actually this is RECEIVED → RECEIVED with smaller qty: maps to ADJUSTMENT default
      const movement = mockedPrisma.rawMaterialMovement.create.mock.calls[0][0].data
      expect(movement.quantity.toString()).toBe('-2')
    })

    it('is idempotent — re-applying the same RECEIVED state with same qty is a no-op for inventory', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(
        makeItem({
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: new Decimal(4),
          rawMaterial: { id: RM_ID, name: 'Carne', unit: 'KILOGRAM', currentStock: new Decimal(4), perishable: false, shelfLifeDays: null },
          batches: [
            {
              id: 'batch-existing',
              initialQuantity: new Decimal(4),
              remainingQuantity: new Decimal(4),
              receivedDate: new Date('2026-05-10'),
              status: BatchStatus.ACTIVE,
              depletedAt: null,
            },
          ],
        }),
      )

      await updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
        receiveStatus: PurchaseOrderItemStatus.RECEIVED,
        quantityReceived: 4,
      } as any)

      // Item meta updated, but no inventory side effects
      expect(mockedPrisma.purchaseOrderItem.update).toHaveBeenCalled()
      expect(mockedPrisma.stockBatch.create).not.toHaveBeenCalled()
      expect(mockedPrisma.stockBatch.update).not.toHaveBeenCalled()
      expect(mockedPrisma.rawMaterial.update).not.toHaveBeenCalled()
      expect(mockedPrisma.rawMaterialMovement.create).not.toHaveBeenCalled()
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // REGRESSION: not-found errors still raise correctly
  // ────────────────────────────────────────────────────────────────────────
  describe('Validation regressions', () => {
    it('raises 404 when item does not belong to the PO/venue', async () => {
      mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(null)

      await expect(
        updatePurchaseOrderItemStatus(VENUE_ID, PO_ID, ITEM_ID, {
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: 1,
        } as any),
      ).rejects.toThrow(AppError)
    })
  })
})
