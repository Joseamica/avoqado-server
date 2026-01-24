import {
  getDiscounts,
  getDiscountById,
  createDiscount,
  updateDiscount,
  deleteDiscount,
  cloneDiscount,
  getDiscountStats,
  assignDiscountToCustomer,
  removeDiscountFromCustomer,
  getCustomerDiscounts,
  getActiveAutomaticDiscounts,
} from '../../../../src/services/dashboard/discount.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'
import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

// Helper to create mock discount
const createMockDiscount = (overrides: Record<string, any> = {}) => ({
  id: 'discount-123',
  venueId: 'venue-123',
  name: 'Test Discount',
  description: '10% off all orders',
  type: 'PERCENTAGE' as const,
  value: new Decimal(10),
  scope: 'ORDER' as const,
  targetItemIds: [],
  targetCategoryIds: [],
  targetModifierIds: [],
  targetModifierGroupIds: [],
  customerGroupId: null,
  isAutomatic: false,
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
  createdAt: new Date('2025-01-20'),
  updatedAt: new Date('2025-01-20'),
  ...overrides,
})

// Helper to create mock customer group
const createMockCustomerGroup = (overrides: Record<string, any> = {}) => ({
  id: 'group-123',
  venueId: 'venue-123',
  name: 'VIP',
  color: '#FFD700',
  ...overrides,
})

