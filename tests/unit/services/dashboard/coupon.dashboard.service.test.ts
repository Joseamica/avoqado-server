import {
  getCouponCodes,
  getCouponCodeById,
  createCouponCode,
  updateCouponCode,
  deleteCouponCode,
  bulkGenerateCouponCodes,
  validateCouponCode,
  recordCouponRedemption,
  getCouponRedemptions,
  getCouponStats,
} from '../../../../src/services/dashboard/coupon.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'
import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

// Helper to create mock discount
const createMockDiscount = (overrides: Record<string, any> = {}) => ({
  id: 'discount-123',
  venueId: 'venue-123',
  name: 'Summer Sale',
  description: '10% off all orders',
  type: 'PERCENTAGE' as const,
  value: new Decimal(10),
  scope: 'ORDER' as const,
  maxDiscountAmount: null,
  active: true,
  ...overrides,
})

// Helper to create mock coupon
const createMockCoupon = (overrides: Record<string, any> = {}) => ({
  id: 'coupon-123',
  discountId: 'discount-123',
  code: 'SUMMER10',
  maxUses: null,
  maxUsesPerCustomer: null,
  minPurchaseAmount: null,
  currentUses: 0,
  validFrom: null,
  validUntil: null,
  active: true,
  createdAt: new Date('2025-01-20'),
  updatedAt: new Date('2025-01-20'),
  ...overrides,
})

