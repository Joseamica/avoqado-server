/**
 * orderActionCapture.test.ts
 *
 * Verifies that the 4 logAction dual-write calls added to order.tpv.service.ts
 * fire with the correct action/entity/venueId arguments.
 *
 * Coverage:
 *   - compItems  → ITEM_COMPED   (driven through success path)
 *   - voidItems  → ITEM_VOIDED   (driven through success path)
 *   - applyDiscount → DISCOUNT_APPLIED (driven through success path)
 *   - removeOrderItem → ITEM_REMOVED (driven through success path)
 *
 * Strategy: mock prisma locally (overrides the global prismaMock) so we can
 * control exactly what DB calls return, then assert logAction was called with
 * the right shape. logAction itself is already mocked by the global setup.ts
 * (jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))).
 */

import { logAction } from '@/services/dashboard/activity-log.service'
import { Decimal } from '@prisma/client/runtime/library'

// ── Local prisma mock (overrides the global one for this test file) ───────────
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    orderItem: {
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    orderAction: {
      create: jest.fn(),
    },
    orderDiscount: {
      findMany: jest.fn(),
    },
    orderServiceCharge: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    orderCustomer: {
      deleteMany: jest.fn(),
    },
    staff: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}))

// Other deps the service imports at module level
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: {
    getBroadcastingService: jest.fn().mockReturnValue(null),
  },
}))

jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  serializedInventoryService: {},
}))

jest.mock('@/services/serialized-inventory/simRegistration.service', () => ({
  simRegistrationService: {},
}))

jest.mock('@/services/modules/module.service', () => ({
  moduleService: {},
  MODULE_CODES: {},
}))

jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: jest.fn(),
  getProductInventoryMethod: jest.fn(),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────
import prisma from '@/utils/prismaClient'

const mockPrisma = prisma as any
const mockLogAction = logAction as jest.MockedFunction<typeof logAction>

/** A minimal order row (everything compItems/voidItems/etc. needs). */
function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'T-001',
    venueId: 'venue-1',
    paymentStatus: 'PENDING',
    status: 'OPEN',
    subtotal: new Decimal(100),
    total: new Decimal(100),
    discountAmount: new Decimal(0),
    paidAmount: new Decimal(0),
    remainingBalance: new Decimal(100),
    version: 1,
    tableId: null,
    items: [
      {
        id: 'item-1',
        productName: 'Burger',
        product: { name: 'Burger' },
        sentToKitchenAt: null,
        total: new Decimal(60),
      },
      {
        id: 'item-2',
        productName: 'Fries',
        product: { name: 'Fries' },
        sentToKitchenAt: null,
        total: new Decimal(40),
      },
    ],
    ...overrides,
  }
}

/** A minimal updatedOrder returned from prisma.order.update */
function makeUpdatedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'T-001',
    tableId: null,
    table: null,
    items: [],
    payments: [],
    createdBy: null,
    servedBy: null,
    subtotal: new Decimal(100),
    total: new Decimal(100),
    discountAmount: new Decimal(0),
    remainingBalance: new Decimal(100),
    version: 2,
    status: 'OPEN',
    paymentStatus: 'PENDING',
    ...overrides,
  }
}

const VENUE_ID = 'venue-1'
const ORDER_ID = 'order-1'
const STAFF_ID = 'staff-1'

