/**
 * ActivityLog de los descuentos del catálogo: DISCOUNT_APPLIED y DISCOUNT_REMOVED.
 * El payload real de REFUND_CREATED se prueba en refund.turnoDelNegocio.test.ts.
 */

import { applyDiscountToOrder, removeDiscountFromOrder } from '../../../../src/services/dashboard/discountEngine.service'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import { prismaMock } from '../../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'
import { DiscountType } from '@prisma/client'

// logAction is mocked globally by tests/__helpers__/setup.ts
const mockLogAction = logAction as jest.Mock

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeDiscount(overrides: Record<string, unknown> = {}) {
  return {
    discountId: 'discount-abc',
    name: 'Happy Hour',
    type: 'PERCENTAGE' as DiscountType,
    value: 10,
    amount: 15,
    taxReduction: 2.4,
    applicableItems: ['item-1'],
    isAutomatic: true,
    requiresApproval: false,
    ...overrides,
  }
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-xyz',
    venueId: 'venue-42',
    customerId: null,
    subtotal: new Decimal(150),
    taxAmount: new Decimal(24),
    discountAmount: new Decimal(0),
    tipAmount: new Decimal(0),
    total: new Decimal(174),
    paidAmount: new Decimal(0),
    items: [],
    orderDiscounts: [],
    ...overrides,
  }
}

/** The catalog rule `makeDiscount()` was calculated from: the writer re-evaluates it under the Order lock. */
function makeCatalogRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'discount-abc',
    venueId: 'venue-42',
    name: 'Happy Hour',
    type: 'PERCENTAGE' as DiscountType,
    value: new Decimal(10),
    scope: 'ORDER',
    targetItemIds: [],
    targetCategoryIds: [],
    targetModifierIds: [],
    targetModifierGroupIds: [],
    customerGroupId: null,
    isAutomatic: true,
    priority: 0,
    minPurchaseAmount: null,
    maxDiscountAmount: null,
    minQuantity: null,
    buyQuantity: null,
    getQuantity: null,
    getDiscountPercent: null,
    buyItemIds: [],
    getItemIds: [],
    validFrom: null,
    validUntil: null,
    daysOfWeek: [],
    timeFrom: null,
    timeUntil: null,
    maxTotalUses: null,
    maxUsesPerCustomer: null,
    currentUses: 0,
    isStackable: false,
    stackPriority: 0,
    requiresApproval: false,
    applyBeforeTax: true,
    active: true,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// discountEngine.applyDiscountToOrder → DISCOUNT_APPLIED
// ─────────────────────────────────────────────────────────────────────────────

describe('discountEngine.applyDiscountToOrder — audit capture', () => {
  beforeEach(() => {
    // Make $transaction synchronously call the callback (mirrors global setup)
    prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof prismaMock) => Promise<unknown>) => cb(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'order-xyz' }]) // canonical Order lock row
    prismaMock.discount.findMany.mockResolvedValue([makeCatalogRule()])
    prismaMock.order.findUnique.mockResolvedValue(makeOrder())
    prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-new' })
    prismaMock.order.update.mockResolvedValue(makeOrder())
    prismaMock.discount.update.mockResolvedValue({})
    // Los caminos de descuento ahora recalculan los cargos por servicio: sin filas, 0.
    prismaMock.orderServiceCharge.findMany.mockResolvedValue([])
  })

  it('fires DISCOUNT_APPLIED with correct fields on successful apply', async () => {
    const discount = makeDiscount()
    const result = await applyDiscountToOrder('order-xyz', discount, 'staff-11', 'manager-22')

    expect(result.success).toBe(true)

    // Verify logAction was called
    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff-11',
        venueId: 'venue-42',
        action: 'DISCOUNT_APPLIED',
        entity: 'Order',
        entityId: 'order-xyz',
        data: expect.objectContaining({
          discountId: 'discount-abc',
          amount: 15,
          source: 'catalog',
        }),
      }),
    )
  })

  it('falls back to authorizedById when appliedById is undefined', async () => {
    const discount = makeDiscount()
    await applyDiscountToOrder('order-xyz', discount, undefined, 'manager-99')

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'manager-99',
        action: 'DISCOUNT_APPLIED',
      }),
    )
  })

  it('uses null staffId when neither appliedById nor authorizedById is provided', async () => {
    const discount = makeDiscount()
    await applyDiscountToOrder('order-xyz', discount)

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: null,
        action: 'DISCOUNT_APPLIED',
      }),
    )
  })

  it('does NOT fire logAction when discount is already applied', async () => {
    // Order already has the same discount
    prismaMock.order.findUnique.mockResolvedValue(makeOrder({ orderDiscounts: [{ discountId: 'discount-abc' }] }))

    const discount = makeDiscount()
    const result = await applyDiscountToOrder('order-xyz', discount)

    expect(result.success).toBe(false)
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('does NOT fire logAction when approval is required but not provided', async () => {
    prismaMock.order.findUnique.mockResolvedValue(makeOrder())
    prismaMock.discount.findMany.mockResolvedValue([makeCatalogRule({ requiresApproval: true })])

    const discount = makeDiscount({ requiresApproval: true })
    const result = await applyDiscountToOrder('order-xyz', discount, 'staff-11') // no authorizedById

    expect(result.success).toBe(false)
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('does NOT fire logAction when order is not found', async () => {
    prismaMock.order.findUnique.mockResolvedValue(null)

    const discount = makeDiscount()
    const result = await applyDiscountToOrder('order-xyz', discount)

    expect(result.success).toBe(false)
    expect(mockLogAction).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// discountEngine.removeDiscountFromOrder → DISCOUNT_REMOVED
// ─────────────────────────────────────────────────────────────────────────────

describe('discountEngine.removeDiscountFromOrder — audit capture', () => {
  const mockOrderDiscount = {
    id: 'od-111',
    orderId: 'order-xyz',
    discountId: 'discount-abc',
    amount: new Decimal(15),
    taxReduction: new Decimal(2.4),
    name: 'Happy Hour',
  }

  beforeEach(() => {
    prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof prismaMock) => Promise<unknown>) => cb(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'order-xyz' }]) // canonical Order lock row
    prismaMock.orderDiscount.findFirst.mockResolvedValue(mockOrderDiscount)
    prismaMock.order.findUnique.mockResolvedValue(makeOrder({ discountAmount: new Decimal(15), taxAmount: new Decimal(21.6) }))
    prismaMock.orderDiscount.delete.mockResolvedValue(mockOrderDiscount)
    prismaMock.order.update.mockResolvedValue(makeOrder())
    prismaMock.discount.update.mockResolvedValue({})
  })

  it('fires DISCOUNT_REMOVED with correct fields on successful removal', async () => {
    const result = await removeDiscountFromOrder('order-xyz', 'od-111')

    expect(result.success).toBe(true)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: null,
        venueId: 'venue-42',
        action: 'DISCOUNT_REMOVED',
        entity: 'Order',
        entityId: 'order-xyz',
        data: expect.objectContaining({
          discountId: 'discount-abc',
        }),
      }),
    )
  })

  it('does NOT fire logAction when orderDiscount is not found', async () => {
    prismaMock.orderDiscount.findFirst.mockResolvedValue(null)

    const result = await removeDiscountFromOrder('order-xyz', 'nonexistent')

    expect(result.success).toBe(false)
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('does NOT fire logAction when order is not found', async () => {
    prismaMock.order.findUnique.mockResolvedValue(null)

    const result = await removeDiscountFromOrder('order-xyz', 'od-111')

    expect(result.success).toBe(false)
    expect(mockLogAction).not.toHaveBeenCalled()
  })
})
