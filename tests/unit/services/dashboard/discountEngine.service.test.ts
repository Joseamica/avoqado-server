import {
  getEligibleDiscounts,
  getCustomerDiscounts,
  calculateDiscountAmount,
  evaluateAutomaticDiscounts,
  applyDiscountToOrder,
  removeDiscountFromOrder,
  applyManualDiscount,
  getOrderDiscountsSummary,
} from '../../../../src/services/dashboard/discountEngine.service'
import { prismaMock } from '../../../__helpers__/setup'
import { NotFoundError } from '../../../../src/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'
import { DiscountType, DiscountScope } from '@prisma/client'

// Helper to create mock discount for engine
const createMockEngineDiscount = (overrides: Record<string, any> = {}) => ({
  id: 'discount-123',
  name: 'Test Discount',
  type: 'PERCENTAGE' as DiscountType,
  value: 10,
  scope: 'ORDER' as DiscountScope,
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
  ...overrides,
})

// Helper to create order context
const createMockOrderContext = (overrides: Record<string, any> = {}) => ({
  orderId: 'order-123',
  venueId: 'venue-123',
  customerId: undefined,
  subtotal: 100,
  items: [
    {
      id: 'item-1',
      productId: 'product-1',
      categoryId: 'category-1',
      quantity: 2,
      unitPrice: 25,
      total: 50,
      modifiers: [],
    },
    {
      id: 'item-2',
      productId: 'product-2',
      categoryId: 'category-2',
      quantity: 1,
      unitPrice: 50,
      total: 50,
      modifiers: [],
    },
  ],
  appliedDiscounts: [],
  ...overrides,
})

