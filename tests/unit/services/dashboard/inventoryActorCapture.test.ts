/**
 * inventoryActorCapture — verify that audit-worthy mutations carry the actor (staffId)
 *
 * Tests the 4 logAction sites that previously had no actor:
 *  1. createStockBatch  → STOCK_BATCH_CREATED
 *  2. quarantineBatch   → STOCK_BATCH_QUARANTINED
 *  3. deleteSupplier    → SUPPLIER_DELETED
 *  4. cancelPurchaseOrder → PURCHASE_ORDER_CANCELLED
 */

import prisma from '@/utils/prismaClient'
import { createStockBatch, quarantineBatch } from '@/services/dashboard/fifoBatch.service'
import { deleteSupplier } from '@/services/dashboard/supplier.service'
import { cancelPurchaseOrder } from '@/services/dashboard/purchaseOrder.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { Decimal } from '@prisma/client/runtime/library'
import { BatchStatus, RawMaterialMovementType, PurchaseOrderStatus, Unit } from '@prisma/client'

// Mock prisma — scoped (not relying on the global setup mock, which doesn't have all models)
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    stockBatch: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    rawMaterial: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    rawMaterialMovement: { create: jest.fn() },
    supplier: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    purchaseOrder: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    activityLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

// The global setup already mocks this, but since we're also calling jest.mock here
// we need to make sure it's consistent.
jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const mockedPrisma = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock }
const mockedLogAction = logAction as jest.Mock

const VENUE_ID = 'venue-test-1'
const STAFF_ID = 'staff-actor-abc'

beforeEach(() => {
  jest.clearAllMocks()
})