describe('Coupon Dashboard Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ==========================================
  // COUPON CRUD OPERATIONS
  // ==========================================

  describe('getCouponCodes', () => {
    it('should return paginated coupons with correct metadata', async () => {
      const mockCoupons = [
        {
          ...createMockCoupon({ id: 'coupon-1', code: 'CODE1' }),
          discount: createMockDiscount(),
          _count: { redemptions: 5 },
        },
        {
          ...createMockCoupon({ id: 'coupon-2', code: 'CODE2' }),
          discount: createMockDiscount(),
          _count: { redemptions: 10 },
        },
      ]

      prismaMock.couponCode.count.mockResolvedValue(25)
      prismaMock.couponCode.findMany.mockResolvedValue(mockCoupons)

      const result = await getCouponCodes('venue-123', 1, 10)

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
      expect(result.data[0].discount.value).toBe(10)
    })

    it('should apply search filter (code)', async () => {
      prismaMock.couponCode.count.mockResolvedValue(0)
      prismaMock.couponCode.findMany.mockResolvedValue([])

      await getCouponCodes('venue-123', 1, 10, 'summer')

      expect(prismaMock.couponCode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            discount: { venueId: 'venue-123' },
            code: { contains: 'SUMMER', mode: 'insensitive' },
          }),
        }),
      )
    })

    it('should filter by discountId', async () => {
      prismaMock.couponCode.count.mockResolvedValue(0)
      prismaMock.couponCode.findMany.mockResolvedValue([])

      await getCouponCodes('venue-123', 1, 10, undefined, 'discount-456')

      expect(prismaMock.couponCode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            discountId: 'discount-456',
          }),
        }),
      )
    })

    it('should filter by active status', async () => {
      prismaMock.couponCode.count.mockResolvedValue(0)
      prismaMock.couponCode.findMany.mockResolvedValue([])

      await getCouponCodes('venue-123', 1, 10, undefined, undefined, false)

      expect(prismaMock.couponCode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            active: false,
          }),
        }),
      )
    })

    it('should enforce multi-tenant isolation through discount.venueId', async () => {
      prismaMock.couponCode.count.mockResolvedValue(0)
      prismaMock.couponCode.findMany.mockResolvedValue([])

      await getCouponCodes('venue-123')

      expect(prismaMock.couponCode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            discount: { venueId: 'venue-123' },
          }),
        }),
      )
    })
  })

  describe('getCouponCodeById', () => {
    it('should return coupon with details and redemptions', async () => {
      const mockCoupon = {
        ...createMockCoupon(),
        discount: {
          ...createMockDiscount(),
          maxDiscountAmount: new Decimal(50),
        },
        redemptions: [
          {
            id: 'redemption-1',
            amountSaved: new Decimal(10),
            redeemedAt: new Date(),
            customer: { id: 'c1', firstName: 'John', lastName: 'Doe', email: 'john@test.com' },
            order: { id: 'o1', total: new Decimal(100), createdAt: new Date() },
          },
        ],
        _count: { redemptions: 1 },
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(mockCoupon)

      const result = await getCouponCodeById('venue-123', 'coupon-123')

      expect(result.id).toBe('coupon-123')
      expect(result.code).toBe('SUMMER10')
      expect(result.discount.value).toBe(10)
      expect(result.discount.maxDiscountAmount).toBe(50)
      expect(result.redemptions[0].amountSaved).toBe(10)
    })

    it('should throw NotFoundError if coupon does not exist', async () => {
      prismaMock.couponCode.findFirst.mockResolvedValue(null)

      await expect(getCouponCodeById('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
      await expect(getCouponCodeById('venue-123', 'nonexistent')).rejects.toThrow('Coupon code not found')
    })
  })

  describe('createCouponCode', () => {
    it('should create coupon code successfully', async () => {
      const mockDiscount = createMockDiscount()
      const mockCoupon = {
        ...createMockCoupon({ code: 'NEWCODE' }),
        discount: mockDiscount,
      }

      prismaMock.discount.findFirst.mockResolvedValue(mockDiscount)
      prismaMock.couponCode.findUnique.mockResolvedValue(null) // No duplicate
      prismaMock.couponCode.create.mockResolvedValue(mockCoupon)

      const result = await createCouponCode('venue-123', {
        discountId: 'discount-123',
        code: 'newcode', // Lowercase - should be normalized
      })

      expect(result.code).toBe('NEWCODE')
      expect(prismaMock.couponCode.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'NEWCODE', // Uppercase
          }),
        }),
      )
    })

    it('should throw NotFoundError if discount does not exist', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(null)

      await expect(
        createCouponCode('venue-123', {
          discountId: 'nonexistent',
          code: 'TEST',
        }),
      ).rejects.toThrow(NotFoundError)
    })

    it('should throw BadRequestError if code already exists', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(createMockDiscount())
      prismaMock.couponCode.findUnique.mockResolvedValue(createMockCoupon({ code: 'DUPLICATE' }))

      await expect(
        createCouponCode('venue-123', {
          discountId: 'discount-123',
          code: 'DUPLICATE',
        }),
      ).rejects.toThrow(BadRequestError)
      await expect(
        createCouponCode('venue-123', {
          discountId: 'discount-123',
          code: 'DUPLICATE',
        }),
      ).rejects.toThrow('Coupon code "DUPLICATE" already exists')
    })

    it('should throw BadRequestError for invalid code format (special characters)', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(createMockDiscount())
      prismaMock.couponCode.findUnique.mockResolvedValue(null)

      await expect(
        createCouponCode('venue-123', {
          discountId: 'discount-123',
          code: 'CODE!@#',
        }),
      ).rejects.toThrow(BadRequestError)
      await expect(
        createCouponCode('venue-123', {
          discountId: 'discount-123',
          code: 'CODE!@#',
        }),
      ).rejects.toThrow('Coupon code can only contain letters, numbers, hyphens, and underscores')
    })

    it('should throw BadRequestError for code too short (< 3 chars)', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(createMockDiscount())
      prismaMock.couponCode.findUnique.mockResolvedValue(null)

      await expect(
        createCouponCode('venue-123', {
          discountId: 'discount-123',
          code: 'AB',
        }),
      ).rejects.toThrow(BadRequestError)
      await expect(
        createCouponCode('venue-123', {
          discountId: 'discount-123',
          code: 'AB',
        }),
      ).rejects.toThrow('Coupon code must be between 3 and 30 characters')
    })

    it('should throw BadRequestError for code too long (> 30 chars)', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(createMockDiscount())
      prismaMock.couponCode.findUnique.mockResolvedValue(null)

      await expect(
        createCouponCode('venue-123', {
          discountId: 'discount-123',
          code: 'A'.repeat(31),
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('should allow valid code formats (letters, numbers, hyphens, underscores)', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(createMockDiscount())
      prismaMock.couponCode.findUnique.mockResolvedValue(null)
      prismaMock.couponCode.create.mockResolvedValue({
        ...createMockCoupon({ code: 'SUMMER-2025_VIP' }),
        discount: createMockDiscount(),
      })

      const result = await createCouponCode('venue-123', {
        discountId: 'discount-123',
        code: 'SUMMER-2025_VIP',
      })

      expect(result.code).toBe('SUMMER-2025_VIP')
    })
  })

  describe('updateCouponCode', () => {
    it('should update coupon code successfully', async () => {
      const existingCoupon = createMockCoupon()
      const updatedCoupon = {
        ...createMockCoupon({ code: 'NEWCODE', maxUses: 100 }),
        discount: createMockDiscount(),
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(existingCoupon)
      prismaMock.couponCode.findUnique.mockResolvedValue(null) // No duplicate
      prismaMock.couponCode.update.mockResolvedValue(updatedCoupon)

      const result = await updateCouponCode('venue-123', 'coupon-123', {
        code: 'newcode',
        maxUses: 100,
      })

      expect(result.code).toBe('NEWCODE')
    })

    it('should throw NotFoundError if coupon does not exist', async () => {
      prismaMock.couponCode.findFirst.mockResolvedValue(null)

      await expect(updateCouponCode('venue-123', 'nonexistent', { maxUses: 100 })).rejects.toThrow(NotFoundError)
    })

    it('should throw BadRequestError if new code already exists (different coupon)', async () => {
      const existingCoupon = createMockCoupon({ code: 'OLDCODE' })
      const duplicateCoupon = createMockCoupon({ id: 'coupon-456', code: 'NEWCODE' })

      prismaMock.couponCode.findFirst.mockResolvedValue(existingCoupon)
      prismaMock.couponCode.findUnique.mockResolvedValue(duplicateCoupon)

      await expect(updateCouponCode('venue-123', 'coupon-123', { code: 'NEWCODE' })).rejects.toThrow(BadRequestError)
    })

    it('should allow updating to same code (no duplicate error)', async () => {
      const existingCoupon = createMockCoupon({ code: 'SAME' })
      const updatedCoupon = {
        ...existingCoupon,
        maxUses: 100,
        discount: createMockDiscount(),
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(existingCoupon)
      prismaMock.couponCode.update.mockResolvedValue(updatedCoupon)

      await updateCouponCode('venue-123', 'coupon-123', { code: 'SAME', maxUses: 100 })

      // Should NOT check for duplicates if code hasn't changed
      expect(prismaMock.couponCode.findUnique).not.toHaveBeenCalled()
    })

    it('should validate code format on update', async () => {
      prismaMock.couponCode.findFirst.mockResolvedValue(createMockCoupon())

      await expect(updateCouponCode('venue-123', 'coupon-123', { code: 'BAD!CODE' })).rejects.toThrow(BadRequestError)
    })
  })

  describe('deleteCouponCode', () => {
    it('should delete coupon successfully', async () => {
      prismaMock.couponCode.findFirst.mockResolvedValue(createMockCoupon())
      prismaMock.couponCode.delete.mockResolvedValue(createMockCoupon())

      await expect(deleteCouponCode('venue-123', 'coupon-123')).resolves.toBeUndefined()

      expect(prismaMock.couponCode.delete).toHaveBeenCalledWith({
        where: { id: 'coupon-123' },
      })
    })

    it('should throw NotFoundError if coupon does not exist', async () => {
      prismaMock.couponCode.findFirst.mockResolvedValue(null)

      await expect(deleteCouponCode('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================
  // BULK OPERATIONS
  // ==========================================

  describe('bulkGenerateCouponCodes', () => {
    it('should generate multiple unique codes', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(createMockDiscount())
      prismaMock.couponCode.findUnique.mockResolvedValue(null) // No duplicates
      prismaMock.couponCode.createMany.mockResolvedValue({ count: 5 })

      const result = await bulkGenerateCouponCodes('venue-123', {
        discountId: 'discount-123',
        quantity: 5,
      })

      expect(result.count).toBe(5)
      expect(result.codes).toHaveLength(5)
      expect(result.discountId).toBe('discount-123')
    })

    it('should generate codes with prefix', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(createMockDiscount())
      prismaMock.couponCode.findUnique.mockResolvedValue(null)
      prismaMock.couponCode.createMany.mockResolvedValue({ count: 3 })

      const result = await bulkGenerateCouponCodes('venue-123', {
        discountId: 'discount-123',
        quantity: 3,
        prefix: 'VIP',
      })

      expect(result.codes[0]).toMatch(/^VIP-/)
    })

    it('should throw NotFoundError if discount does not exist', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(null)

      await expect(
        bulkGenerateCouponCodes('venue-123', {
          discountId: 'nonexistent',
          quantity: 5,
        }),
      ).rejects.toThrow(NotFoundError)
    })

    it('should throw BadRequestError for invalid quantity (> 1000)', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(createMockDiscount())

      await expect(
        bulkGenerateCouponCodes('venue-123', {
          discountId: 'discount-123',
          quantity: 1001,
        }),
      ).rejects.toThrow(BadRequestError)
      await expect(
        bulkGenerateCouponCodes('venue-123', {
          discountId: 'discount-123',
          quantity: 1001,
        }),
      ).rejects.toThrow('Quantity must be between 1 and 1000')
    })

    it('should throw BadRequestError for invalid quantity (< 1)', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(createMockDiscount())

      await expect(
        bulkGenerateCouponCodes('venue-123', {
          discountId: 'discount-123',
          quantity: 0,
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('should throw BadRequestError for invalid code length', async () => {
      prismaMock.discount.findFirst.mockResolvedValue(createMockDiscount())

      await expect(
        bulkGenerateCouponCodes('venue-123', {
          discountId: 'discount-123',
          quantity: 5,
          codeLength: 3, // Too short (< 4)
        }),
      ).rejects.toThrow(BadRequestError)
      await expect(
        bulkGenerateCouponCodes('venue-123', {
          discountId: 'discount-123',
          quantity: 5,
          codeLength: 3,
        }),
      ).rejects.toThrow('Code length must be between 4 and 20')
    })
  })

  // ==========================================
  // COUPON VALIDATION
  // ==========================================

  describe('validateCouponCode', () => {
    it('should return valid for active coupon', async () => {
      const mockCoupon = {
        ...createMockCoupon(),
        discount: createMockDiscount(),
        _count: { redemptions: 5 },
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(mockCoupon)

      const result = await validateCouponCode('venue-123', 'SUMMER10')

      expect(result.valid).toBe(true)
      expect(result.coupon?.code).toBe('SUMMER10')
      expect(result.coupon?.discount.value).toBe(10)
    })

    it('should return NOT_FOUND for non-existent coupon', async () => {
      prismaMock.couponCode.findFirst.mockResolvedValue(null)

      const result = await validateCouponCode('venue-123', 'INVALID')

      expect(result.valid).toBe(false)
      expect(result.errorCode).toBe('NOT_FOUND')
      expect(result.error).toBe('Coupon code not found')
    })

    it('should return INACTIVE for inactive coupon', async () => {
      const mockCoupon = {
        ...createMockCoupon({ active: false }),
        discount: createMockDiscount(),
        _count: { redemptions: 0 },
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(mockCoupon)

      const result = await validateCouponCode('venue-123', 'SUMMER10')

      expect(result.valid).toBe(false)
      expect(result.errorCode).toBe('INACTIVE')
    })

    it('should return INACTIVE for inactive discount', async () => {
      const mockCoupon = {
        ...createMockCoupon(),
        discount: createMockDiscount({ active: false }),
        _count: { redemptions: 0 },
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(mockCoupon)

      const result = await validateCouponCode('venue-123', 'SUMMER10')

      expect(result.valid).toBe(false)
      expect(result.errorCode).toBe('INACTIVE')
      expect(result.error).toBe('Discount associated with this coupon is inactive')
    })

    it('should return EXPIRED for expired coupon', async () => {
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)

      const mockCoupon = {
        ...createMockCoupon({ validUntil: yesterday }),
        discount: createMockDiscount(),
        _count: { redemptions: 0 },
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(mockCoupon)

      const result = await validateCouponCode('venue-123', 'SUMMER10')

      expect(result.valid).toBe(false)
      expect(result.errorCode).toBe('EXPIRED')
    })

    it('should return NOT_STARTED for coupon not yet valid', async () => {
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)

      const mockCoupon = {
        ...createMockCoupon({ validFrom: tomorrow }),
        discount: createMockDiscount(),
        _count: { redemptions: 0 },
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(mockCoupon)

      const result = await validateCouponCode('venue-123', 'SUMMER10')

      expect(result.valid).toBe(false)
      expect(result.errorCode).toBe('NOT_STARTED')
    })

    it('should return USAGE_LIMIT when maxUses reached', async () => {
      const mockCoupon = {
        ...createMockCoupon({ maxUses: 10, currentUses: 10 }),
        discount: createMockDiscount(),
        _count: { redemptions: 10 },
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(mockCoupon)

      const result = await validateCouponCode('venue-123', 'SUMMER10')

      expect(result.valid).toBe(false)
      expect(result.errorCode).toBe('USAGE_LIMIT')
    })

    it('should return MIN_PURCHASE when order total below minimum', async () => {
      const mockCoupon = {
        ...createMockCoupon({ minPurchaseAmount: new Decimal(100) }),
        discount: createMockDiscount(),
        _count: { redemptions: 0 },
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(mockCoupon)

      const result = await validateCouponCode('venue-123', 'SUMMER10', 50) // Order total = 50

      expect(result.valid).toBe(false)
      expect(result.errorCode).toBe('MIN_PURCHASE')
      expect(result.error).toBe('Minimum purchase of 100 required')
    })

    it('should return CUSTOMER_LIMIT when per-customer limit reached', async () => {
      const mockCoupon = {
        ...createMockCoupon({ maxUsesPerCustomer: 2 }),
        discount: createMockDiscount(),
        _count: { redemptions: 5 },
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(mockCoupon)
      prismaMock.couponRedemption.count.mockResolvedValue(2) // Customer used it twice

      const result = await validateCouponCode('venue-123', 'SUMMER10', undefined, 'customer-123')

      expect(result.valid).toBe(false)
      expect(result.errorCode).toBe('CUSTOMER_LIMIT')
      expect(result.error).toBe('You have already used this coupon 2 time(s)')
    })

    it('should normalize code to uppercase', async () => {
      const mockCoupon = {
        ...createMockCoupon({ code: 'SUMMER10' }),
        discount: createMockDiscount(),
        _count: { redemptions: 0 },
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(mockCoupon)

      await validateCouponCode('venue-123', 'summer10') // Lowercase input

      expect(prismaMock.couponCode.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            code: 'SUMMER10', // Normalized to uppercase
          }),
        }),
      )
    })
  })

  // ==========================================
  // COUPON REDEMPTION
  // ==========================================

  describe('recordCouponRedemption', () => {
    it('should record redemption successfully', async () => {
      const mockCoupon = {
        ...createMockCoupon(),
        discountId: 'discount-123',
        discount: createMockDiscount(),
      }
      const mockOrder = { id: 'order-123', venueId: 'venue-123' }
      const mockRedemption = {
        id: 'redemption-123',
        couponCodeId: 'coupon-123',
        orderId: 'order-123',
        customerId: 'customer-123',
        amountSaved: new Decimal(10),
        redeemedAt: new Date(),
        couponCode: { id: 'coupon-123', code: 'SUMMER10' },
        customer: { id: 'customer-123', firstName: 'John', lastName: 'Doe' },
      }

      prismaMock.couponCode.findFirst.mockResolvedValue(mockCoupon)
      prismaMock.order.findFirst.mockResolvedValue(mockOrder)
      prismaMock.couponRedemption.findUnique.mockResolvedValue(null) // No existing redemption
      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
      prismaMock.couponRedemption.create.mockResolvedValue(mockRedemption)
      prismaMock.couponCode.update.mockResolvedValue(mockCoupon)
      prismaMock.discount.update.mockResolvedValue(createMockDiscount())

      const result = await recordCouponRedemption('venue-123', 'coupon-123', 'order-123', 10, 'customer-123')

      expect(result.amountSaved).toBe(10)
    })

    it('should throw NotFoundError if coupon does not exist', async () => {
      prismaMock.couponCode.findFirst.mockResolvedValue(null)

      await expect(recordCouponRedemption('venue-123', 'nonexistent', 'order-123', 10)).rejects.toThrow(NotFoundError)
    })

    it('should throw NotFoundError if order does not exist', async () => {
      prismaMock.couponCode.findFirst.mockResolvedValue({
        ...createMockCoupon(),
        discount: createMockDiscount(),
      })
      prismaMock.order.findFirst.mockResolvedValue(null)

      await expect(recordCouponRedemption('venue-123', 'coupon-123', 'nonexistent', 10)).rejects.toThrow(NotFoundError)
    })

    it('should throw BadRequestError if order already has redemption', async () => {
      prismaMock.couponCode.findFirst.mockResolvedValue({
        ...createMockCoupon(),
        discount: createMockDiscount(),
      })
      prismaMock.order.findFirst.mockResolvedValue({ id: 'order-123', venueId: 'venue-123' })
      prismaMock.couponRedemption.findUnique.mockResolvedValue({
        id: 'existing-redemption',
        orderId: 'order-123',
      })

      await expect(recordCouponRedemption('venue-123', 'coupon-123', 'order-123', 10)).rejects.toThrow(BadRequestError)
      await expect(recordCouponRedemption('venue-123', 'coupon-123', 'order-123', 10)).rejects.toThrow(
        'This order already has a coupon redemption',
      )
    })
  })

  describe('getCouponRedemptions', () => {
    it('should return paginated redemptions', async () => {
      const mockRedemptions = [
        {
          id: 'r1',
          couponCodeId: 'coupon-1',
          amountSaved: new Decimal(10),
          redeemedAt: new Date(),
          couponCode: {
            id: 'coupon-1',
            code: 'CODE1',
            discount: { id: 'd1', name: 'Discount 1', type: 'PERCENTAGE' },
          },
          customer: { id: 'c1', firstName: 'John', lastName: 'Doe', email: 'john@test.com' },
          order: { id: 'o1', total: new Decimal(100), createdAt: new Date() },
        },
      ]

      prismaMock.couponRedemption.count.mockResolvedValue(1)
      prismaMock.couponRedemption.findMany.mockResolvedValue(mockRedemptions)

      const result = await getCouponRedemptions('venue-123')

      expect(result.data).toHaveLength(1)
      expect(result.data[0].amountSaved).toBe(10)
      expect(result.data[0].order?.total).toBe(100)
    })

    it('should filter by couponId', async () => {
      prismaMock.couponRedemption.count.mockResolvedValue(0)
      prismaMock.couponRedemption.findMany.mockResolvedValue([])

      await getCouponRedemptions('venue-123', 1, 20, 'coupon-123')

      expect(prismaMock.couponRedemption.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            couponCodeId: 'coupon-123',
          }),
        }),
      )
    })

    it('should filter by customerId', async () => {
      prismaMock.couponRedemption.count.mockResolvedValue(0)
      prismaMock.couponRedemption.findMany.mockResolvedValue([])

      await getCouponRedemptions('venue-123', 1, 20, undefined, 'customer-123')

      expect(prismaMock.couponRedemption.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            customerId: 'customer-123',
          }),
        }),
      )
    })
  })

  // ==========================================
  // COUPON STATISTICS
  // ==========================================

  describe('getCouponStats', () => {
    it('should return correct statistics', async () => {
      prismaMock.couponCode.count
        .mockResolvedValueOnce(20) // totalCoupons
        .mockResolvedValueOnce(15) // activeCoupons

      prismaMock.couponRedemption.findMany.mockResolvedValue([
        { amountSaved: new Decimal(10), couponCodeId: 'c1' },
        { amountSaved: new Decimal(15), couponCodeId: 'c1' },
        { amountSaved: new Decimal(5), couponCodeId: 'c2' },
      ])

      prismaMock.couponCode.findMany.mockResolvedValue([
        { id: 'c1', code: 'CODE1', currentUses: 2, discount: { name: 'Discount 1' } },
        { id: 'c2', code: 'CODE2', currentUses: 1, discount: { name: 'Discount 2' } },
      ])

      const result = await getCouponStats('venue-123')

      expect(result.totalCoupons).toBe(20)
      expect(result.activeCoupons).toBe(15)
      expect(result.totalRedemptions).toBe(3)
      expect(result.totalSaved).toBe(30) // 10 + 15 + 5
      expect(result.averageSavings).toBe(10) // 30 / 3
      expect(result.topCoupons).toHaveLength(2)
    })

    it('should handle empty statistics', async () => {
      prismaMock.couponCode.count.mockResolvedValue(0)
      prismaMock.couponRedemption.findMany.mockResolvedValue([])
      prismaMock.couponCode.findMany.mockResolvedValue([])

      const result = await getCouponStats('venue-123')

      expect(result.totalCoupons).toBe(0)
      expect(result.totalRedemptions).toBe(0)
      expect(result.averageSavings).toBe(0) // No division by zero
    })
  })
})
