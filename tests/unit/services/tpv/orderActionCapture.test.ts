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
// compItems wraps its writes in prisma.$transaction (open finding #1 fix) — the
// mock below invokes the transaction callback with THIS SAME mock object, so
// `tx.orderItem.update` / `tx.order.update` / `tx.orderAction.create` resolve
// through the exact jest.fn()s the tests assert against.
jest.mock('@/utils/prismaClient', () => {
  const mockPrismaObj: any = {
    order: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    orderItem: {
      delete: jest.fn(),
      deleteMany: jest.fn(),
      update: jest.fn(),
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
  }
  mockPrismaObj.$transaction = jest.fn((callback: any) => callback(mockPrismaObj))
  return { __esModule: true, default: mockPrismaObj }
})

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
    mockPrisma.orderItem.update.mockResolvedValue({})
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

  // ── compItems marks the OrderItem rows (open finding #1) ─────────────────────
  //
  // Before this fix, compItems only updated Order.discountAmount/total — the
  // OrderItem rows were never touched, so a comped dish kept rendering as
  // charged on the itemized check / printed ticket / line-level reports.
  //
  // Convention followed (docs/TPV_COBRAR_STRUCTURED_DISCOUNTS.md): OrderItem.total
  // stays GROSS (never zeroed — that breaks gross sales reporting); the
  // reduction lives in OrderItem.discountAmount, with isCortesia=true. This
  // mirrors exactly how createOrderWithItems already persists a cortesía line.
  describe('compItems marks comped OrderItem rows (open finding #1)', () => {
    it('marks the comped item: isCortesia=true, cortesiaReason=reason, discountAmount=item.total — total left untouched (stays gross)', async () => {
      const order = makeOrder()
      mockPrisma.order.findUnique.mockResolvedValue(order)
      mockPrisma.order.update.mockResolvedValue(makeUpdatedOrder())

      await compItems(VENUE_ID, ORDER_ID, {
        itemIds: ['item-1'],
        reason: 'Food quality issue',
        staffId: STAFF_ID,
      })

      expect(mockPrisma.orderItem.update).toHaveBeenCalledTimes(1)
      expect(mockPrisma.orderItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: {
          isCortesia: true,
          cortesiaReason: 'Food quality issue',
          discountAmount: order.items[0].total, // full line total, gross unchanged
        },
      })
      // OrderItem.total must NOT appear in the update payload — zeroing it
      // would break sum(item.total) === Order.subtotal.
      const call = mockPrisma.orderItem.update.mock.calls[0][0]
      expect(call.data).not.toHaveProperty('total')
    })

    it('comps the entire order (empty itemIds): marks EVERY item, not just one', async () => {
      const order = makeOrder()
      mockPrisma.order.findUnique.mockResolvedValue(order)
      mockPrisma.order.update.mockResolvedValue(makeUpdatedOrder())

      await compItems(VENUE_ID, ORDER_ID, {
        itemIds: [],
        reason: 'Long wait',
        staffId: STAFF_ID,
      })

      expect(mockPrisma.orderItem.update).toHaveBeenCalledTimes(order.items.length)
      expect(mockPrisma.orderItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { isCortesia: true, cortesiaReason: 'Long wait', discountAmount: order.items[0].total },
      })
      expect(mockPrisma.orderItem.update).toHaveBeenCalledWith({
        where: { id: 'item-2' },
        data: { isCortesia: true, cortesiaReason: 'Long wait', discountAmount: order.items[1].total },
      })
    })

    it('does NOT mark items outside the requested itemIds', async () => {
      const order = makeOrder()
      mockPrisma.order.findUnique.mockResolvedValue(order)
      mockPrisma.order.update.mockResolvedValue(makeUpdatedOrder())

      await compItems(VENUE_ID, ORDER_ID, { itemIds: ['item-1'], reason: 'Food quality issue', staffId: STAFF_ID })

      expect(mockPrisma.orderItem.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'item-2' } }))
    })

    it('order total math still correct: Order.discountAmount/total updated by the same compAmount as before', async () => {
      const order = makeOrder()
      mockPrisma.order.findUnique.mockResolvedValue(order)
      mockPrisma.order.update.mockResolvedValue(makeUpdatedOrder())

      await compItems(VENUE_ID, ORDER_ID, { itemIds: ['item-1'], reason: 'Food quality issue', staffId: STAFF_ID })

      // item-1.total = 60; order.discountAmount 0 -> 60; order.total 100 -> 40
      expect(mockPrisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ORDER_ID },
          data: expect.objectContaining({ discountAmount: 60, total: 40 }),
        }),
      )
    })

    it('wraps item updates, the order update, and OrderAction creation in a single prisma.$transaction', async () => {
      const order = makeOrder()
      mockPrisma.order.findUnique.mockResolvedValue(order)
      mockPrisma.order.update.mockResolvedValue(makeUpdatedOrder())

      await compItems(VENUE_ID, ORDER_ID, { itemIds: ['item-1'], reason: 'Food quality issue', staffId: STAFF_ID })

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    })
  })

  // ── compItems: whole-order comp on an order that ALREADY has a discount ─────
  //
  // Reproduced on hardware (order cmsetvfft0001c9jxv33p26gl): subtotal $253.00,
  // an existing $25.30 discount already applied, then "cortesía toda la
  // cuenta" (itemIds: []). compAmount is the comped items' GROSS total (253),
  // and the old code did `order.discountAmount + compAmount` unclamped, so the
  // pre-existing discount got double-counted on top of the 100% comp:
  // discountAmount ended at $278.30 (> subtotal) and total at -$25.30 — a
  // negative sale rendered on the terminal as "$-25.30". remainingBalance was
  // already clamped so nobody was undercharged, but the stored money fields —
  // and every report reading them — were corrupted.
  //
  // Fix: a whole-order comp means the guest owes nothing, full stop, regardless
  // of what was already discounted — discountAmount must never exceed
  // subtotal, total must never go negative.
  describe('compItems: whole-order comp never drives discountAmount above subtotal or total below zero', () => {
    it('comping the entire order clamps discountAmount to subtotal and total to 0, even with a pre-existing discount', async () => {
      const order = makeOrder({
        subtotal: new Decimal(253.0),
        total: new Decimal(227.7), // 253.00 - 25.30 (already discounted before the comp)
        discountAmount: new Decimal(25.3), // pre-existing discount, NOT related to the comp
        items: [
          { id: 'item-1', productName: 'Whole check', product: { name: 'Whole check' }, sentToKitchenAt: null, total: new Decimal(253.0) },
        ],
      })
      mockPrisma.order.findUnique.mockResolvedValue(order)
      mockPrisma.order.update.mockResolvedValue(makeUpdatedOrder())

      await compItems(VENUE_ID, ORDER_ID, { itemIds: [], reason: 'Cortesía toda la cuenta', staffId: STAFF_ID })

      const call = mockPrisma.order.update.mock.calls[0][0]
      // 🔴 The money assertions that a false-green sabotage test skipped before:
      // without them, `{ discountAmount: 278.3, total: -25.3 }` would also pass.
      expect(call.data.discountAmount).toBe(253) // clamped to subtotal, NOT 278.3
      expect(call.data.total).toBe(0) // clamped to 0, NOT -25.3
      expect(call.data.discountAmount).toBeLessThanOrEqual(253)
      expect(call.data.total).toBeGreaterThanOrEqual(0)
    })

    it('regression: comping a SUBSET of items on a discounted order still adds normally when it does not exceed subtotal', async () => {
      // Sanity check the clamp doesn't change the ordinary (non-overflow) case:
      // subtotal 100, existing discount 10, comp item worth 30 → 10+30=40 ≤ 100.
      const order = makeOrder({
        subtotal: new Decimal(100),
        total: new Decimal(90),
        discountAmount: new Decimal(10),
      })
      mockPrisma.order.findUnique.mockResolvedValue(order)
      mockPrisma.order.update.mockResolvedValue(makeUpdatedOrder())

      await compItems(VENUE_ID, ORDER_ID, { itemIds: ['item-1'], reason: 'Food quality issue', staffId: STAFF_ID })

      // item-1.total = 60; discountAmount 10 -> 70; total 100 -> 30 (unclamped math, unaffected by the fix)
      expect(mockPrisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ discountAmount: 70, total: 30 }) }),
      )
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