// ---------------------------------------------------------------------------
// 1. createStockBatch — STOCK_BATCH_CREATED
// ---------------------------------------------------------------------------
describe('createStockBatch — actor captured in STOCK_BATCH_CREATED', () => {
  const RM_ID = 'rm-test-1'
  const BATCH_ID = 'batch-test-1'

  function makeRawMaterial() {
    return {
      id: RM_ID,
      venueId: VENUE_ID,
      name: 'Harina',
      unit: Unit.GRAM,
      currentStock: new Decimal(500),
      costPerUnit: new Decimal(0.01),
    }
  }

  function makeCreatedBatch() {
    return {
      id: BATCH_ID,
      batchNumber: '20260615-001',
      venueId: VENUE_ID,
      rawMaterialId: RM_ID,
      initialQuantity: new Decimal(1000),
      remainingQuantity: new Decimal(1000),
      unit: Unit.GRAM,
      costPerUnit: new Decimal(0.01),
      status: BatchStatus.ACTIVE,
      receivedDate: new Date(),
      rawMaterial: makeRawMaterial(),
      purchaseOrderItem: null,
    }
  }

  it('passes staffId to logAction when provided', async () => {
    mockedPrisma.rawMaterial.findFirst.mockResolvedValue(makeRawMaterial())
    // Simulate no prior batch (so generateBatchNumber picks -001)
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(null)
    mockedPrisma.stockBatch.create.mockResolvedValue(makeCreatedBatch())

    await createStockBatch(
      VENUE_ID,
      RM_ID,
      {
        quantity: 1000,
        unit: Unit.GRAM,
        costPerUnit: 0.01,
        receivedDate: new Date(),
      },
      STAFF_ID,
    )

    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: STAFF_ID,
        venueId: VENUE_ID,
        action: 'STOCK_BATCH_CREATED',
      }),
    )
  })

  it('passes staffId: undefined when caller has no actor (system path)', async () => {
    mockedPrisma.rawMaterial.findFirst.mockResolvedValue(makeRawMaterial())
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(null)
    mockedPrisma.stockBatch.create.mockResolvedValue(makeCreatedBatch())

    // Call WITHOUT staffId (system / cron path)
    await createStockBatch(VENUE_ID, RM_ID, {
      quantity: 500,
      unit: Unit.GRAM,
      costPerUnit: 0.01,
      receivedDate: new Date(),
    })

    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    const call = mockedLogAction.mock.calls[0][0]
    // staffId must be undefined (not a fabricated value)
    expect(call.staffId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. quarantineBatch — STOCK_BATCH_QUARANTINED
// ---------------------------------------------------------------------------
describe('quarantineBatch — actor captured in STOCK_BATCH_QUARANTINED', () => {
  const BATCH_ID = 'batch-q-1'
  const RM_ID = 'rm-q-1'

  function makeBatch() {
    return {
      id: BATCH_ID,
      venueId: VENUE_ID,
      rawMaterialId: RM_ID,
      batchNumber: 'BATCH-Q-001',
      status: BatchStatus.ACTIVE,
      remainingQuantity: new Decimal(200),
      unit: Unit.GRAM,
      costPerUnit: new Decimal(0.01),
      receivedDate: new Date(),
    }
  }

  function wireTransaction() {
    mockedPrisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => {
      const tx = {
        stockBatch: {
          update: jest.fn().mockResolvedValue({
            ...makeBatch(),
            status: BatchStatus.QUARANTINED,
            rawMaterial: {
              id: RM_ID,
              name: 'Sal',
              currentStock: new Decimal(500),
            },
          }),
          findUnique: jest.fn().mockResolvedValue({ remainingQuantity: new Decimal(200) }),
        },
        rawMaterial: { update: jest.fn().mockResolvedValue({}) },
        rawMaterialMovement: { create: jest.fn().mockResolvedValue({}) },
      }
      return cb(tx)
    })
  }

  it('passes staffId to logAction when provided', async () => {
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(makeBatch())
    wireTransaction()

    await quarantineBatch(VENUE_ID, BATCH_ID, 'damaged goods', STAFF_ID)

    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: STAFF_ID,
        venueId: VENUE_ID,
        action: 'STOCK_BATCH_QUARANTINED',
      }),
    )
  })

  it('passes staffId: undefined when no actor provided', async () => {
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(makeBatch())
    wireTransaction()

    await quarantineBatch(VENUE_ID, BATCH_ID, 'expired')

    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    const call = mockedLogAction.mock.calls[0][0]
    expect(call.staffId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. deleteSupplier — SUPPLIER_DELETED
// ---------------------------------------------------------------------------
describe('deleteSupplier — actor captured in SUPPLIER_DELETED', () => {
  const SUPPLIER_ID = 'sup-test-1'

  function makeSupplier() {
    return {
      id: SUPPLIER_ID,
      venueId: VENUE_ID,
      name: 'Proveedor Uno',
      deletedAt: null,
      purchaseOrders: [], // no orders → delete allowed
    }
  }

  it('passes staffId to logAction when provided', async () => {
    mockedPrisma.supplier.findFirst.mockResolvedValue(makeSupplier())
    mockedPrisma.supplier.update.mockResolvedValue({})

    await deleteSupplier(VENUE_ID, SUPPLIER_ID, STAFF_ID)

    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: STAFF_ID,
        venueId: VENUE_ID,
        action: 'SUPPLIER_DELETED',
      }),
    )
  })

  it('passes staffId: undefined when no actor provided', async () => {
    mockedPrisma.supplier.findFirst.mockResolvedValue(makeSupplier())
    mockedPrisma.supplier.update.mockResolvedValue({})

    await deleteSupplier(VENUE_ID, SUPPLIER_ID)

    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    const call = mockedLogAction.mock.calls[0][0]
    expect(call.staffId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. cancelPurchaseOrder — PURCHASE_ORDER_CANCELLED
// ---------------------------------------------------------------------------
describe('cancelPurchaseOrder — actor captured in PURCHASE_ORDER_CANCELLED', () => {
  const PO_ID = 'po-test-1'

  function makePurchaseOrder() {
    return {
      id: PO_ID,
      venueId: VENUE_ID,
      orderNumber: 'PO-2026-001',
      status: PurchaseOrderStatus.CONFIRMED,
      notes: null,
    }
  }

  function makeUpdatedOrder() {
    return {
      ...makePurchaseOrder(),
      status: PurchaseOrderStatus.CANCELLED,
      supplier: { id: 'sup-1', name: 'Proveedor' },
      items: [],
    }
  }

  it('passes staffId to logAction when provided', async () => {
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue(makePurchaseOrder())
    mockedPrisma.purchaseOrder.update.mockResolvedValue(makeUpdatedOrder())

    await cancelPurchaseOrder(VENUE_ID, PO_ID, 'wrong items', STAFF_ID)

    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: STAFF_ID,
        venueId: VENUE_ID,
        action: 'PURCHASE_ORDER_CANCELLED',
      }),
    )
  })

  it('passes staffId: undefined when no actor provided', async () => {
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue(makePurchaseOrder())
    mockedPrisma.purchaseOrder.update.mockResolvedValue(makeUpdatedOrder())

    await cancelPurchaseOrder(VENUE_ID, PO_ID, 'budget cut')

    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    const call = mockedLogAction.mock.calls[0][0]
    expect(call.staffId).toBeUndefined()
  })
})
