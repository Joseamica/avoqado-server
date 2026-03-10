// Shared Stripe mock instance — must be created before imports so the service
// captures the same object when it runs `new Stripe(...)` at module load time.
const mockStripeInstance = {
  products: {
    create: jest.fn().mockResolvedValue({ id: 'prod_test123' }),
  },
  prices: {
    create: jest.fn().mockResolvedValue({ id: 'price_test123' }),
    update: jest.fn().mockResolvedValue({}),
  },
}

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => mockStripeInstance)
})

import {
  getCreditPacks,
  getCreditPackById,
  createCreditPack,
  updateCreditPack,
  deactivateCreditPack,
  getCustomerPurchases,
  getTransactionHistory,
  redeemItemManually,
  adjustItemBalance,
  refundPurchase,
} from '../../../../src/services/dashboard/creditPack.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'
import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'
import { CreditPurchaseStatus, CreditTransactionType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

// ==========================================
// MOCK HELPERS
// ==========================================

const createMockPack = (overrides: Record<string, any> = {}) => ({
  id: 'pack-123',
  venueId: 'venue-123',
  name: 'Pack Fitness Premium',
  description: 'Pack de clases y productos',
  price: new Decimal(600),
  currency: 'MXN',
  validityDays: 90,
  maxPerCustomer: null,
  active: true,
  displayOrder: 0,
  stripeProductId: 'prod_test',
  stripePriceId: 'price_test',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ...overrides,
})

const createMockPackItem = (overrides: Record<string, any> = {}) => ({
  id: 'item-123',
  creditPackId: 'pack-123',
  productId: 'product-123',
  quantity: 10,
  ...overrides,
})

const createMockPurchase = (overrides: Record<string, any> = {}) => ({
  id: 'purchase-123',
  venueId: 'venue-123',
  customerId: 'customer-123',
  creditPackId: 'pack-123',
  purchasedAt: new Date('2026-02-01'),
  expiresAt: new Date('2026-05-01'),
  status: 'ACTIVE' as const,
  stripeCheckoutSessionId: 'cs_test_123',
  stripePaymentIntentId: 'pi_test_123',
  amountPaid: new Decimal(600),
  createdAt: new Date('2026-02-01'),
  updatedAt: new Date('2026-02-01'),
  ...overrides,
})

const createMockBalance = (overrides: Record<string, any> = {}) => ({
  id: 'balance-123',
  creditPackPurchaseId: 'purchase-123',
  creditPackItemId: 'item-123',
  productId: 'product-123',
  originalQuantity: 10,
  remainingQuantity: 7,
  ...overrides,
})

const createMockTransaction = (overrides: Record<string, any> = {}) => ({
  id: 'tx-123',
  venueId: 'venue-123',
  customerId: 'customer-123',
  creditPackPurchaseId: 'purchase-123',
  creditItemBalanceId: 'balance-123',
  type: 'REDEEM' as const,
  quantity: -1,
  reason: null,
  createdById: 'staff-123',
  createdAt: new Date('2026-02-15'),
  ...overrides,
})

const createMockCustomer = (overrides: Record<string, any> = {}) => ({
  id: 'customer-123',
  firstName: 'Juan',
  lastName: 'Garcia',
  email: 'juan@example.com',
  phone: '+5215512345678',
  ...overrides,
})

describe('Credit Pack Dashboard Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ==========================================
  // getCreditPacks
  // ==========================================

  describe('getCreditPacks', () => {
    it('should return all packs for a venue with items and product details', async () => {
      const mockProduct = { id: 'product-123', name: 'Clase de Yoga', type: 'SERVICE', price: new Decimal(150), imageUrl: null }
      const mockPacks = [
        createMockPack({
          items: [createMockPackItem({ product: mockProduct })],
          _count: { purchases: 3 },
        }),
        createMockPack({
          id: 'pack-456',
          name: 'Pack Basico',
          displayOrder: 1,
          items: [createMockPackItem({ id: 'item-456', creditPackId: 'pack-456', product: mockProduct })],
          _count: { purchases: 0 },
        }),
      ]

      prismaMock.creditPack.findMany.mockResolvedValue(mockPacks)

      const result = await getCreditPacks('venue-123')

      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('Pack Fitness Premium')
      expect(result[0].items).toHaveLength(1)
      expect(result[0].items[0].product.name).toBe('Clase de Yoga')
      expect(result[0]._count.purchases).toBe(3)
      expect(result[1].name).toBe('Pack Basico')
      expect(prismaMock.creditPack.findMany).toHaveBeenCalledWith({
        where: { venueId: 'venue-123' },
        include: {
          items: {
            include: {
              product: {
                select: { id: true, name: true, type: true, price: true, imageUrl: true },
              },
            },
          },
          _count: { select: { purchases: true } },
        },
        orderBy: { displayOrder: 'asc' },
      })
    })

    it('should return empty array when no packs exist', async () => {
      prismaMock.creditPack.findMany.mockResolvedValue([])

      const result = await getCreditPacks('venue-123')

      expect(result).toEqual([])
      expect(prismaMock.creditPack.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: 'venue-123' },
        }),
      )
    })

    it('should order by displayOrder', async () => {
      prismaMock.creditPack.findMany.mockResolvedValue([])

      await getCreditPacks('venue-123')

      expect(prismaMock.creditPack.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { displayOrder: 'asc' },
        }),
      )
    })
  })

  // ==========================================
  // getCreditPackById
  // ==========================================

  describe('getCreditPackById', () => {
    it('should return pack with items and purchase count', async () => {
      const mockProduct = { id: 'product-123', name: 'Clase de Yoga', type: 'SERVICE', price: new Decimal(150), imageUrl: null }
      const mockPack = createMockPack({
        items: [createMockPackItem({ product: mockProduct })],
        _count: { purchases: 5 },
      })

      prismaMock.creditPack.findFirst.mockResolvedValue(mockPack)

      const result = await getCreditPackById('venue-123', 'pack-123')

      expect(result.id).toBe('pack-123')
      expect(result.name).toBe('Pack Fitness Premium')
      expect(result.items).toHaveLength(1)
      expect(result._count.purchases).toBe(5)
      expect(prismaMock.creditPack.findFirst).toHaveBeenCalledWith({
        where: { id: 'pack-123', venueId: 'venue-123' },
        include: {
          items: {
            include: {
              product: {
                select: { id: true, name: true, type: true, price: true, imageUrl: true },
              },
            },
          },
          _count: { select: { purchases: true } },
        },
      })
    })

    it('should throw NotFoundError when pack does not exist', async () => {
      prismaMock.creditPack.findFirst.mockResolvedValue(null)

      await expect(getCreditPackById('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
      await expect(getCreditPackById('venue-123', 'nonexistent')).rejects.toThrow('Paquete de creditos no encontrado')
    })

    it('should throw NotFoundError when pack belongs to different venue', async () => {
      // findFirst with { id, venueId } won't find a pack that belongs to another venue
      prismaMock.creditPack.findFirst.mockResolvedValue(null)

      await expect(getCreditPackById('other-venue', 'pack-123')).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================
  // createCreditPack
  // ==========================================

  describe('createCreditPack', () => {
    const createData = {
      name: 'Pack Fitness Premium',
      description: 'Pack de clases y productos',
      price: 600,
      currency: 'MXN',
      validityDays: 90,
      items: [
        { productId: 'product-123', quantity: 10 },
        { productId: 'product-456', quantity: 5 },
      ],
    }

    it('should create pack with items and Stripe product/price', async () => {
      const mockProduct = { id: 'product-123', name: 'Clase de Yoga', type: 'SERVICE', price: new Decimal(150), imageUrl: null }
      const expectedPack = createMockPack({
        stripeProductId: 'prod_test123',
        stripePriceId: 'price_test123',
        items: [
          createMockPackItem({ product: mockProduct }),
          createMockPackItem({ id: 'item-456', productId: 'product-456', product: { ...mockProduct, id: 'product-456', name: 'Batido' } }),
        ],
      })

      prismaMock.product.findMany.mockResolvedValue([{ id: 'product-123' }, { id: 'product-456' }])
      prismaMock.creditPack.create.mockResolvedValue(expectedPack)

      const result = await createCreditPack('venue-123', createData)

      expect(result.id).toBe('pack-123')
      expect(result.stripeProductId).toBe('prod_test123')
      expect(result.stripePriceId).toBe('price_test123')
      expect(result.items).toHaveLength(2)

      // Verify product validation query
      expect(prismaMock.product.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['product-123', 'product-456'] }, venueId: 'venue-123', active: true },
        select: { id: true },
      })

      // Verify pack creation call
      expect(prismaMock.creditPack.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          venueId: 'venue-123',
          name: 'Pack Fitness Premium',
          stripeProductId: 'prod_test123',
          stripePriceId: 'price_test123',
          items: {
            create: [
              { productId: 'product-123', quantity: 10 },
              { productId: 'product-456', quantity: 5 },
            ],
          },
        }),
        include: expect.objectContaining({
          items: expect.any(Object),
        }),
      })
    })

    it('should validate all products exist in venue', async () => {
      prismaMock.product.findMany.mockResolvedValue([{ id: 'product-123' }, { id: 'product-456' }])
      prismaMock.creditPack.create.mockResolvedValue(createMockPack())

      await createCreditPack('venue-123', createData)

      expect(prismaMock.product.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['product-123', 'product-456'] }, venueId: 'venue-123', active: true },
        select: { id: true },
      })
    })

    it('should throw BadRequestError if product does not exist', async () => {
      // Only one product found when two were requested
      prismaMock.product.findMany.mockResolvedValue([{ id: 'product-123' }])

      await expect(createCreditPack('venue-123', createData)).rejects.toThrow(BadRequestError)
      await expect(createCreditPack('venue-123', createData)).rejects.toThrow(
        'Uno o mas productos no existen o no estan activos en este venue',
      )
    })

    it('should throw BadRequestError for duplicate product IDs in items', async () => {
      const dataWithDuplicates = {
        ...createData,
        items: [
          { productId: 'product-123', quantity: 10 },
          { productId: 'product-123', quantity: 5 },
        ],
      }

      // The productIds array is ['product-123', 'product-123'] (length 2).
      // Prisma findMany with `in:` deduplicates, so only 1 product is returned.
      // This means the products.length check (1 !== 2) fires BEFORE the duplicate check.
      // So the error is about missing products, not about duplicates.
      prismaMock.product.findMany.mockResolvedValue([{ id: 'product-123' }])

      await expect(createCreditPack('venue-123', dataWithDuplicates)).rejects.toThrow(BadRequestError)

      // However, if the DB somehow returns the right count (e.g., mock returns 2),
      // the duplicate check catches it. Let's test that path:
      prismaMock.product.findMany.mockResolvedValue([{ id: 'product-123' }, { id: 'product-123' }])

      await expect(createCreditPack('venue-123', dataWithDuplicates)).rejects.toThrow(BadRequestError)
      await expect(createCreditPack('venue-123', dataWithDuplicates)).rejects.toThrow(
        'No se puede incluir el mismo producto mas de una vez en un paquete',
      )
    })

    it('should handle Stripe failure gracefully (create pack without stripe IDs)', async () => {
      // Make the Stripe product creation fail
      mockStripeInstance.products.create.mockRejectedValueOnce(new Error('Stripe API error'))

      prismaMock.product.findMany.mockResolvedValue([{ id: 'product-123' }, { id: 'product-456' }])
      const expectedPack = createMockPack({
        stripeProductId: undefined,
        stripePriceId: undefined,
      })
      prismaMock.creditPack.create.mockResolvedValue(expectedPack)

      const result = await createCreditPack('venue-123', createData)

      expect(result).toBeDefined()
      // Pack should be created even when Stripe fails
      expect(prismaMock.creditPack.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venueId: 'venue-123',
            name: 'Pack Fitness Premium',
          }),
        }),
      )
    })

    it('should use Decimal for price', async () => {
      prismaMock.product.findMany.mockResolvedValue([{ id: 'product-123' }, { id: 'product-456' }])
      prismaMock.creditPack.create.mockResolvedValue(createMockPack())

      await createCreditPack('venue-123', createData)

      const createCall = prismaMock.creditPack.create.mock.calls[0][0]
      expect(createCall.data.price).toBeInstanceOf(Decimal)
      expect(createCall.data.price.toNumber()).toBe(600)
    })

    it('should default currency to MXN if not provided', async () => {
      const dataWithoutCurrency = { ...createData, currency: undefined }
      prismaMock.product.findMany.mockResolvedValue([{ id: 'product-123' }, { id: 'product-456' }])
      prismaMock.creditPack.create.mockResolvedValue(createMockPack())

      await createCreditPack('venue-123', dataWithoutCurrency)

      const createCall = prismaMock.creditPack.create.mock.calls[0][0]
      expect(createCall.data.currency).toBe('MXN')
    })

    it('should default displayOrder to 0 if not provided', async () => {
      const dataWithoutOrder = { ...createData, displayOrder: undefined }
      prismaMock.product.findMany.mockResolvedValue([{ id: 'product-123' }, { id: 'product-456' }])
      prismaMock.creditPack.create.mockResolvedValue(createMockPack())

      await createCreditPack('venue-123', dataWithoutOrder)

      const createCall = prismaMock.creditPack.create.mock.calls[0][0]
      expect(createCall.data.displayOrder).toBe(0)
    })
  })

  // ==========================================
  // updateCreditPack
  // ==========================================

  describe('updateCreditPack', () => {
    it('should update basic fields (name, description, price)', async () => {
      const existing = createMockPack({
        stripeProductId: 'prod_test',
        stripePriceId: 'price_test',
        price: new Decimal(600),
      })
      prismaMock.creditPack.findFirst.mockResolvedValue(existing)

      const updatedPack = createMockPack({
        name: 'Pack Premium Actualizado',
        description: 'Descripcion actualizada',
        price: new Decimal(600),
      })
      prismaMock.creditPack.update.mockResolvedValue(updatedPack)

      const result = await updateCreditPack('venue-123', 'pack-123', {
        name: 'Pack Premium Actualizado',
        description: 'Descripcion actualizada',
      })

      expect(result.name).toBe('Pack Premium Actualizado')
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should throw NotFoundError when pack does not exist', async () => {
      prismaMock.creditPack.findFirst.mockResolvedValue(null)

      await expect(updateCreditPack('venue-123', 'nonexistent', { name: 'Updated' })).rejects.toThrow(NotFoundError)
      await expect(updateCreditPack('venue-123', 'nonexistent', { name: 'Updated' })).rejects.toThrow('Paquete de creditos no encontrado')
    })

    it('should create new Stripe price when price changes', async () => {
      const existing = createMockPack({
        price: new Decimal(600),
        stripeProductId: 'prod_test',
        stripePriceId: 'price_old',
      })
      prismaMock.creditPack.findFirst.mockResolvedValue(existing)

      const updatedPack = createMockPack({ price: new Decimal(750), stripePriceId: 'price_test123' })
      prismaMock.creditPack.update.mockResolvedValue(updatedPack)

      await updateCreditPack('venue-123', 'pack-123', { price: 750 })

      // The service creates a new Stripe price
      expect(mockStripeInstance.prices.create).toHaveBeenCalledWith({
        product: 'prod_test',
        unit_amount: 75000,
        currency: 'mxn',
        metadata: { type: 'credit_pack', venueId: 'venue-123' },
      })

      // The service archives the old price
      expect(mockStripeInstance.prices.update).toHaveBeenCalledWith('price_old', { active: false })
    })

    it('should replace items when items array provided', async () => {
      const existing = createMockPack()
      prismaMock.creditPack.findFirst.mockResolvedValue(existing)

      prismaMock.product.findMany.mockResolvedValue([{ id: 'product-789' }])
      prismaMock.creditPackItem.deleteMany.mockResolvedValue({ count: 1 })
      prismaMock.creditPackItem.create.mockResolvedValue(createMockPackItem({ productId: 'product-789', quantity: 20 }))

      const updatedPack = createMockPack()
      prismaMock.creditPack.update.mockResolvedValue(updatedPack)

      await updateCreditPack('venue-123', 'pack-123', {
        items: [{ productId: 'product-789', quantity: 20 }],
      })

      // Should delete existing items
      expect(prismaMock.creditPackItem.deleteMany).toHaveBeenCalledWith({
        where: { creditPackId: 'pack-123' },
      })

      // Should create new items
      expect(prismaMock.creditPackItem.create).toHaveBeenCalledWith({
        data: {
          creditPackId: 'pack-123',
          productId: 'product-789',
          quantity: 20,
        },
      })
    })

    it('should validate new items products exist', async () => {
      const existing = createMockPack()
      prismaMock.creditPack.findFirst.mockResolvedValue(existing)

      // Product not found -> length mismatch
      prismaMock.product.findMany.mockResolvedValue([])

      await expect(
        updateCreditPack('venue-123', 'pack-123', {
          items: [{ productId: 'nonexistent', quantity: 5 }],
        }),
      ).rejects.toThrow(BadRequestError)

      await expect(
        updateCreditPack('venue-123', 'pack-123', {
          items: [{ productId: 'nonexistent', quantity: 5 }],
        }),
      ).rejects.toThrow('Uno o mas productos no existen o no estan activos en este venue')
    })

    it('should not create Stripe price when price does not change', async () => {
      const existing = createMockPack({ price: new Decimal(600), stripeProductId: 'prod_test', stripePriceId: 'price_test' })
      prismaMock.creditPack.findFirst.mockResolvedValue(existing)

      const updatedPack = createMockPack({ name: 'Same Price' })
      prismaMock.creditPack.update.mockResolvedValue(updatedPack)

      mockStripeInstance.prices.create.mockClear()

      await updateCreditPack('venue-123', 'pack-123', { name: 'Same Price' })

      expect(mockStripeInstance.prices.create).not.toHaveBeenCalled()
    })

    it('should use Decimal for updated price', async () => {
      const existing = createMockPack({ price: new Decimal(600), stripeProductId: 'prod_test' })
      prismaMock.creditPack.findFirst.mockResolvedValue(existing)
      prismaMock.creditPack.update.mockResolvedValue(createMockPack({ price: new Decimal(750) }))

      await updateCreditPack('venue-123', 'pack-123', { price: 750 })

      const updateCall = prismaMock.creditPack.update.mock.calls[0][0]
      expect(updateCall.data.price).toBeInstanceOf(Decimal)
      expect(updateCall.data.price.toNumber()).toBe(750)
    })
  })

  // ==========================================
  // deactivateCreditPack
  // ==========================================

  describe('deactivateCreditPack', () => {
    it('should set active=false', async () => {
      const mockPack = createMockPack()
      prismaMock.creditPack.findFirst.mockResolvedValue(mockPack)

      const deactivatedPack = createMockPack({ active: false })
      prismaMock.creditPack.update.mockResolvedValue(deactivatedPack)

      const result = await deactivateCreditPack('venue-123', 'pack-123')

      expect(result.active).toBe(false)
      expect(prismaMock.creditPack.update).toHaveBeenCalledWith({
        where: { id: 'pack-123' },
        data: { active: false },
      })
    })

    it('should throw NotFoundError when pack does not exist', async () => {
      prismaMock.creditPack.findFirst.mockResolvedValue(null)

      await expect(deactivateCreditPack('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
      await expect(deactivateCreditPack('venue-123', 'nonexistent')).rejects.toThrow('Paquete de creditos no encontrado')
    })

    it('should scope lookup by venueId', async () => {
      prismaMock.creditPack.findFirst.mockResolvedValue(null)

      await expect(deactivateCreditPack('venue-123', 'pack-123')).rejects.toThrow(NotFoundError)

      expect(prismaMock.creditPack.findFirst).toHaveBeenCalledWith({
        where: { id: 'pack-123', venueId: 'venue-123' },
      })
    })
  })

  // ==========================================
  // getCustomerPurchases
  // ==========================================

  describe('getCustomerPurchases', () => {
    it('should return paginated purchases with customer/balance details', async () => {
      const mockPurchases = [
        createMockPurchase({
          customer: createMockCustomer(),
          creditPack: { name: 'Pack Fitness Premium' },
          itemBalances: [
            createMockBalance({
              product: { id: 'product-123', name: 'Clase de Yoga', type: 'SERVICE' },
            }),
          ],
        }),
      ]

      prismaMock.creditPackPurchase.findMany.mockResolvedValue(mockPurchases)
      prismaMock.creditPackPurchase.count.mockResolvedValue(1)

      const result = await getCustomerPurchases('venue-123', {})

      expect(result.purchases).toHaveLength(1)
      expect(result.total).toBe(1)
      expect(result.page).toBe(1)
      expect(result.limit).toBe(20)
      expect(result.totalPages).toBe(1)
      expect(result.purchases[0].customer.firstName).toBe('Juan')
      expect(result.purchases[0].creditPack.name).toBe('Pack Fitness Premium')
      expect(result.purchases[0].itemBalances).toHaveLength(1)
    })

    it('should filter by customerId', async () => {
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([])
      prismaMock.creditPackPurchase.count.mockResolvedValue(0)

      await getCustomerPurchases('venue-123', { customerId: 'customer-456' })

      expect(prismaMock.creditPackPurchase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: 'venue-123', customerId: 'customer-456' },
        }),
      )
      expect(prismaMock.creditPackPurchase.count).toHaveBeenCalledWith({
        where: { venueId: 'venue-123', customerId: 'customer-456' },
      })
    })

    it('should filter by status', async () => {
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([])
      prismaMock.creditPackPurchase.count.mockResolvedValue(0)

      await getCustomerPurchases('venue-123', { status: CreditPurchaseStatus.ACTIVE })

      expect(prismaMock.creditPackPurchase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: 'venue-123', status: CreditPurchaseStatus.ACTIVE },
        }),
      )
    })

    it('should return correct pagination metadata', async () => {
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([])
      prismaMock.creditPackPurchase.count.mockResolvedValue(45)

      const result = await getCustomerPurchases('venue-123', { page: 2, limit: 10 })

      expect(result.page).toBe(2)
      expect(result.limit).toBe(10)
      expect(result.total).toBe(45)
      expect(result.totalPages).toBe(5) // Math.ceil(45 / 10)

      expect(prismaMock.creditPackPurchase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10, // (2-1) * 10
          take: 10,
        }),
      )
    })

    it('should default to page 1 and limit 20', async () => {
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([])
      prismaMock.creditPackPurchase.count.mockResolvedValue(0)

      const result = await getCustomerPurchases('venue-123', {})

      expect(result.page).toBe(1)
      expect(result.limit).toBe(20)
      expect(prismaMock.creditPackPurchase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20,
        }),
      )
    })

    it('should order by purchasedAt descending', async () => {
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([])
      prismaMock.creditPackPurchase.count.mockResolvedValue(0)

      await getCustomerPurchases('venue-123', {})

      expect(prismaMock.creditPackPurchase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { purchasedAt: 'desc' },
        }),
      )
    })
  })

  // ==========================================
  // getTransactionHistory
  // ==========================================

  describe('getTransactionHistory', () => {
    it('should return paginated transactions', async () => {
      const mockTransactions = [
        createMockTransaction({
          customer: createMockCustomer(),
          creditItemBalance: {
            product: { id: 'product-123', name: 'Clase de Yoga' },
          },
          creditPackPurchase: {
            creditPack: { name: 'Pack Fitness Premium' },
          },
          createdBy: {
            staff: { firstName: 'Admin', lastName: 'Staff' },
          },
        }),
      ]

      prismaMock.creditTransaction.findMany.mockResolvedValue(mockTransactions)
      prismaMock.creditTransaction.count.mockResolvedValue(1)

      const result = await getTransactionHistory('venue-123', {})

      expect(result.transactions).toHaveLength(1)
      expect(result.total).toBe(1)
      expect(result.page).toBe(1)
      expect(result.limit).toBe(20)
      expect(result.totalPages).toBe(1)
    })

    it('should filter by customerId', async () => {
      prismaMock.creditTransaction.findMany.mockResolvedValue([])
      prismaMock.creditTransaction.count.mockResolvedValue(0)

      await getTransactionHistory('venue-123', { customerId: 'customer-456' })

      expect(prismaMock.creditTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: 'venue-123', customerId: 'customer-456' },
        }),
      )
    })

    it('should filter by type', async () => {
      prismaMock.creditTransaction.findMany.mockResolvedValue([])
      prismaMock.creditTransaction.count.mockResolvedValue(0)

      await getTransactionHistory('venue-123', { type: CreditTransactionType.REDEEM })

      expect(prismaMock.creditTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: 'venue-123', type: CreditTransactionType.REDEEM },
        }),
      )
    })

    it('should return correct pagination metadata', async () => {
      prismaMock.creditTransaction.findMany.mockResolvedValue([])
      prismaMock.creditTransaction.count.mockResolvedValue(55)

      const result = await getTransactionHistory('venue-123', { page: 3, limit: 15 })

      expect(result.page).toBe(3)
      expect(result.limit).toBe(15)
      expect(result.total).toBe(55)
      expect(result.totalPages).toBe(4) // Math.ceil(55 / 15)
      expect(prismaMock.creditTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 30, // (3-1) * 15
          take: 15,
        }),
      )
    })

    it('should order by createdAt descending', async () => {
      prismaMock.creditTransaction.findMany.mockResolvedValue([])
      prismaMock.creditTransaction.count.mockResolvedValue(0)

      await getTransactionHistory('venue-123', {})

      expect(prismaMock.creditTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        }),
      )
    })

    it('should include related customer, balance, purchase, and createdBy', async () => {
      prismaMock.creditTransaction.findMany.mockResolvedValue([])
      prismaMock.creditTransaction.count.mockResolvedValue(0)

      await getTransactionHistory('venue-123', {})

      expect(prismaMock.creditTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            customer: {
              select: { id: true, firstName: true, lastName: true, email: true, phone: true },
            },
            creditItemBalance: {
              include: {
                product: { select: { id: true, name: true } },
              },
            },
            creditPackPurchase: {
              select: { creditPack: { select: { name: true } } },
            },
            createdBy: {
              select: { staff: { select: { firstName: true, lastName: true } } },
            },
          },
        }),
      )
    })
  })

  // ==========================================
  // redeemItemManually
  // ==========================================

  describe('redeemItemManually', () => {
    it('should decrement balance and create REDEEM transaction', async () => {
      const mockBalance = createMockBalance({
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
          expiresAt: new Date('2026-05-01'),
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      const mockTransaction = createMockTransaction()
      prismaMock.creditTransaction.create.mockResolvedValue(mockTransaction)
      prismaMock.creditItemBalance.update.mockResolvedValue({
        ...mockBalance,
        remainingQuantity: 6,
      })

      // Still has remaining balances
      prismaMock.creditItemBalance.findMany.mockResolvedValue([createMockBalance({ remainingQuantity: 6 })])

      const result = await redeemItemManually('venue-123', 'balance-123', 'staff-123', 'Cliente presente')

      expect(result).toEqual(mockTransaction)

      // Should decrement balance by 1
      expect(prismaMock.creditItemBalance.update).toHaveBeenCalledWith({
        where: { id: 'balance-123' },
        data: { remainingQuantity: { decrement: 1 } },
      })

      // Should create REDEEM transaction
      expect(prismaMock.creditTransaction.create).toHaveBeenCalledWith({
        data: {
          venueId: 'venue-123',
          customerId: 'customer-123',
          creditPackPurchaseId: 'purchase-123',
          creditItemBalanceId: 'balance-123',
          type: 'REDEEM',
          quantity: -1,
          reason: 'Cliente presente',
          createdById: 'staff-123',
        },
      })
    })

    it('should throw NotFoundError for invalid balance ID', async () => {
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(null)

      await expect(redeemItemManually('venue-123', 'nonexistent', 'staff-123')).rejects.toThrow(NotFoundError)
      await expect(redeemItemManually('venue-123', 'nonexistent', 'staff-123')).rejects.toThrow('Balance de credito no encontrado')
    })

    it('should throw BadRequestError when venue does not match', async () => {
      const mockBalance = createMockBalance({
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'other-venue',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
          expiresAt: null,
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      // The service throws NotFoundError when venueId doesn't match (to avoid leaking info)
      await expect(redeemItemManually('venue-123', 'balance-123', 'staff-123')).rejects.toThrow(NotFoundError)
      await expect(redeemItemManually('venue-123', 'balance-123', 'staff-123')).rejects.toThrow('Balance de credito no encontrado')
    })

    it('should throw BadRequestError when purchase is not ACTIVE', async () => {
      const mockBalance = createMockBalance({
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.EXHAUSTED,
          expiresAt: null,
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      await expect(redeemItemManually('venue-123', 'balance-123', 'staff-123')).rejects.toThrow(BadRequestError)
      await expect(redeemItemManually('venue-123', 'balance-123', 'staff-123')).rejects.toThrow('La compra de creditos ya no esta activa')
    })

    it('should throw BadRequestError when credits expired', async () => {
      const mockBalance = createMockBalance({
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
          expiresAt: new Date('2025-01-01'), // In the past
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      await expect(redeemItemManually('venue-123', 'balance-123', 'staff-123')).rejects.toThrow(BadRequestError)
      await expect(redeemItemManually('venue-123', 'balance-123', 'staff-123')).rejects.toThrow('Los creditos han expirado')
    })

    it('should throw BadRequestError when remaining quantity is 0', async () => {
      const mockBalance = createMockBalance({
        remainingQuantity: 0,
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
          expiresAt: new Date('2026-05-01'),
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      await expect(redeemItemManually('venue-123', 'balance-123', 'staff-123')).rejects.toThrow(BadRequestError)
      await expect(redeemItemManually('venue-123', 'balance-123', 'staff-123')).rejects.toThrow('No hay creditos disponibles para canjear')
    })

    it('should mark purchase as EXHAUSTED when all balances reach 0', async () => {
      const mockBalance = createMockBalance({
        remainingQuantity: 1, // Last credit
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
          expiresAt: new Date('2026-05-01'),
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      prismaMock.creditItemBalance.update.mockResolvedValue({ ...mockBalance, remainingQuantity: 0 })
      prismaMock.creditTransaction.create.mockResolvedValue(createMockTransaction())

      // No remaining balances with > 0
      prismaMock.creditItemBalance.findMany.mockResolvedValue([])

      await redeemItemManually('venue-123', 'balance-123', 'staff-123')

      expect(prismaMock.creditPackPurchase.update).toHaveBeenCalledWith({
        where: { id: 'purchase-123' },
        data: { status: CreditPurchaseStatus.EXHAUSTED },
      })
    })

    it('should NOT mark purchase as EXHAUSTED when other balances have remaining', async () => {
      const mockBalance = createMockBalance({
        remainingQuantity: 1,
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
          expiresAt: new Date('2026-05-01'),
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      prismaMock.creditItemBalance.update.mockResolvedValue({ ...mockBalance, remainingQuantity: 0 })
      prismaMock.creditTransaction.create.mockResolvedValue(createMockTransaction())

      // Other balances still have remaining
      prismaMock.creditItemBalance.findMany.mockResolvedValue([createMockBalance({ id: 'balance-other', remainingQuantity: 3 })])

      await redeemItemManually('venue-123', 'balance-123', 'staff-123')

      expect(prismaMock.creditPackPurchase.update).not.toHaveBeenCalled()
    })

    it('should use $transaction for atomicity', async () => {
      const mockBalance = createMockBalance({
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
          expiresAt: new Date('2026-05-01'),
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)
      prismaMock.creditTransaction.create.mockResolvedValue(createMockTransaction())
      prismaMock.creditItemBalance.findMany.mockResolvedValue([createMockBalance()])

      await redeemItemManually('venue-123', 'balance-123', 'staff-123')

      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should handle null expiresAt (no expiration)', async () => {
      const mockBalance = createMockBalance({
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
          expiresAt: null, // No expiration
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)
      prismaMock.creditTransaction.create.mockResolvedValue(createMockTransaction())
      prismaMock.creditItemBalance.findMany.mockResolvedValue([createMockBalance()])

      // Should not throw expiration error
      await expect(redeemItemManually('venue-123', 'balance-123', 'staff-123')).resolves.toBeDefined()
    })
  })

  // ==========================================
  // adjustItemBalance
  // ==========================================

  describe('adjustItemBalance', () => {
    it('should increment balance and create ADJUST transaction with positive quantity', async () => {
      const mockBalance = createMockBalance({
        remainingQuantity: 5,
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      const mockTransaction = createMockTransaction({ type: 'ADJUST', quantity: 3 })
      prismaMock.creditTransaction.create.mockResolvedValue(mockTransaction)
      prismaMock.creditItemBalance.update.mockResolvedValue({ ...mockBalance, remainingQuantity: 8 })

      const result = await adjustItemBalance('venue-123', 'balance-123', 3, 'Cortesia del gerente', 'staff-123')

      expect(result).toEqual(mockTransaction)

      expect(prismaMock.creditItemBalance.update).toHaveBeenCalledWith({
        where: { id: 'balance-123' },
        data: { remainingQuantity: { increment: 3 } },
      })

      expect(prismaMock.creditTransaction.create).toHaveBeenCalledWith({
        data: {
          venueId: 'venue-123',
          customerId: 'customer-123',
          creditPackPurchaseId: 'purchase-123',
          creditItemBalanceId: 'balance-123',
          type: 'ADJUST',
          quantity: 3,
          reason: 'Cortesia del gerente',
          createdById: 'staff-123',
        },
      })
    })

    it('should decrement balance and create ADJUST transaction with negative quantity', async () => {
      const mockBalance = createMockBalance({
        remainingQuantity: 7,
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      const mockTransaction = createMockTransaction({ type: 'ADJUST', quantity: -2 })
      prismaMock.creditTransaction.create.mockResolvedValue(mockTransaction)
      prismaMock.creditItemBalance.update.mockResolvedValue({ ...mockBalance, remainingQuantity: 5 })

      const result = await adjustItemBalance('venue-123', 'balance-123', -2, 'Correccion de error', 'staff-123')

      expect(result).toEqual(mockTransaction)

      expect(prismaMock.creditItemBalance.update).toHaveBeenCalledWith({
        where: { id: 'balance-123' },
        data: { remainingQuantity: { increment: -2 } },
      })

      expect(prismaMock.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'ADJUST',
          quantity: -2,
          reason: 'Correccion de error',
        }),
      })
    })

    it('should throw NotFoundError for invalid balance ID', async () => {
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(null)

      await expect(adjustItemBalance('venue-123', 'nonexistent', 1, 'reason', 'staff-123')).rejects.toThrow(NotFoundError)
      await expect(adjustItemBalance('venue-123', 'nonexistent', 1, 'reason', 'staff-123')).rejects.toThrow(
        'Balance de credito no encontrado',
      )
    })

    it('should throw BadRequestError if adjustment would make balance negative', async () => {
      const mockBalance = createMockBalance({
        remainingQuantity: 3,
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      await expect(adjustItemBalance('venue-123', 'balance-123', -5, 'Too much', 'staff-123')).rejects.toThrow(BadRequestError)
      await expect(adjustItemBalance('venue-123', 'balance-123', -5, 'Too much', 'staff-123')).rejects.toThrow(
        'no se permite balance negativo',
      )
    })

    it('should reactivate EXHAUSTED purchase when adding credits back', async () => {
      const mockBalance = createMockBalance({
        remainingQuantity: 0,
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.EXHAUSTED,
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      prismaMock.creditItemBalance.update.mockResolvedValue({ ...mockBalance, remainingQuantity: 5 })
      prismaMock.creditTransaction.create.mockResolvedValue(createMockTransaction({ type: 'ADJUST', quantity: 5 }))

      await adjustItemBalance('venue-123', 'balance-123', 5, 'Devolucion de creditos', 'staff-123')

      expect(prismaMock.creditPackPurchase.update).toHaveBeenCalledWith({
        where: { id: 'purchase-123' },
        data: { status: CreditPurchaseStatus.ACTIVE },
      })
    })

    it('should NOT reactivate purchase when status is not EXHAUSTED', async () => {
      const mockBalance = createMockBalance({
        remainingQuantity: 3,
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      prismaMock.creditItemBalance.update.mockResolvedValue({ ...mockBalance, remainingQuantity: 6 })
      prismaMock.creditTransaction.create.mockResolvedValue(createMockTransaction({ type: 'ADJUST', quantity: 3 }))

      await adjustItemBalance('venue-123', 'balance-123', 3, 'Bonus', 'staff-123')

      expect(prismaMock.creditPackPurchase.update).not.toHaveBeenCalled()
    })

    it('should throw NotFoundError when venue does not match', async () => {
      const mockBalance = createMockBalance({
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'other-venue',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

      await expect(adjustItemBalance('venue-123', 'balance-123', 1, 'reason', 'staff-123')).rejects.toThrow(NotFoundError)
    })

    it('should use $transaction for atomicity', async () => {
      const mockBalance = createMockBalance({
        remainingQuantity: 5,
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)
      prismaMock.creditTransaction.create.mockResolvedValue(createMockTransaction())

      await adjustItemBalance('venue-123', 'balance-123', 1, 'reason', 'staff-123')

      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should allow adjustment that brings balance exactly to 0', async () => {
      const mockBalance = createMockBalance({
        remainingQuantity: 3,
        creditPackPurchase: {
          id: 'purchase-123',
          venueId: 'venue-123',
          customerId: 'customer-123',
          status: CreditPurchaseStatus.ACTIVE,
        },
      })
      prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)
      prismaMock.creditTransaction.create.mockResolvedValue(createMockTransaction({ type: 'ADJUST', quantity: -3 }))

      // Should not throw — remaining 3 + (-3) = 0, which is valid
      await expect(adjustItemBalance('venue-123', 'balance-123', -3, 'Zero out', 'staff-123')).resolves.toBeDefined()
    })
  })

  // ==========================================
  // refundPurchase
  // ==========================================

  describe('refundPurchase', () => {
    it('should zero all balances and create REFUND transactions', async () => {
      const mockPurchase = createMockPurchase({
        itemBalances: [
          createMockBalance({ id: 'balance-1', remainingQuantity: 5 }),
          createMockBalance({ id: 'balance-2', remainingQuantity: 3, productId: 'product-456' }),
        ],
      })
      prismaMock.creditPackPurchase.findFirst.mockResolvedValue(mockPurchase)
      prismaMock.creditItemBalance.update.mockResolvedValue({})
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.creditPackPurchase.update.mockResolvedValue({})

      const result = await refundPurchase('venue-123', 'purchase-123', 'staff-123', 'Solicitud del cliente')

      expect(result).toEqual({ refunded: true, purchaseId: 'purchase-123' })

      // Should zero balance-1
      expect(prismaMock.creditItemBalance.update).toHaveBeenCalledWith({
        where: { id: 'balance-1' },
        data: { remainingQuantity: 0 },
      })

      // Should zero balance-2
      expect(prismaMock.creditItemBalance.update).toHaveBeenCalledWith({
        where: { id: 'balance-2' },
        data: { remainingQuantity: 0 },
      })

      // Should create REFUND transaction for balance-1
      expect(prismaMock.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          venueId: 'venue-123',
          customerId: 'customer-123',
          creditPackPurchaseId: 'purchase-123',
          creditItemBalanceId: 'balance-1',
          type: 'REFUND',
          quantity: -5,
          reason: 'Solicitud del cliente',
          createdById: 'staff-123',
        }),
      })

      // Should create REFUND transaction for balance-2
      expect(prismaMock.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          creditItemBalanceId: 'balance-2',
          type: 'REFUND',
          quantity: -3,
        }),
      })

      // Two balances with remaining > 0 → 2 updates and 2 transactions
      expect(prismaMock.creditItemBalance.update).toHaveBeenCalledTimes(2)
      expect(prismaMock.creditTransaction.create).toHaveBeenCalledTimes(2)
    })

    it('should mark purchase as REFUNDED', async () => {
      const mockPurchase = createMockPurchase({
        itemBalances: [createMockBalance({ remainingQuantity: 5 })],
      })
      prismaMock.creditPackPurchase.findFirst.mockResolvedValue(mockPurchase)
      prismaMock.creditItemBalance.update.mockResolvedValue({})
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.creditPackPurchase.update.mockResolvedValue({})

      await refundPurchase('venue-123', 'purchase-123', 'staff-123', 'Refund reason')

      expect(prismaMock.creditPackPurchase.update).toHaveBeenCalledWith({
        where: { id: 'purchase-123' },
        data: { status: CreditPurchaseStatus.REFUNDED },
      })
    })

    it('should throw NotFoundError for invalid purchase ID', async () => {
      prismaMock.creditPackPurchase.findFirst.mockResolvedValue(null)

      await expect(refundPurchase('venue-123', 'nonexistent', 'staff-123', 'reason')).rejects.toThrow(NotFoundError)
      await expect(refundPurchase('venue-123', 'nonexistent', 'staff-123', 'reason')).rejects.toThrow('Compra no encontrada')
    })

    it('should throw BadRequestError if already refunded', async () => {
      const mockPurchase = createMockPurchase({
        status: CreditPurchaseStatus.REFUNDED,
        itemBalances: [],
      })
      prismaMock.creditPackPurchase.findFirst.mockResolvedValue(mockPurchase)

      await expect(refundPurchase('venue-123', 'purchase-123', 'staff-123', 'reason')).rejects.toThrow(BadRequestError)
      await expect(refundPurchase('venue-123', 'purchase-123', 'staff-123', 'reason')).rejects.toThrow('Esta compra ya fue reembolsada')
    })

    it('should only create transactions for balances with remaining > 0', async () => {
      const mockPurchase = createMockPurchase({
        itemBalances: [
          createMockBalance({ id: 'balance-1', remainingQuantity: 5 }),
          createMockBalance({ id: 'balance-2', remainingQuantity: 0 }), // Already exhausted
          createMockBalance({ id: 'balance-3', remainingQuantity: 2 }),
        ],
      })
      prismaMock.creditPackPurchase.findFirst.mockResolvedValue(mockPurchase)
      prismaMock.creditItemBalance.update.mockResolvedValue({})
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.creditPackPurchase.update.mockResolvedValue({})

      await refundPurchase('venue-123', 'purchase-123', 'staff-123', 'Refund')

      // balance-2 has remaining 0, so no update or transaction for it
      expect(prismaMock.creditItemBalance.update).toHaveBeenCalledTimes(2)
      expect(prismaMock.creditTransaction.create).toHaveBeenCalledTimes(2)

      // Verify only balance-1 and balance-3 were processed
      const updateCalls = prismaMock.creditItemBalance.update.mock.calls.map((c: any[]) => c[0].where.id)
      expect(updateCalls).toContain('balance-1')
      expect(updateCalls).toContain('balance-3')
      expect(updateCalls).not.toContain('balance-2')
    })

    it('should use $transaction for atomicity', async () => {
      const mockPurchase = createMockPurchase({
        itemBalances: [createMockBalance({ remainingQuantity: 1 })],
      })
      prismaMock.creditPackPurchase.findFirst.mockResolvedValue(mockPurchase)
      prismaMock.creditItemBalance.update.mockResolvedValue({})
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.creditPackPurchase.update.mockResolvedValue({})

      await refundPurchase('venue-123', 'purchase-123', 'staff-123', 'reason')

      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should scope purchase lookup by venueId', async () => {
      prismaMock.creditPackPurchase.findFirst.mockResolvedValue(null)

      await expect(refundPurchase('venue-123', 'purchase-123', 'staff-123', 'reason')).rejects.toThrow(NotFoundError)

      expect(prismaMock.creditPackPurchase.findFirst).toHaveBeenCalledWith({
        where: { id: 'purchase-123', venueId: 'venue-123' },
        include: { itemBalances: true },
      })
    })

    it('should handle purchase with no balances (edge case)', async () => {
      const mockPurchase = createMockPurchase({
        itemBalances: [],
      })
      prismaMock.creditPackPurchase.findFirst.mockResolvedValue(mockPurchase)
      prismaMock.creditPackPurchase.update.mockResolvedValue({})

      const result = await refundPurchase('venue-123', 'purchase-123', 'staff-123', 'reason')

      expect(result).toEqual({ refunded: true, purchaseId: 'purchase-123' })
      expect(prismaMock.creditItemBalance.update).not.toHaveBeenCalled()
      expect(prismaMock.creditTransaction.create).not.toHaveBeenCalled()
      expect(prismaMock.creditPackPurchase.update).toHaveBeenCalledWith({
        where: { id: 'purchase-123' },
        data: { status: CreditPurchaseStatus.REFUNDED },
      })
    })
  })

  // ==========================================
  // REGRESSION TESTS
  // ==========================================

  describe('REGRESSION TESTS', () => {
    describe('Multi-tenant isolation: all service functions should pass venueId to queries', () => {
      it('getCreditPacks should filter by venueId', async () => {
        prismaMock.creditPack.findMany.mockResolvedValue([])

        await getCreditPacks('venue-abc')

        expect(prismaMock.creditPack.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { venueId: 'venue-abc' },
          }),
        )
      })

      it('getCreditPackById should filter by venueId', async () => {
        prismaMock.creditPack.findFirst.mockResolvedValue(null)

        await expect(getCreditPackById('venue-abc', 'pack-1')).rejects.toThrow()

        expect(prismaMock.creditPack.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'pack-1', venueId: 'venue-abc' },
          }),
        )
      })

      it('createCreditPack should scope product validation and pack creation to venueId', async () => {
        prismaMock.product.findMany.mockResolvedValue([{ id: 'p1' }])
        prismaMock.creditPack.create.mockResolvedValue(createMockPack())

        await createCreditPack('venue-abc', {
          name: 'Test',
          price: 100,
          items: [{ productId: 'p1', quantity: 1 }],
        })

        expect(prismaMock.product.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ venueId: 'venue-abc' }),
          }),
        )

        expect(prismaMock.creditPack.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ venueId: 'venue-abc' }),
          }),
        )
      })

      it('deactivateCreditPack should filter by venueId', async () => {
        prismaMock.creditPack.findFirst.mockResolvedValue(null)

        await expect(deactivateCreditPack('venue-abc', 'pack-1')).rejects.toThrow()

        expect(prismaMock.creditPack.findFirst).toHaveBeenCalledWith({
          where: { id: 'pack-1', venueId: 'venue-abc' },
        })
      })

      it('getCustomerPurchases should filter by venueId', async () => {
        prismaMock.creditPackPurchase.findMany.mockResolvedValue([])
        prismaMock.creditPackPurchase.count.mockResolvedValue(0)

        await getCustomerPurchases('venue-abc', {})

        expect(prismaMock.creditPackPurchase.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ venueId: 'venue-abc' }),
          }),
        )
      })

      it('getTransactionHistory should filter by venueId', async () => {
        prismaMock.creditTransaction.findMany.mockResolvedValue([])
        prismaMock.creditTransaction.count.mockResolvedValue(0)

        await getTransactionHistory('venue-abc', {})

        expect(prismaMock.creditTransaction.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ venueId: 'venue-abc' }),
          }),
        )
      })

      it('redeemItemManually should validate venueId matches balance purchase venue', async () => {
        const mockBalance = createMockBalance({
          creditPackPurchase: {
            id: 'purchase-123',
            venueId: 'venue-OTHER',
            customerId: 'customer-123',
            status: CreditPurchaseStatus.ACTIVE,
            expiresAt: null,
          },
        })
        prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

        await expect(redeemItemManually('venue-abc', 'balance-123', 'staff-123')).rejects.toThrow(NotFoundError)
      })

      it('adjustItemBalance should validate venueId matches balance purchase venue', async () => {
        const mockBalance = createMockBalance({
          creditPackPurchase: {
            id: 'purchase-123',
            venueId: 'venue-OTHER',
            customerId: 'customer-123',
            status: CreditPurchaseStatus.ACTIVE,
          },
        })
        prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)

        await expect(adjustItemBalance('venue-abc', 'balance-123', 1, 'reason', 'staff-123')).rejects.toThrow(NotFoundError)
      })

      it('refundPurchase should filter by venueId', async () => {
        prismaMock.creditPackPurchase.findFirst.mockResolvedValue(null)

        await expect(refundPurchase('venue-abc', 'purchase-1', 'staff-123', 'reason')).rejects.toThrow()

        expect(prismaMock.creditPackPurchase.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ venueId: 'venue-abc' }),
          }),
        )
      })
    })

    describe('Money precision: verify Decimal is used for price/amountPaid', () => {
      it('createCreditPack should use Prisma.Decimal for price', async () => {
        prismaMock.product.findMany.mockResolvedValue([{ id: 'p1' }])
        prismaMock.creditPack.create.mockResolvedValue(createMockPack())

        await createCreditPack('venue-123', {
          name: 'Test',
          price: 199.99,
          items: [{ productId: 'p1', quantity: 1 }],
        })

        const createCall = prismaMock.creditPack.create.mock.calls[0][0]
        expect(createCall.data.price).toBeInstanceOf(Decimal)
        expect(createCall.data.price.toNumber()).toBe(199.99)
      })

      it('updateCreditPack should use Prisma.Decimal for updated price', async () => {
        const existing = createMockPack({ price: new Decimal(100) })
        prismaMock.creditPack.findFirst.mockResolvedValue(existing)
        prismaMock.creditPack.update.mockResolvedValue(createMockPack({ price: new Decimal(250.5) }))

        await updateCreditPack('venue-123', 'pack-123', { price: 250.5 })

        const updateCall = prismaMock.creditPack.update.mock.calls[0][0]
        expect(updateCall.data.price).toBeInstanceOf(Decimal)
        expect(updateCall.data.price.toNumber()).toBe(250.5)
      })
    })

    describe('Transaction atomicity: verify $transaction is called for balance modifications', () => {
      it('updateCreditPack should use $transaction', async () => {
        const existing = createMockPack()
        prismaMock.creditPack.findFirst.mockResolvedValue(existing)
        prismaMock.creditPack.update.mockResolvedValue(createMockPack())

        await updateCreditPack('venue-123', 'pack-123', { name: 'Updated' })

        expect(prismaMock.$transaction).toHaveBeenCalled()
      })

      it('redeemItemManually should use $transaction', async () => {
        const mockBalance = createMockBalance({
          creditPackPurchase: {
            id: 'purchase-123',
            venueId: 'venue-123',
            customerId: 'customer-123',
            status: CreditPurchaseStatus.ACTIVE,
            expiresAt: new Date('2026-05-01'),
          },
        })
        prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)
        prismaMock.creditTransaction.create.mockResolvedValue(createMockTransaction())
        prismaMock.creditItemBalance.findMany.mockResolvedValue([createMockBalance()])

        await redeemItemManually('venue-123', 'balance-123', 'staff-123')

        expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function))
      })

      it('adjustItemBalance should use $transaction', async () => {
        const mockBalance = createMockBalance({
          remainingQuantity: 5,
          creditPackPurchase: {
            id: 'purchase-123',
            venueId: 'venue-123',
            customerId: 'customer-123',
            status: CreditPurchaseStatus.ACTIVE,
          },
        })
        prismaMock.creditItemBalance.findUnique.mockResolvedValue(mockBalance)
        prismaMock.creditTransaction.create.mockResolvedValue(createMockTransaction())

        await adjustItemBalance('venue-123', 'balance-123', 1, 'reason', 'staff-123')

        expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function))
      })

      it('refundPurchase should use $transaction', async () => {
        const mockPurchase = createMockPurchase({
          itemBalances: [createMockBalance({ remainingQuantity: 1 })],
        })
        prismaMock.creditPackPurchase.findFirst.mockResolvedValue(mockPurchase)
        prismaMock.creditItemBalance.update.mockResolvedValue({})
        prismaMock.creditTransaction.create.mockResolvedValue({})
        prismaMock.creditPackPurchase.update.mockResolvedValue({})

        await refundPurchase('venue-123', 'purchase-123', 'staff-123', 'reason')

        expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function))
      })
    })
  })
})