// ── Import service (after all mocks are in place) ─────────────────────────────
import { compItems, voidItems, applyDiscount, removeOrderItem } from '@/services/tpv/order.tpv.service'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ActivityLog dual-write in order.tpv.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // orderAction.create is fire-and-forget in each function; resolve silently
    mockPrisma.orderAction.create.mockResolvedValue({})
    mockPrisma.orderDiscount.findMany.mockResolvedValue([])
    mockPrisma.orderServiceCharge.findMany.mockResolvedValue([])
    mockPrisma.orderCustomer.deleteMany.mockResolvedValue({ count: 0 })
    mockPrisma.staff.findUnique.mockResolvedValue({ id: STAFF_ID })
  })

  // ── compItems ──────────────────────────────────────────────────────────────

  describe('compItems → ITEM_COMPED', () => {
    it('fires logAction with action ITEM_COMPED after orderAction.create', async () => {
      const order = makeOrder()
      mockPrisma.order.findUnique.mockResolvedValue(order)
      mockPrisma.order.update.mockResolvedValue(makeUpdatedOrder())

      await compItems(VENUE_ID, ORDER_ID, {
        itemIds: ['item-1'],
        reason: 'Food quality issue',
        staffId: STAFF_ID,
      })

      // orderAction.create should still fire (unchanged)
      expect(mockPrisma.orderAction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ actionType: 'COMP' }) }),
      )

      // logAction dual-write
      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ITEM_COMPED',
          entity: 'Order',
          entityId: ORDER_ID,
          venueId: VENUE_ID,
          staffId: STAFF_ID,
          data: expect.objectContaining({ amount: 60, reason: 'Food quality issue' }),
        }),
      )
    })

    it('comp entire order (empty itemIds) still fires logAction', async () => {
      const order = makeOrder()
      mockPrisma.order.findUnique.mockResolvedValue(order)
      mockPrisma.order.update.mockResolvedValue(makeUpdatedOrder())

      await compItems(VENUE_ID, ORDER_ID, {
        itemIds: [], // comp entire order
        reason: 'Long wait',
        staffId: STAFF_ID,
      })

      expect(mockLogAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ITEM_COMPED', entity: 'Order', entityId: ORDER_ID }))
    })
  })

  // ── voidItems ──────────────────────────────────────────────────────────────

  describe('voidItems → ITEM_VOIDED', () => {
    it('fires logAction with action ITEM_VOIDED after orderAction.create', async () => {
      const order = makeOrder()
      mockPrisma.order.findUnique.mockResolvedValue(order)
      mockPrisma.orderItem.deleteMany.mockResolvedValue({ count: 1 })
      mockPrisma.order.update.mockResolvedValue(makeUpdatedOrder())

      await voidItems(VENUE_ID, ORDER_ID, {
        itemIds: ['item-1'],
        reason: 'Wrong item',
        staffId: STAFF_ID,
        expectedVersion: 1,
      })

      expect(mockPrisma.orderAction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ actionType: 'VOID' }) }),
      )

      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ITEM_VOIDED',
          entity: 'Order',
          entityId: ORDER_ID,
          venueId: VENUE_ID,
          staffId: STAFF_ID,
          data: expect.objectContaining({ amount: 60, reason: 'Wrong item' }),
        }),
      )
    })
  })

  // ── applyDiscount ──────────────────────────────────────────────────────────

  describe('applyDiscount → DISCOUNT_APPLIED', () => {
    it('fires logAction with action DISCOUNT_APPLIED after orderAction.create', async () => {
      const order = makeOrder()
      mockPrisma.order.findUnique.mockResolvedValue(order)
      mockPrisma.order.update.mockResolvedValue(makeUpdatedOrder({ discountAmount: new Decimal(10) }))

      await applyDiscount(VENUE_ID, ORDER_ID, {
        type: 'FIXED_AMOUNT',
        value: 10,
        reason: 'Promo code',
        staffId: STAFF_ID,
        expectedVersion: 1,
      })

      expect(mockPrisma.orderAction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ actionType: 'DISCOUNT' }) }),
      )

      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DISCOUNT_APPLIED',
          entity: 'Order',
          entityId: ORDER_ID,
          venueId: VENUE_ID,
          staffId: STAFF_ID,
          data: expect.objectContaining({ amount: 10, reason: 'Promo code' }),
        }),
      )
    })
  })

  // ── removeOrderItem ────────────────────────────────────────────────────────

  describe('removeOrderItem → ITEM_REMOVED', () => {
    it('fires logAction with action ITEM_REMOVED (no staffId in function signature)', async () => {
      const order = makeOrder()
      mockPrisma.order.findUnique.mockResolvedValue(order)
      mockPrisma.orderItem.delete.mockResolvedValue({})
      mockPrisma.order.update.mockResolvedValue(makeUpdatedOrder({ subtotal: new Decimal(40), total: new Decimal(40) }))

      await removeOrderItem(VENUE_ID, ORDER_ID, 'item-1', /* expectedVersion */ 1)

      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ITEM_REMOVED',
          entity: 'Order',
          entityId: ORDER_ID,
          venueId: VENUE_ID,
          staffId: null, // no staffId param in removeOrderItem
          data: expect.objectContaining({ itemId: 'item-1', amount: 60 }),
        }),
      )
    })

    it('does NOT fire logAction when item is not found', async () => {
      const order = makeOrder()
      mockPrisma.order.findUnique.mockResolvedValue(order)

      await expect(removeOrderItem(VENUE_ID, ORDER_ID, 'item-MISSING', 1)).rejects.toThrow()
      expect(mockLogAction).not.toHaveBeenCalled()
    })
  })
})