describe('Discount Dashboard Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ==========================================
  // DISCOUNT CRUD OPERATIONS
  // ==========================================

  describe('getDiscounts', () => {
    it('should return paginated discounts with correct metadata', async () => {
      const mockDiscounts = [
        createMockDiscount({ id: 'discount-1', name: 'Discount 1' }),
        createMockDiscount({ id: 'discount-2', name: 'Discount 2' }),
      ]

      prismaMock.discount.count.mockResolvedValue(25)
      prismaMock.discount.findMany.mockResolvedValue(
        mockDiscounts.map(d => ({
          ...d,
          customerGroup: null,
          _count: { couponCodes: 2, customerDiscounts: 5, orderDiscounts: 10 },
        })),
      )

      const result = await getDiscounts('venue-123', 1, 10)

      expect(result.data).toHaveLength(2)
      expect(result.meta).toEqual({
        totalCount: 25,
        pageSize: 10,
        currentPage: 1,
        totalPages: 3,
        hasNextPage: true,
        hasPrevPage: false,
      })
      // Verify Decimal → Number conversion
      expect(result.data[0].value).toBe(10)
    })

    it('should apply search filter', async () => {
      prismaMock.discount.count.mockResolvedValue(0)
      prismaMock.discount.findMany.mockResolvedValue([])

      await getDiscounts('venue-123', 1, 10, 'summer')

      expect(prismaMock.discount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId: 'venue-123',
            OR: expect.arrayContaining([
              expect.objectContaining({ name: { contains: 'summer', mode: 'insensitive' } }),
              expect.objectContaining({ description: { contains: 'summer', mode: 'insensitive' } }),
            ]),
          }),
        }),
      )
    })

    it('should filter by discount type', async () => {
      prismaMock.discount.count.mockResolvedValue(0)
      prismaMock.discount.findMany.mockResolvedValue([])

      await getDiscounts('venue-123', 1, 10, undefined, 'PERCENTAGE')

      expect(prismaMock.discount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId: 'venue-123',
            type: 'PERCENTAGE',
          }),
        }),
      )
    })

    it('should filter by scope', async () => {
      prismaMock.discount.count.mockResolvedValue(0)
      prismaMock.discount.findMany.mockResolvedValue([])

      await getDiscounts('venue-123', 1, 10, undefined, undefined, 'ITEM')

      expect(prismaMock.discount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId: 'venue-123',
            scope: 'ITEM',
          }),
        }),
      )
    })

    it('should filter by isAutomatic', async () => {
      prismaMock.discount.count.mockResolvedValue(0)
      prismaMock.discount.findMany.mockResolvedValue([])

      await getDiscounts('venue-123', 1, 10, undefined, undefined, undefined, true)

      expect(prismaMock.discount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId: 'venue-123',
            isAutomatic: true,
          }),
        }),
      )
    })

    it('should filter by active status', async () => {
      prismaMock.discount.count.mockResolvedValue(0)
      prismaMock.discount.findMany.mockResolvedValue([])

      await getDiscounts('venue-123', 1, 10, undefined, undefined, undefined, undefined, false)

      expect(prismaMock.discount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId: 'venue-123',
            active: false,
          }),
        }),
      )
    })

    it('should enforce multi-tenant isolation (venueId filter)', async () => {
      prismaMock.discount.count.mockResolvedValue(0)
      prismaMock.discount.findMany.mockResolvedValue([])

      await getDiscounts('venue-123')

      expect(prismaMock.discount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId: 'venue-123',
          }),
        }),
      )
    })
  })

  describe('getDiscountById', () => {
    it('should return discount with details', async () => {
      const mockDiscount = {
        ...createMockDiscount(),
        customerGroup: createMockCustomerGroup(),
        couponCodes: [{ id: 'coupon-1', code: 'SUMMER10', maxUses: 100, currentUses: 10, validFrom: null, validUntil: null, active: true }],
        customerDiscounts: [],
        _count: { couponCodes: 1, customerDiscounts: 0, orderDiscounts: 5 },
      }

      prismaMock.discount.findFirst.mockResolvedValue(mockDiscount)

      const result = await getDiscountById('venue-123', 'discount-123')

      expect(result.id).toBe('discount-123')
      expect(result.value).toBe(10)
      expect(result.customerGroup?.name).toBe('VIP')
      expect(prismaMock.discount.findFirst).toHaveBeenCalledWith({
        where: { id: 'discount-123', venueId: 'venue-123' },
        include: expect.any(Object),
      })
    })

    it('should throw NotFoundError if discount does not exist', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(null)

      await expect(getDiscountById('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
      await expect(getDiscountById('venue-123', 'nonexistent')).rejects.toThrow('Discount not found')
    })

    it('should enforce multi-tenant isolation (venueId filter)', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(null)

      await expect(getDiscountById('venue-123', 'discount-456')).rejects.toThrow(NotFoundError)

      expect(prismaMock.discount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'discount-456', venueId: 'venue-123' },
        }),
      )
    })
  })

  describe('createDiscount', () => {
    it('should create percentage discount successfully', async () => {
      const mockDiscount = {
        ...createMockDiscount({ name: 'Summer Sale' }),
        customerGroup: null,
      }

      prismaMock.discount.create.mockResolvedValue(mockDiscount)

      const result = await createDiscount('venue-123', {
        name: 'Summer Sale',
        type: 'PERCENTAGE',
        value: 10,
      })

      expect(result.name).toBe('Summer Sale')
      expect(result.value).toBe(10)
      expect(prismaMock.discount.create).toHaveBeenCalled()
    })

    it('should create fixed amount discount successfully', async () => {
      const mockDiscount = {
        ...createMockDiscount({ name: '$5 Off', type: 'FIXED_AMOUNT', value: new Decimal(5) }),
        customerGroup: null,
      }

      prismaMock.discount.create.mockResolvedValue(mockDiscount)

      const result = await createDiscount('venue-123', {
        name: '$5 Off',
        type: 'FIXED_AMOUNT',
        value: 5,
      })

      expect(result.name).toBe('$5 Off')
      expect(prismaMock.discount.create).toHaveBeenCalled()
    })

    it('should create COMP discount with value set to 100', async () => {
      const mockDiscount = {
        ...createMockDiscount({ name: 'Comp Order', type: 'COMP', value: new Decimal(100) }),
        customerGroup: null,
      }

      prismaMock.discount.create.mockResolvedValue(mockDiscount)

      await createDiscount('venue-123', {
        name: 'Comp Order',
        type: 'COMP',
        value: 0, // Should be overridden to 100
      })

      expect(prismaMock.discount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            value: 100,
          }),
        }),
      )
    })

    it('should throw BadRequestError for invalid percentage value (> 100)', async () => {
      await expect(
        createDiscount('venue-123', {
          name: 'Invalid Discount',
          type: 'PERCENTAGE',
          value: 150,
        }),
      ).rejects.toThrow(BadRequestError)
      await expect(
        createDiscount('venue-123', {
          name: 'Invalid Discount',
          type: 'PERCENTAGE',
          value: 150,
        }),
      ).rejects.toThrow('Percentage discount value must be between 0 and 100')
    })

    it('should throw BadRequestError for negative percentage value', async () => {
      await expect(
        createDiscount('venue-123', {
          name: 'Invalid Discount',
          type: 'PERCENTAGE',
          value: -10,
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('should throw BadRequestError for negative fixed amount', async () => {
      await expect(
        createDiscount('venue-123', {
          name: 'Invalid Discount',
          type: 'FIXED_AMOUNT',
          value: -5,
        }),
      ).rejects.toThrow(BadRequestError)
      await expect(
        createDiscount('venue-123', {
          name: 'Invalid Discount',
          type: 'FIXED_AMOUNT',
          value: -5,
        }),
      ).rejects.toThrow('Fixed amount discount value must be positive')
    })

    it('should throw BadRequestError if customerGroupId does not exist', async () => {
      prismaMock.customerGroup.findFirst.mockResolvedValue(null)

      await expect(
        createDiscount('venue-123', {
          name: 'VIP Discount',
          type: 'PERCENTAGE',
          value: 15,
          customerGroupId: 'invalid-group',
        }),
      ).rejects.toThrow(BadRequestError)
      await expect(
        createDiscount('venue-123', {
          name: 'VIP Discount',
          type: 'PERCENTAGE',
          value: 15,
          customerGroupId: 'invalid-group',
        }),
      ).rejects.toThrow('Customer group not found')
    })

    it('should create discount with valid customerGroupId', async () => {
      const mockGroup = createMockCustomerGroup()
      const mockDiscount = {
        ...createMockDiscount({ customerGroupId: 'group-123' }),
        customerGroup: mockGroup,
      }

      prismaMock.customerGroup.findFirst.mockResolvedValue(mockGroup)
      prismaMock.discount.create.mockResolvedValue(mockDiscount)

      const result = await createDiscount('venue-123', {
        name: 'VIP Discount',
        type: 'PERCENTAGE',
        value: 15,
        customerGroupId: 'group-123',
      })

      expect(prismaMock.customerGroup.findFirst).toHaveBeenCalledWith({
        where: { id: 'group-123', venueId: 'venue-123' },
      })
      expect(result.customerGroupId).toBe('group-123')
    })

    it('should throw BadRequestError for BOGO without required fields', async () => {
      await expect(
        createDiscount('venue-123', {
          name: 'BOGO',
          type: 'PERCENTAGE',
          value: 100,
          scope: 'QUANTITY',
          buyQuantity: 2,
          // Missing getQuantity
        }),
      ).rejects.toThrow(BadRequestError)
      await expect(
        createDiscount('venue-123', {
          name: 'BOGO',
          type: 'PERCENTAGE',
          value: 100,
          scope: 'QUANTITY',
          buyQuantity: 2,
        }),
      ).rejects.toThrow('BOGO discounts require both buyQuantity and getQuantity')
    })

    it('should create BOGO discount with default 100% discount', async () => {
      const mockDiscount = {
        ...createMockDiscount({
          name: 'Buy 2 Get 1 Free',
          scope: 'QUANTITY',
          buyQuantity: 2,
          getQuantity: 1,
          getDiscountPercent: new Decimal(100),
        }),
        customerGroup: null,
      }

      prismaMock.discount.create.mockResolvedValue(mockDiscount)

      await createDiscount('venue-123', {
        name: 'Buy 2 Get 1 Free',
        type: 'PERCENTAGE',
        value: 0,
        scope: 'QUANTITY',
        buyQuantity: 2,
        getQuantity: 1,
      })

      expect(prismaMock.discount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            buyQuantity: 2,
            getQuantity: 1,
            getDiscountPercent: 100, // Default free item
          }),
        }),
      )
    })

    it('should throw BadRequestError for timeFrom without timeUntil', async () => {
      await expect(
        createDiscount('venue-123', {
          name: 'Happy Hour',
          type: 'PERCENTAGE',
          value: 20,
          timeFrom: '17:00',
        }),
      ).rejects.toThrow(BadRequestError)
      await expect(
        createDiscount('venue-123', {
          name: 'Happy Hour',
          type: 'PERCENTAGE',
          value: 20,
          timeFrom: '17:00',
        }),
      ).rejects.toThrow('timeUntil is required when timeFrom is set')
    })
  })

  describe('updateDiscount', () => {
    it('should update discount successfully', async () => {
      const existingDiscount = createMockDiscount()
      const updatedDiscount = {
        ...createMockDiscount({ name: 'Updated Discount', value: new Decimal(15) }),
        customerGroup: null,
      }

      prismaMock.discount.findFirst.mockResolvedValue(existingDiscount)
      prismaMock.discount.update.mockResolvedValue(updatedDiscount)

      const result = await updateDiscount('venue-123', 'discount-123', {
        name: 'Updated Discount',
        value: 15,
      })

      expect(result.name).toBe('Updated Discount')
      expect(result.value).toBe(15)
    })

    it('should throw NotFoundError if discount does not exist', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(null)

      await expect(updateDiscount('venue-123', 'nonexistent', { name: 'Test' })).rejects.toThrow(NotFoundError)
    })

    it('should throw BadRequestError for invalid percentage value on update', async () => {
      const existingDiscount = createMockDiscount()
      prismaMock.discount.findFirst.mockResolvedValue(existingDiscount)

      await expect(
        updateDiscount('venue-123', 'discount-123', {
          type: 'PERCENTAGE',
          value: 150,
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('should validate customerGroupId on update', async () => {
      const existingDiscount = createMockDiscount()
      prismaMock.discount.findFirst.mockResolvedValue(existingDiscount)
      prismaMock.customerGroup.findFirst.mockResolvedValue(null)

      await expect(
        updateDiscount('venue-123', 'discount-123', {
          customerGroupId: 'invalid-group',
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('should update active status', async () => {
      const existingDiscount = createMockDiscount({ active: true })
      const updatedDiscount = {
        ...createMockDiscount({ active: false }),
        customerGroup: null,
      }

      prismaMock.discount.findFirst.mockResolvedValue(existingDiscount)
      prismaMock.discount.update.mockResolvedValue(updatedDiscount)

      const result = await updateDiscount('venue-123', 'discount-123', { active: false })

      expect(result.active).toBe(false)
    })
  })

  describe('deleteDiscount', () => {
    it('should delete discount successfully', async () => {
      const existingDiscount = createMockDiscount()

      prismaMock.discount.findFirst.mockResolvedValue(existingDiscount)
      prismaMock.discount.delete.mockResolvedValue(existingDiscount)

      await expect(deleteDiscount('venue-123', 'discount-123')).resolves.toBeUndefined()

      expect(prismaMock.discount.delete).toHaveBeenCalledWith({
        where: { id: 'discount-123' },
      })
    })

    it('should throw NotFoundError if discount does not exist', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(null)

      await expect(deleteDiscount('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
    })

    it('should enforce multi-tenant isolation', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(null)

      await expect(deleteDiscount('venue-123', 'discount-456')).rejects.toThrow(NotFoundError)

      expect(prismaMock.discount.findFirst).toHaveBeenCalledWith({
        where: { id: 'discount-456', venueId: 'venue-123' },
      })
    })
  })

  describe('cloneDiscount', () => {
    it('should clone discount with "(Copy)" suffix', async () => {
      const originalDiscount = createMockDiscount({ name: 'Summer Sale' })
      const clonedDiscount = {
        ...createMockDiscount({ id: 'discount-clone', name: 'Summer Sale (Copy)', active: false, currentUses: 0 }),
        customerGroup: null,
      }

      prismaMock.discount.findFirst.mockResolvedValue(originalDiscount)
      prismaMock.discount.create.mockResolvedValue(clonedDiscount)

      const result = await cloneDiscount('venue-123', 'discount-123')

      expect(result.name).toBe('Summer Sale (Copy)')
      expect(result.active).toBe(false) // Clone starts inactive
      expect(prismaMock.discount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Summer Sale (Copy)',
            active: false,
            currentUses: 0,
          }),
        }),
      )
    })

    it('should throw NotFoundError if original discount does not exist', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(null)

      await expect(cloneDiscount('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================
  // DISCOUNT STATISTICS
  // ==========================================

  describe('getDiscountStats', () => {
    it('should return correct statistics', async () => {
      prismaMock.discount.count
        .mockResolvedValueOnce(10) // totalDiscounts
        .mockResolvedValueOnce(8) // activeDiscounts
        .mockResolvedValueOnce(3) // automaticDiscounts

      prismaMock.orderDiscount.findMany.mockResolvedValue([
        { discountId: 'd1', amount: new Decimal(10), discount: { id: 'd1', name: 'Discount 1', type: 'PERCENTAGE' } },
        { discountId: 'd1', amount: new Decimal(15), discount: { id: 'd1', name: 'Discount 1', type: 'PERCENTAGE' } },
        { discountId: 'd2', amount: new Decimal(5), discount: { id: 'd2', name: 'Discount 2', type: 'FIXED_AMOUNT' } },
      ])

      const result = await getDiscountStats('venue-123')

      expect(result.totalDiscounts).toBe(10)
      expect(result.activeDiscounts).toBe(8)
      expect(result.automaticDiscounts).toBe(3)
      expect(result.totalRedemptions).toBe(3)
      expect(result.totalSaved).toBe(30) // 10 + 15 + 5
      expect(result.topDiscounts).toHaveLength(2)
      expect(result.topDiscounts[0].redemptions).toBe(2) // d1 used twice
    })

    it('should handle empty statistics', async () => {
      prismaMock.discount.count.mockResolvedValue(0)
      prismaMock.orderDiscount.findMany.mockResolvedValue([])

      const result = await getDiscountStats('venue-123')

      expect(result.totalDiscounts).toBe(0)
      expect(result.totalRedemptions).toBe(0)
      expect(result.totalSaved).toBe(0)
      expect(result.topDiscounts).toHaveLength(0)
    })
  })

  // ==========================================
  // CUSTOMER DISCOUNT ASSIGNMENT
  // ==========================================

  describe('assignDiscountToCustomer', () => {
    it('should assign discount to customer', async () => {
      const mockDiscount = createMockDiscount()
      const mockCustomer = {
        id: 'customer-123',
        venueId: 'venue-123',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@test.com',
      }
      const mockAssignment = {
        id: 'cd-123',
        customerId: 'customer-123',
        discountId: 'discount-123',
        assignedById: 'staff-123',
        validFrom: null,
        validUntil: null,
        maxUses: null,
        usageCount: 0,
        active: true,
        assignedAt: new Date(),
        discount: { id: mockDiscount.id, name: mockDiscount.name, type: mockDiscount.type, value: mockDiscount.value },
        customer: { id: mockCustomer.id, firstName: mockCustomer.firstName, lastName: mockCustomer.lastName, email: mockCustomer.email },
      }

      prismaMock.discount.findFirst.mockResolvedValue(mockDiscount)
      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer)
      prismaMock.customerDiscount.findUnique.mockResolvedValue(null)
      prismaMock.customerDiscount.create.mockResolvedValue(mockAssignment)

      const result = await assignDiscountToCustomer('venue-123', 'discount-123', 'customer-123', 'staff-123')

      expect(result.customerId).toBe('customer-123')
      expect(result.discountId).toBe('discount-123')
    })

    it('should update existing assignment if already assigned', async () => {
      const mockDiscount = createMockDiscount()
      const mockCustomer = {
        id: 'customer-123',
        venueId: 'venue-123',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@test.com',
      }
      const existingAssignment = {
        id: 'cd-123',
        customerId: 'customer-123',
        discountId: 'discount-123',
        active: false,
        validFrom: null,
        validUntil: null,
        maxUses: null,
      }
      const updatedAssignment = {
        ...existingAssignment,
        active: true,
        discount: { id: mockDiscount.id, name: mockDiscount.name, type: mockDiscount.type, value: mockDiscount.value },
        customer: { id: mockCustomer.id, firstName: mockCustomer.firstName, lastName: mockCustomer.lastName, email: mockCustomer.email },
      }

      prismaMock.discount.findFirst.mockResolvedValue(mockDiscount)
      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer)
      prismaMock.customerDiscount.findUnique.mockResolvedValue(existingAssignment)
      prismaMock.customerDiscount.update.mockResolvedValue(updatedAssignment)

      const result = await assignDiscountToCustomer('venue-123', 'discount-123', 'customer-123')

      expect(prismaMock.customerDiscount.update).toHaveBeenCalled()
      expect(result.active).toBe(true)
    })

    it('should throw NotFoundError if discount does not exist', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(null)

      await expect(assignDiscountToCustomer('venue-123', 'nonexistent', 'customer-123')).rejects.toThrow(NotFoundError)
    })

    it('should throw NotFoundError if customer does not exist', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(createMockDiscount())
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(assignDiscountToCustomer('venue-123', 'discount-123', 'nonexistent')).rejects.toThrow(NotFoundError)
    })
  })

  describe('removeDiscountFromCustomer', () => {
    it('should remove discount assignment', async () => {
      const mockDiscount = createMockDiscount()
      const mockAssignment = {
        id: 'cd-123',
        customerId: 'customer-123',
        discountId: 'discount-123',
      }

      prismaMock.discount.findFirst.mockResolvedValue(mockDiscount)
      prismaMock.customerDiscount.findUnique.mockResolvedValue(mockAssignment)
      prismaMock.customerDiscount.delete.mockResolvedValue(mockAssignment)

      await expect(removeDiscountFromCustomer('venue-123', 'discount-123', 'customer-123')).resolves.toBeUndefined()
    })

    it('should throw NotFoundError if assignment does not exist', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(createMockDiscount())
      prismaMock.customerDiscount.findUnique.mockResolvedValue(null)

      await expect(removeDiscountFromCustomer('venue-123', 'discount-123', 'customer-123')).rejects.toThrow(NotFoundError)
    })
  })

  describe('getCustomerDiscounts', () => {
    it('should return customer discounts', async () => {
      const mockCustomer = { id: 'customer-123', venueId: 'venue-123' }
      const mockAssignments = [
        {
          id: 'cd-1',
          customerId: 'customer-123',
          discountId: 'discount-1',
          discount: {
            id: 'discount-1',
            name: 'VIP Discount',
            description: null,
            type: 'PERCENTAGE',
            value: new Decimal(10),
            scope: 'ORDER',
            validFrom: null,
            validUntil: null,
            active: true,
          },
        },
      ]

      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer)
      prismaMock.customerDiscount.findMany.mockResolvedValue(mockAssignments)

      const result = await getCustomerDiscounts('venue-123', 'customer-123')

      expect(result).toHaveLength(1)
      expect(result[0].discount.value).toBe(10) // Decimal converted to Number
    })

    it('should throw NotFoundError if customer does not exist', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(getCustomerDiscounts('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================
  // AUTOMATIC DISCOUNTS
  // ==========================================

  describe('getActiveAutomaticDiscounts', () => {
    it('should return active automatic discounts with valid dates', async () => {
      const mockDiscounts = [
        { ...createMockDiscount({ id: 'd1', isAutomatic: true }), customerGroup: null },
        { ...createMockDiscount({ id: 'd2', isAutomatic: true }), customerGroup: null },
      ]

      prismaMock.discount.findMany.mockResolvedValue(mockDiscounts)

      const result = await getActiveAutomaticDiscounts('venue-123')

      expect(result).toHaveLength(2)
      expect(prismaMock.discount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId: 'venue-123',
            active: true,
            isAutomatic: true,
          }),
        }),
      )
    })

    it('should convert Decimal fields to Numbers', async () => {
      const mockDiscounts = [
        {
          ...createMockDiscount({
            isAutomatic: true,
            minPurchaseAmount: new Decimal(50),
            maxDiscountAmount: new Decimal(100),
            getDiscountPercent: new Decimal(50),
          }),
          customerGroup: null,
        },
      ]

      prismaMock.discount.findMany.mockResolvedValue(mockDiscounts)

      const result = await getActiveAutomaticDiscounts('venue-123')

      expect(result[0].value).toBe(10)
      expect(result[0].minPurchaseAmount).toBe(50)
      expect(result[0].maxDiscountAmount).toBe(100)
      expect(result[0].getDiscountPercent).toBe(50)
    })
  })
})