// Helper to create mock database discount
const createMockDbDiscount = (overrides: Record<string, any> = {}) => ({
  id: 'discount-123',
  venueId: 'venue-123',
  name: 'Test Discount',
  description: null,
  type: 'PERCENTAGE' as const,
  value: new Decimal(10),
  scope: 'ORDER' as const,
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
  requiresApproval: false,
  compReason: null,
  applyBeforeTax: true,
  modifyTaxBasis: true,
  isStackable: false,
  stackPriority: 0,
  active: true,
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

describe('Discount Engine Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ==========================================
  // DISCOUNT ELIGIBILITY
  // ==========================================

  describe('getEligibleDiscounts', () => {
    it('should return active discounts for venue', async () => {
      const mockDiscounts = [createMockDbDiscount({ id: 'd1' }), createMockDbDiscount({ id: 'd2' })]

      prismaMock.discount.findMany.mockResolvedValue(mockDiscounts)

      const result = await getEligibleDiscounts('venue-123')

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('d1')
      expect(result[0].value).toBe(10) // Decimal → Number conversion
    })

    it('should filter by minimum purchase amount', async () => {
      const mockDiscounts = [
        createMockDbDiscount({
          id: 'd1',
          minPurchaseAmount: new Decimal(50),
        }),
      ]

      prismaMock.discount.findMany.mockResolvedValue(mockDiscounts)

      // Order total = 40, below minimum
      const result = await getEligibleDiscounts('venue-123', undefined, 40)

      expect(result).toHaveLength(0)
    })

    it('should include discount when order meets minimum purchase', async () => {
      const mockDiscounts = [
        createMockDbDiscount({
          id: 'd1',
          minPurchaseAmount: new Decimal(50),
        }),
      ]

      prismaMock.discount.findMany.mockResolvedValue(mockDiscounts)

      // Order total = 60, above minimum
      const result = await getEligibleDiscounts('venue-123', undefined, 60)

      expect(result).toHaveLength(1)
    })

    it('should filter by usage limits', async () => {
      const mockDiscounts = [
        createMockDbDiscount({
          id: 'd1',
          maxTotalUses: 100,
          currentUses: 100, // Limit reached
        }),
      ]

      prismaMock.discount.findMany.mockResolvedValue(mockDiscounts)

      const result = await getEligibleDiscounts('venue-123')

      expect(result).toHaveLength(0)
    })

    it('should filter by customer usage limit', async () => {
      const mockDiscounts = [
        createMockDbDiscount({
          id: 'd1',
          maxUsesPerCustomer: 3,
        }),
      ]

      prismaMock.discount.findMany.mockResolvedValue(mockDiscounts)
      prismaMock.orderDiscount.count.mockResolvedValue(3) // Customer used 3 times

      const result = await getEligibleDiscounts('venue-123', 'customer-123')

      expect(result).toHaveLength(0)
    })

    it('should filter by customer group', async () => {
      const mockDiscounts = [
        createMockDbDiscount({
          id: 'd1',
          customerGroupId: 'vip-group',
        }),
      ]

      prismaMock.discount.findMany.mockResolvedValue(mockDiscounts)
      prismaMock.customer.findUnique.mockResolvedValue({
        id: 'customer-123',
        customerGroupId: 'regular-group', // Different group
      })

      const result = await getEligibleDiscounts('venue-123', 'customer-123')

      expect(result).toHaveLength(0)
    })

    it('should include discount when customer is in correct group', async () => {
      const mockDiscounts = [
        createMockDbDiscount({
          id: 'd1',
          customerGroupId: 'vip-group',
        }),
      ]

      prismaMock.discount.findMany.mockResolvedValue(mockDiscounts)
      prismaMock.customer.findUnique.mockResolvedValue({
        id: 'customer-123',
        customerGroupId: 'vip-group', // Same group
      })

      const result = await getEligibleDiscounts('venue-123', 'customer-123')

      expect(result).toHaveLength(1)
    })

    it('should filter by day of week', async () => {
      const today = new Date().getDay()
      const mockDiscounts = [
        createMockDbDiscount({
          id: 'd1',
          daysOfWeek: [(today + 1) % 7], // Not today
        }),
      ]

      prismaMock.discount.findMany.mockResolvedValue(mockDiscounts)

      const result = await getEligibleDiscounts('venue-123')

      expect(result).toHaveLength(0)
    })

    it('should include discount when valid on current day', async () => {
      const today = new Date().getDay()
      const mockDiscounts = [
        createMockDbDiscount({
          id: 'd1',
          daysOfWeek: [today], // Today
        }),
      ]

      prismaMock.discount.findMany.mockResolvedValue(mockDiscounts)

      const result = await getEligibleDiscounts('venue-123')

      expect(result).toHaveLength(1)
    })
  })

  describe('getCustomerDiscounts', () => {
    it('should return customer-assigned discounts', async () => {
      const mockAssignments = [
        {
          id: 'cd-1',
          customerId: 'customer-123',
          discountId: 'discount-1',
          active: true,
          validFrom: null,
          validUntil: null,
          maxUses: null,
          usageCount: 0,
          discount: createMockDbDiscount({ id: 'discount-1', name: 'Customer Discount' }),
        },
      ]

      prismaMock.customerDiscount.findMany.mockResolvedValue(mockAssignments)

      const result = await getCustomerDiscounts('venue-123', 'customer-123')

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Customer Discount')
      expect(result[0].isAutomatic).toBe(true) // Customer discounts are auto-applied
      expect(result[0].priority).toBe(100) // Higher priority than regular discounts
    })

    it('should filter by usage limit on assignment', async () => {
      const mockAssignments = [
        {
          id: 'cd-1',
          customerId: 'customer-123',
          discountId: 'discount-1',
          active: true,
          validFrom: null,
          validUntil: null,
          maxUses: 3,
          usageCount: 3, // Limit reached
          discount: createMockDbDiscount({ id: 'discount-1' }),
        },
      ]

      prismaMock.customerDiscount.findMany.mockResolvedValue(mockAssignments)

      const result = await getCustomerDiscounts('venue-123', 'customer-123')

      expect(result).toHaveLength(0)
    })
  })

  // ==========================================
  // DISCOUNT CALCULATION
  // ==========================================

  describe('calculateDiscountAmount', () => {
    it('should calculate percentage discount on ORDER scope', () => {
      const discount = createMockEngineDiscount({
        type: 'PERCENTAGE',
        value: 10,
        scope: 'ORDER',
      })
      const context = createMockOrderContext({ subtotal: 100 })

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(10) // 10% of 100
      expect(result.applicableItems).toHaveLength(2) // All items
    })

    it('should calculate fixed amount discount', () => {
      const discount = createMockEngineDiscount({
        type: 'FIXED_AMOUNT',
        value: 15,
        scope: 'ORDER',
      })
      const context = createMockOrderContext({ subtotal: 100 })

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(15)
    })

    it('should not exceed order subtotal for fixed amount', () => {
      const discount = createMockEngineDiscount({
        type: 'FIXED_AMOUNT',
        value: 150, // More than subtotal
        scope: 'ORDER',
      })
      const context = createMockOrderContext({ subtotal: 100 })

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(100) // Capped at subtotal
    })

    it('should calculate COMP (100%) discount', () => {
      const discount = createMockEngineDiscount({
        type: 'COMP',
        value: 100,
        scope: 'ORDER',
      })
      const context = createMockOrderContext({ subtotal: 100 })

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(100) // Full amount
    })

    it('should apply max discount cap', () => {
      const discount = createMockEngineDiscount({
        type: 'PERCENTAGE',
        value: 50, // 50%
        maxDiscountAmount: 20, // Cap at $20
        scope: 'ORDER',
      })
      const context = createMockOrderContext({ subtotal: 100 })

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(20) // Capped, not 50
    })

    it('should calculate discount for ITEM scope', () => {
      const discount = createMockEngineDiscount({
        type: 'PERCENTAGE',
        value: 20,
        scope: 'ITEM',
        targetItemIds: ['product-1'], // Only first item
      })
      const context = createMockOrderContext()

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(10) // 20% of $50 (item-1 total)
      expect(result.applicableItems).toEqual(['item-1'])
    })

    it('should calculate discount for CATEGORY scope', () => {
      const discount = createMockEngineDiscount({
        type: 'PERCENTAGE',
        value: 15,
        scope: 'CATEGORY',
        targetCategoryIds: ['category-1'], // Only first category
      })
      const context = createMockOrderContext()

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(7.5) // 15% of $50 (category-1 items)
      expect(result.applicableItems).toEqual(['item-1'])
    })

    it('should return 0 for ITEM scope with no matching items', () => {
      const discount = createMockEngineDiscount({
        type: 'PERCENTAGE',
        value: 20,
        scope: 'ITEM',
        targetItemIds: ['nonexistent-product'],
      })
      const context = createMockOrderContext()

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(0)
      expect(result.applicableItems).toHaveLength(0)
    })

    it('should calculate MODIFIER scope discount', () => {
      const discount = createMockEngineDiscount({
        type: 'PERCENTAGE',
        value: 100, // Free modifier
        scope: 'MODIFIER',
        targetModifierIds: ['mod-1'],
      })
      const context = createMockOrderContext({
        items: [
          {
            id: 'item-1',
            productId: 'product-1',
            categoryId: 'category-1',
            quantity: 1,
            unitPrice: 25,
            total: 30,
            modifiers: [{ id: 'mod-1', modifierGroupId: 'group-1', price: 5 }],
          },
        ],
        subtotal: 30,
      })

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(5) // 100% of modifier price
    })
  })

  // ==========================================
  // BOGO CALCULATION
  // ==========================================

  describe('calculateDiscountAmount - BOGO', () => {
    it('should calculate Buy 2 Get 1 Free', () => {
      const discount = createMockEngineDiscount({
        type: 'PERCENTAGE',
        scope: 'QUANTITY',
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 100, // Free
      })
      const context = createMockOrderContext({
        items: [{ id: 'item-1', productId: 'p1', categoryId: 'c1', quantity: 3, unitPrice: 10, total: 30, modifiers: [] }],
        subtotal: 30,
      })

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(10) // 1 free item at $10
    })

    it('should calculate Buy 1 Get 1 50% off', () => {
      const discount = createMockEngineDiscount({
        type: 'PERCENTAGE',
        scope: 'QUANTITY',
        buyQuantity: 2, // Buy 2 items
        getQuantity: 1, // Get 1 at discount
        getDiscountPercent: 50, // 50% off
      })
      const context = createMockOrderContext({
        items: [{ id: 'item-1', productId: 'p1', categoryId: 'c1', quantity: 2, unitPrice: 20, total: 40, modifiers: [] }],
        subtotal: 40,
      })

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(10) // Buy 2 get 1 at 50% off: 1 * $20 * 50% = $10
    })

    it('should apply BOGO to cheapest items', () => {
      const discount = createMockEngineDiscount({
        type: 'PERCENTAGE',
        scope: 'QUANTITY',
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 100,
      })
      const context = createMockOrderContext({
        items: [
          { id: 'item-1', productId: 'p1', categoryId: 'c1', quantity: 1, unitPrice: 30, total: 30, modifiers: [] },
          { id: 'item-2', productId: 'p2', categoryId: 'c1', quantity: 1, unitPrice: 20, total: 20, modifiers: [] },
          { id: 'item-3', productId: 'p3', categoryId: 'c1', quantity: 1, unitPrice: 10, total: 10, modifiers: [] },
        ],
        subtotal: 60,
      })

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(10) // Cheapest item is free
    })

    it('should filter BOGO by buyItemIds and getItemIds', () => {
      const discount = createMockEngineDiscount({
        type: 'PERCENTAGE',
        scope: 'QUANTITY',
        buyQuantity: 1,
        getQuantity: 1,
        getDiscountPercent: 100,
        buyItemIds: ['pizza'],
        getItemIds: ['drink'],
      })
      const context = createMockOrderContext({
        items: [
          { id: 'item-1', productId: 'pizza', categoryId: 'c1', quantity: 1, unitPrice: 15, total: 15, modifiers: [] },
          { id: 'item-2', productId: 'drink', categoryId: 'c2', quantity: 1, unitPrice: 5, total: 5, modifiers: [] },
        ],
        subtotal: 20,
      })

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(5) // Free drink
    })

    it('should return 0 when BOGO quantity not met', () => {
      const discount = createMockEngineDiscount({
        type: 'PERCENTAGE',
        scope: 'QUANTITY',
        buyQuantity: 3,
        getQuantity: 1,
        getDiscountPercent: 100,
      })
      const context = createMockOrderContext({
        items: [
          { id: 'item-1', productId: 'p1', categoryId: 'c1', quantity: 2, unitPrice: 10, total: 20, modifiers: [] }, // Only 2, need 3
        ],
        subtotal: 20,
      })

      const result = calculateDiscountAmount(discount, context)

      expect(result.amount).toBe(0)
    })
  })

  // ==========================================
  // AUTOMATIC DISCOUNT APPLICATION
  // ==========================================

  describe('evaluateAutomaticDiscounts', () => {
    it('should return applicable automatic discounts', async () => {
      const mockOrder = {
        id: 'order-123',
        venueId: 'venue-123',
        customerId: null,
        subtotal: new Decimal(100),
        items: [
          {
            id: 'item-1',
            productId: 'p1',
            quantity: 2,
            unitPrice: new Decimal(50),
            total: new Decimal(100),
            product: { id: 'p1', categoryId: 'c1', taxRate: new Decimal(0.16) },
            modifiers: [],
          },
        ],
        orderDiscounts: [],
      }

      prismaMock.order.findUnique.mockResolvedValue(mockOrder)
      prismaMock.discount.findMany.mockResolvedValue([createMockDbDiscount({ id: 'd1', isAutomatic: true })])

      const result = await evaluateAutomaticDiscounts('order-123')

      expect(result).toHaveLength(1)
      expect(result[0].discountId).toBe('d1')
      expect(result[0].amount).toBe(10) // 10% of 100
    })

    it('should throw NotFoundError for non-existent order', async () => {
      prismaMock.order.findUnique.mockResolvedValue(null)

      await expect(evaluateAutomaticDiscounts('nonexistent')).rejects.toThrow(NotFoundError)
    })

    it('should skip already applied discounts', async () => {
      const mockOrder = {
        id: 'order-123',
        venueId: 'venue-123',
        customerId: null,
        subtotal: new Decimal(100),
        items: [],
        orderDiscounts: [{ discountId: 'd1', amount: new Decimal(10), isAutomatic: true }], // Already applied
      }

      prismaMock.order.findUnique.mockResolvedValue(mockOrder)
      prismaMock.discount.findMany.mockResolvedValue([createMockDbDiscount({ id: 'd1', isAutomatic: true })])

      const result = await evaluateAutomaticDiscounts('order-123')

      expect(result).toHaveLength(0)
    })

    it('should respect stacking rules (non-stackable blocks others)', async () => {
      const mockOrder = {
        id: 'order-123',
        venueId: 'venue-123',
        customerId: null,
        subtotal: new Decimal(100),
        items: [],
        orderDiscounts: [],
      }

      prismaMock.order.findUnique.mockResolvedValue(mockOrder)
      prismaMock.discount.findMany.mockResolvedValue([
        createMockDbDiscount({ id: 'd1', isAutomatic: true, isStackable: false, priority: 10 }),
        createMockDbDiscount({ id: 'd2', isAutomatic: true, isStackable: false, priority: 5 }),
      ])

      const result = await evaluateAutomaticDiscounts('order-123')

      // Only highest priority non-stackable should apply
      expect(result).toHaveLength(1)
      expect(result[0].discountId).toBe('d1')
    })
  })

  describe('applyDiscountToOrder', () => {
    it('should apply discount and update order totals', async () => {
      const mockOrder = {
        id: 'order-123',
        venueId: 'venue-123',
        subtotal: new Decimal(100),
        taxAmount: new Decimal(16),
        discountAmount: new Decimal(0),
        tipAmount: new Decimal(0),
        total: new Decimal(116),
        paidAmount: new Decimal(0),
        orderDiscounts: [],
      }

      const discount = {
        discountId: 'd1',
        name: 'Test Discount',
        type: 'PERCENTAGE' as DiscountType,
        value: 10,
        amount: 10,
        taxReduction: 1.6,
        applicableItems: ['item-1'],
        isAutomatic: true,
        requiresApproval: false,
      }

      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
      prismaMock.order.findUnique.mockResolvedValue(mockOrder)
      prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-1', ...discount })
      prismaMock.order.update.mockResolvedValue(mockOrder)
      prismaMock.discount.update.mockResolvedValue({})

      const result = await applyDiscountToOrder('order-123', discount)

      expect(result.success).toBe(true)
      expect(result.amount).toBe(10)
      expect(prismaMock.orderDiscount.create).toHaveBeenCalled()
      expect(prismaMock.discount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { currentUses: { increment: 1 } },
        }),
      )
    })

    it('should return error for already applied discount', async () => {
      const mockOrder = {
        id: 'order-123',
        total: new Decimal(100),
        orderDiscounts: [{ discountId: 'd1' }], // Already applied
      }

      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
      prismaMock.order.findUnique.mockResolvedValue(mockOrder)

      const discount = {
        discountId: 'd1',
        name: 'Test',
        type: 'PERCENTAGE' as DiscountType,
        value: 10,
        amount: 10,
        taxReduction: 0,
        applicableItems: [],
        isAutomatic: true,
        requiresApproval: false,
      }

      const result = await applyDiscountToOrder('order-123', discount)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Discount already applied to this order')
    })

    it('should require authorization for approval-required discounts', async () => {
      const mockOrder = {
        id: 'order-123',
        total: new Decimal(100),
        orderDiscounts: [],
      }

      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
      prismaMock.order.findUnique.mockResolvedValue(mockOrder)

      const discount = {
        discountId: 'd1',
        name: 'Comp',
        type: 'COMP' as DiscountType,
        value: 100,
        amount: 100,
        taxReduction: 0,
        applicableItems: [],
        isAutomatic: false,
        requiresApproval: true, // Requires approval
      }

      const result = await applyDiscountToOrder('order-123', discount, 'staff-1') // No authorizedById

      expect(result.success).toBe(false)
      expect(result.error).toBe('This discount requires manager approval')
    })

    it('should apply with authorization when provided', async () => {
      const mockOrder = {
        id: 'order-123',
        venueId: 'venue-123',
        subtotal: new Decimal(100),
        taxAmount: new Decimal(16),
        discountAmount: new Decimal(0),
        tipAmount: new Decimal(0),
        total: new Decimal(116),
        paidAmount: new Decimal(0),
        orderDiscounts: [],
      }

      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
      prismaMock.order.findUnique.mockResolvedValue(mockOrder)
      prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-1' })
      prismaMock.order.update.mockResolvedValue(mockOrder)
      prismaMock.discount.update.mockResolvedValue({})

      const discount = {
        discountId: 'd1',
        name: 'Comp',
        type: 'COMP' as DiscountType,
        value: 100,
        amount: 100,
        taxReduction: 0,
        applicableItems: [],
        isAutomatic: false,
        requiresApproval: true,
      }

      const result = await applyDiscountToOrder('order-123', discount, 'staff-1', 'manager-1') // With authorization

      expect(result.success).toBe(true)
    })
  })

  describe('removeDiscountFromOrder', () => {
    it('should remove discount and restore order totals', async () => {
      const mockOrderDiscount = {
        id: 'od-1',
        orderId: 'order-123',
        discountId: 'd1',
        amount: new Decimal(10),
        taxReduction: new Decimal(1.6),
        name: 'Test Discount',
      }
      const mockOrder = {
        id: 'order-123',
        subtotal: new Decimal(100),
        taxAmount: new Decimal(14.4), // After discount
        discountAmount: new Decimal(10),
        tipAmount: new Decimal(0),
        total: new Decimal(104.4),
        paidAmount: new Decimal(0),
      }

      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
      prismaMock.orderDiscount.findFirst.mockResolvedValue(mockOrderDiscount)
      prismaMock.order.findUnique.mockResolvedValue(mockOrder)
      prismaMock.orderDiscount.delete.mockResolvedValue(mockOrderDiscount)
      prismaMock.order.update.mockResolvedValue(mockOrder)
      prismaMock.discount.update.mockResolvedValue({})

      const result = await removeDiscountFromOrder('order-123', 'od-1')

      expect(result.success).toBe(true)
      expect(result.amount).toBe(10)
      expect(prismaMock.discount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { currentUses: { decrement: 1 } },
        }),
      )
    })

    it('should return error for non-existent discount', async () => {
      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
      prismaMock.orderDiscount.findFirst.mockResolvedValue(null)

      const result = await removeDiscountFromOrder('order-123', 'nonexistent')

      expect(result.success).toBe(false)
      expect(result.error).toBe('Discount not found on this order')
    })
  })

  // ==========================================
  // MANUAL DISCOUNT APPLICATION
  // ==========================================

  describe('applyManualDiscount', () => {
    it('should apply percentage manual discount', async () => {
      const mockOrder = {
        id: 'order-123',
        subtotal: new Decimal(100),
        taxAmount: new Decimal(16),
        discountAmount: new Decimal(0),
        tipAmount: new Decimal(0),
        total: new Decimal(116),
        paidAmount: new Decimal(0),
      }

      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
      prismaMock.order.findUnique.mockResolvedValue(mockOrder)
      prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-1', amount: new Decimal(15) })
      prismaMock.order.update.mockResolvedValue(mockOrder)

      const result = await applyManualDiscount('order-123', 'PERCENTAGE', 15, 'Employee discount', 'staff-1')

      expect(result.success).toBe(true)
      expect(result.amount).toBe(15) // 15% of 100
      expect(prismaMock.orderDiscount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isManual: true,
            name: 'Employee discount',
          }),
        }),
      )
    })

    it('should apply fixed amount manual discount', async () => {
      const mockOrder = {
        id: 'order-123',
        subtotal: new Decimal(100),
        taxAmount: new Decimal(16),
        discountAmount: new Decimal(0),
        tipAmount: new Decimal(0),
        total: new Decimal(116),
        paidAmount: new Decimal(0),
      }

      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
      prismaMock.order.findUnique.mockResolvedValue(mockOrder)
      prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-1' })
      prismaMock.order.update.mockResolvedValue(mockOrder)

      const result = await applyManualDiscount('order-123', 'FIXED_AMOUNT', 10, '$10 off', 'staff-1')

      expect(result.success).toBe(true)
      expect(result.amount).toBe(10)
    })

    it('should require authorization for COMP', async () => {
      const mockOrder = {
        id: 'order-123',
        subtotal: new Decimal(100),
        taxAmount: new Decimal(16),
        discountAmount: new Decimal(0),
        total: new Decimal(116),
        paidAmount: new Decimal(0),
      }

      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
      prismaMock.order.findUnique.mockResolvedValue(mockOrder)

      const result = await applyManualDiscount('order-123', 'COMP', 0, 'Full comp', 'staff-1') // No authorization

      expect(result.success).toBe(false)
      expect(result.error).toBe('Comp requires manager authorization')
    })

    it('should apply COMP with authorization', async () => {
      const mockOrder = {
        id: 'order-123',
        subtotal: new Decimal(100),
        taxAmount: new Decimal(16),
        discountAmount: new Decimal(0),
        tipAmount: new Decimal(0),
        total: new Decimal(116),
        paidAmount: new Decimal(0),
      }

      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
      prismaMock.order.findUnique.mockResolvedValue(mockOrder)
      prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-1' })
      prismaMock.order.update.mockResolvedValue(mockOrder)

      const result = await applyManualDiscount(
        'order-123',
        'COMP',
        0,
        'Customer complaint',
        'staff-1',
        'manager-1', // With authorization
        'Cold food',
      )

      expect(result.success).toBe(true)
      expect(result.amount).toBe(100) // Full subtotal
      expect(prismaMock.orderDiscount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isComp: true,
            compReason: 'Cold food',
            authorizedById: 'manager-1',
          }),
        }),
      )
    })

    it('should reject invalid percentage (> 100)', async () => {
      const mockOrder = {
        id: 'order-123',
        subtotal: new Decimal(100),
        total: new Decimal(116),
        paidAmount: new Decimal(0),
      }

      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
      prismaMock.order.findUnique.mockResolvedValue(mockOrder)

      const result = await applyManualDiscount('order-123', 'PERCENTAGE', 150, 'Invalid', 'staff-1')

      expect(result.success).toBe(false)
      expect(result.error).toBe('Percentage must be 0-100')
    })
  })

  // ==========================================
  // ORDER DISCOUNTS SUMMARY
  // ==========================================

  describe('getOrderDiscountsSummary', () => {
    it('should return formatted discount summary', async () => {
      const mockOrderDiscounts = [
        {
          id: 'od-1',
          name: 'Summer Sale',
          type: 'PERCENTAGE',
          value: new Decimal(10),
          amount: new Decimal(10),
          taxReduction: new Decimal(1.6),
          isAutomatic: true,
          isManual: false,
          isComp: false,
          compReason: null,
          createdAt: new Date(),
          discount: { id: 'd1', name: 'Summer Sale', type: 'PERCENTAGE', scope: 'ORDER' },
          couponCode: null,
          appliedBy: { staff: { firstName: 'John', lastName: 'Doe' } },
          authorizedBy: null,
        },
      ]

      prismaMock.orderDiscount.findMany.mockResolvedValue(mockOrderDiscounts)

      const result = await getOrderDiscountsSummary('order-123')

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Summer Sale')
      expect(result[0].value).toBe(10)
      expect(result[0].amount).toBe(10)
      expect(result[0].appliedBy).toBe('John Doe')
    })

    it('should handle coupon code discounts', async () => {
      const mockOrderDiscounts = [
        {
          id: 'od-1',
          name: 'Coupon Discount',
          type: 'PERCENTAGE',
          value: new Decimal(15),
          amount: new Decimal(15),
          taxReduction: new Decimal(0),
          isAutomatic: false,
          isManual: false,
          isComp: false,
          compReason: null,
          createdAt: new Date(),
          discount: null,
          couponCode: { id: 'cc-1', code: 'SAVE15' },
          appliedBy: null,
          authorizedBy: null,
        },
      ]

      prismaMock.orderDiscount.findMany.mockResolvedValue(mockOrderDiscounts)

      const result = await getOrderDiscountsSummary('order-123')

      expect(result[0].couponCode?.code).toBe('SAVE15')
    })
  })
})
