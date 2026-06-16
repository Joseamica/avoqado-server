/**
 * Unit tests — per-item PO receive audit capture.
 *
 * Verifies that applyItemReceiveStatusInTx writes a
 * PURCHASE_ORDER_ITEM_RECEIVED ActivityLog entry (via logAction) after
 * updating each item's receiveStatus, including the condition (status),
 * actor, PO id, item id, and rawMaterial id.
 *
 * Single-item (updatePurchaseOrderItemStatus) and bulk
 * (receiveAllItems) both route through applyItemReceiveStatusInTx,
 * so this single insertion covers both flows.
 */

import { logAction } from '@/services/dashboard/activity-log.service'

// Must mock prisma before importing the service so the module picks up the mock
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

// Resend service is imported transitively — stub it to avoid env-key errors
jest.mock('@/services/resend.service', () => ({
  sendPurchaseOrderEmail: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { applyItemReceiveStatusInTx } from '@/services/dashboard/purchaseOrder.service'
import { Decimal } from '@prisma/client/runtime/library'
import { PurchaseOrderItemStatus } from '@prisma/client'

const mockedPrisma = prisma as unknown as {
  purchaseOrderItem: { findFirst: jest.Mock; update: jest.Mock }
  purchaseOrder: { findUnique: jest.Mock; update: jest.Mock }
  rawMaterial: { update: jest.Mock }
  stockBatch: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock }
  rawMaterialMovement: { create: jest.Mock }
  $transaction: jest.Mock
}

const mockLogAction = logAction as jest.Mock

// ─── Constants ──────────────────────────────────────────────────────────────

const VENUE_ID = 'venue-po-test'
const PO_ID = 'po-item-audit-001'
const ITEM_ID = 'poi-audit-001'
const RM_ID = 'rm-audit-001'
const STAFF_ID = 'staff-audit-001'

// ─── Helpers ────────────────────────────────────────────────────────────────

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
      name: 'Tomate',
      unit: 'KILOGRAM',
      currentStock: new Decimal(0),
      perishable: false,
      shelfLifeDays: null,
    },
    batches: [],
    purchaseOrder: { id: PO_ID, orderNumber: 'PO-AUDIT-001' },
    ...overrides,
  }
}

/**
 * Build a transaction-client proxy that re-uses the top-level mocks.
 * This mirrors the pattern used in purchaseOrderItemStatus.service.test.ts.
 */
function makeTxProxy() {
  return {
    purchaseOrderItem: mockedPrisma.purchaseOrderItem,
    purchaseOrder: mockedPrisma.purchaseOrder,
    rawMaterial: mockedPrisma.rawMaterial,
    stockBatch: mockedPrisma.stockBatch,
    rawMaterialMovement: mockedPrisma.rawMaterialMovement,
  }
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()

  // purchaseOrderItem.update always succeeds (metadata write)
  mockedPrisma.purchaseOrderItem.update.mockResolvedValue({})

  // rawMaterial.update always succeeds (stock sync)
  mockedPrisma.rawMaterial.update.mockResolvedValue({})

  // rawMaterialMovement.create always succeeds
  mockedPrisma.rawMaterialMovement.create.mockResolvedValue({ id: 'mov-new' })

  // stockBatch.create always succeeds
  mockedPrisma.stockBatch.create.mockResolvedValue({
    id: 'batch-new',
    batchNumber: 'B-001',
    costPerUnit: new Decimal(5),
  })

  // stockBatch.update for reversal paths
  mockedPrisma.stockBatch.update.mockResolvedValue({})
})

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('applyItemReceiveStatusInTx — PURCHASE_ORDER_ITEM_RECEIVED audit capture', () => {
  // ── NEW FEATURE TESTS ──────────────────────────────────────────────────────

  it('fires logAction with PURCHASE_ORDER_ITEM_RECEIVED when item is marked DAMAGED', async () => {
    // Item with stock to reverse: currentStock 5, one ACTIVE batch with 5 units
    const item = makeItem({
      receiveStatus: PurchaseOrderItemStatus.RECEIVED,
      quantityReceived: new Decimal(5),
      rawMaterial: {
        id: RM_ID,
        name: 'Tomate',
        unit: 'KILOGRAM',
        currentStock: new Decimal(5),
        perishable: false,
        shelfLifeDays: null,
      },
      batches: [
        {
          id: 'batch-existing',
          status: 'ACTIVE',
          initialQuantity: new Decimal(5),
          remainingQuantity: new Decimal(5),
          receivedDate: new Date('2026-01-01'),
          depletedAt: null,
        },
      ],
    })

    mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(item)

    const tx = makeTxProxy()
    await applyItemReceiveStatusInTx(tx as any, VENUE_ID, PO_ID, ITEM_ID, { receiveStatus: PurchaseOrderItemStatus.DAMAGED }, STAFF_ID)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PURCHASE_ORDER_ITEM_RECEIVED',
        entity: 'PurchaseOrder',
        entityId: PO_ID,
        staffId: STAFF_ID,
        venueId: VENUE_ID,
        data: expect.objectContaining({
          purchaseOrderItemId: ITEM_ID,
          rawMaterialId: RM_ID,
          status: PurchaseOrderItemStatus.DAMAGED,
        }),
      }),
    )
  })

  it('fires logAction when item is marked RECEIVED with a quantity', async () => {
    const item = makeItem()
    mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(item)

    const tx = makeTxProxy()
    await applyItemReceiveStatusInTx(
      tx as any,
      VENUE_ID,
      PO_ID,
      ITEM_ID,
      { receiveStatus: PurchaseOrderItemStatus.RECEIVED, quantityReceived: 8 },
      STAFF_ID,
    )

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PURCHASE_ORDER_ITEM_RECEIVED',
        venueId: VENUE_ID,
        entityId: PO_ID,
        staffId: STAFF_ID,
        data: expect.objectContaining({
          status: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: 8,
          rawMaterialId: RM_ID,
          purchaseOrderItemId: ITEM_ID,
        }),
      }),
    )
  })

  it('fires logAction when item is marked NOT_PROCESSED (zero-delta path)', async () => {
    // Zero-delta: item was PENDING (no stock), marking NOT_PROCESSED → no stock change
    const item = makeItem()
    mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(item)

    const tx = makeTxProxy()
    await applyItemReceiveStatusInTx(
      tx as any,
      VENUE_ID,
      PO_ID,
      ITEM_ID,
      { receiveStatus: PurchaseOrderItemStatus.NOT_PROCESSED },
      STAFF_ID,
    )

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PURCHASE_ORDER_ITEM_RECEIVED',
        data: expect.objectContaining({
          status: PurchaseOrderItemStatus.NOT_PROCESSED,
        }),
      }),
    )
  })

  it('uses null staffId when no actor is provided', async () => {
    const item = makeItem()
    mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(item)

    const tx = makeTxProxy()
    await applyItemReceiveStatusInTx(
      tx as any,
      VENUE_ID,
      PO_ID,
      ITEM_ID,
      { receiveStatus: PurchaseOrderItemStatus.RECEIVED, quantityReceived: 5 },
      // no staffId
    )

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: null,
      }),
    )
  })

  // ── REGRESSION TESTS ───────────────────────────────────────────────────────

  it('does NOT call logAction when item is not found (AppError thrown)', async () => {
    mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(null)

    const tx = makeTxProxy()
    await expect(
      applyItemReceiveStatusInTx(
        tx as any,
        VENUE_ID,
        PO_ID,
        'nonexistent-item',
        { receiveStatus: PurchaseOrderItemStatus.RECEIVED, quantityReceived: 5 },
        STAFF_ID,
      ),
    ).rejects.toThrow()

    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('still writes purchaseOrderItem.update before firing logAction', async () => {
    const item = makeItem()
    mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(item)

    const callOrder: string[] = []
    mockedPrisma.purchaseOrderItem.update.mockImplementation(async () => {
      callOrder.push('update')
      return {}
    })
    mockLogAction.mockImplementation(async () => {
      callOrder.push('logAction')
    })

    const tx = makeTxProxy()
    await applyItemReceiveStatusInTx(
      tx as any,
      VENUE_ID,
      PO_ID,
      ITEM_ID,
      { receiveStatus: PurchaseOrderItemStatus.NOT_PROCESSED },
      STAFF_ID,
    )

    expect(callOrder).toEqual(['update', 'logAction'])
  })
})
