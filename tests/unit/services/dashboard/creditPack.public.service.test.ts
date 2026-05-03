// Mock Stripe BEFORE any imports
const mockStripeCheckoutCreate = jest.fn()
const mockStripeCheckoutRetrieve = jest.fn()
const mockStripeProductsCreate = jest.fn()
const mockStripePricesCreate = jest.fn()

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: mockStripeCheckoutCreate,
        retrieve: mockStripeCheckoutRetrieve,
      },
    },
    products: {
      create: mockStripeProductsCreate,
    },
    prices: {
      create: mockStripePricesCreate,
    },
  }))
})

import { prismaMock } from '../../../__helpers__/setup'

// Mock reservation service (withSerializableRetry)
jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  withSerializableRetry: jest.fn((fn: any) => fn(prismaMock)),
  generateConfirmationCode: jest.fn().mockReturnValue('RES-ABC123'),
}))

import {
  getAvailablePacks,
  lookupCustomerCredits,
  createCheckoutSession,
  fulfillPurchase,
  checkRedemptionEligibility,
  redeemForReservation,
} from '../../../../src/services/dashboard/creditPack.public.service'
import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'
import { CreditPurchaseStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

// ==========================================
// HELPERS
// ==========================================

const VENUE_ID = 'venue-123'
const CUSTOMER_ID = 'cust-456'
const PACK_ID = 'pack-123'
const BALANCE_ID = 'balance-789'

const createMockPack = (overrides: Record<string, any> = {}) => ({
  id: PACK_ID,
  venueId: VENUE_ID,
  name: 'Pack Fitness',
  description: null,
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
  items: [
    {
      id: 'item-1',
      creditPackId: PACK_ID,
      productId: 'prod-yoga',
      quantity: 10,
      product: {
        id: 'prod-yoga',
        name: 'Yoga',
        type: 'CLASS',
        price: new Decimal(100),
        imageUrl: null,
        duration: 60,
      },
    },
    {
      id: 'item-2',
      creditPackId: PACK_ID,
      productId: 'prod-shake',
      quantity: 2,
      product: {
        id: 'prod-shake',
        name: 'Shake',
        type: 'FOOD_AND_BEV',
        price: new Decimal(80),
        imageUrl: null,
        duration: null,
      },
    },
  ],
  ...overrides,
})

const createMockCustomer = (overrides: Record<string, any> = {}) => ({
  id: CUSTOMER_ID,
  venueId: VENUE_ID,
  firstName: 'Maria',
  lastName: 'Garcia',
  email: 'maria@example.com',
  phone: '+525551234567',
  totalSpent: new Decimal(1200),
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ...overrides,
})

const createMockPurchase = (overrides: Record<string, any> = {}) => ({
  id: 'purchase-001',
  venueId: VENUE_ID,
  customerId: CUSTOMER_ID,
  creditPackId: PACK_ID,
  stripeCheckoutSessionId: 'cs_test_abc123',
  stripePaymentIntentId: 'pi_test_abc123',
  amountPaid: new Decimal(600),
  status: CreditPurchaseStatus.ACTIVE,
  expiresAt: new Date('2026-06-01'),
  createdAt: new Date('2026-03-01'),
  updatedAt: new Date('2026-03-01'),
  ...overrides,
})

const createMockBalance = (overrides: Record<string, any> = {}) => ({
  id: BALANCE_ID,
  creditPackPurchaseId: 'purchase-001',
  creditPackItemId: 'item-1',
  productId: 'prod-yoga',
  originalQuantity: 10,
  remainingQuantity: 8,
  ...overrides,
})

// ==========================================
// TESTS
// ==========================================

describe('CreditPack Public Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ==========================================
  // getAvailablePacks
  // ==========================================

  describe('getAvailablePacks', () => {
    it('should return active packs with items and product details', async () => {
      const pack1 = createMockPack()
      const pack2 = createMockPack({
        id: 'pack-456',
        name: 'Pack Premium',
        price: new Decimal(1200),
        displayOrder: 1,
      })

      prismaMock.creditPack.findMany.mockResolvedValue([pack1, pack2])

      const result = await getAvailablePacks(VENUE_ID)

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual(pack1)
      expect(result[1]).toEqual(pack2)
      expect(result[0].items).toHaveLength(2)
      expect(result[0].items[0].product.name).toBe('Yoga')
      expect(result[0].items[1].product.name).toBe('Shake')

      expect(prismaMock.creditPack.findMany).toHaveBeenCalledWith({
        where: { venueId: VENUE_ID, active: true },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  type: true,
                  price: true,
                  imageUrl: true,
                  duration: true,
                },
              },
            },
          },
        },
        orderBy: { displayOrder: 'asc' },
      })
    })

    it('should return empty array when no active packs exist', async () => {
      prismaMock.creditPack.findMany.mockResolvedValue([])

      const result = await getAvailablePacks(VENUE_ID)

      expect(result).toEqual([])
      expect(result).toHaveLength(0)
    })

    it('should filter packs by productId when provided', async () => {
      const packWithYoga = createMockPack()
      const packWithoutYoga = createMockPack({
        id: 'pack-no-yoga',
        name: 'Pack Sin Yoga',
        items: [
          {
            id: 'item-3',
            creditPackId: 'pack-no-yoga',
            productId: 'prod-pilates',
            quantity: 5,
            product: {
              id: 'prod-pilates',
              name: 'Pilates',
              type: 'CLASS',
              price: new Decimal(120),
              imageUrl: null,
              duration: 45,
            },
          },
        ],
      })

      prismaMock.creditPack.findMany.mockResolvedValue([packWithYoga, packWithoutYoga])

      const result = await getAvailablePacks(VENUE_ID, 'prod-yoga')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(PACK_ID)
      expect(result[0].items.some((item: any) => item.productId === 'prod-yoga')).toBe(true)
    })

    it('should exclude inactive packs', async () => {
      prismaMock.creditPack.findMany.mockResolvedValue([])

      const result = await getAvailablePacks(VENUE_ID)

      expect(result).toEqual([])
      // The query itself filters active: true
      expect(prismaMock.creditPack.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: VENUE_ID, active: true },
        }),
      )
    })
  })

  // ==========================================
  // lookupCustomerCredits
  // ==========================================

  describe('lookupCustomerCredits', () => {
    it('should return customer with active purchases and balances', async () => {
      const customer = createMockCustomer()
      const purchase = createMockPurchase({
        creditPack: { name: 'Pack Fitness' },
        itemBalances: [
          {
            ...createMockBalance({ remainingQuantity: 5 }),
            product: { id: 'prod-yoga', name: 'Yoga', type: 'CLASS', imageUrl: null },
          },
        ],
      })

      prismaMock.customer.findFirst.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([purchase])

      const result = await lookupCustomerCredits(VENUE_ID, 'maria@example.com')

      expect(result.customer).toEqual({
        id: CUSTOMER_ID,
        firstName: 'Maria',
        lastName: 'Garcia',
        email: 'maria@example.com',
        phone: '+525551234567',
      })
      expect(result.purchases).toHaveLength(1)
      expect(result.purchases[0]).toEqual({
        ...purchase,
        itemBalances: (purchase as any).itemBalances.map((b: any) => ({ ...b, sufficient: true })),
      })
    })

    it('should return null customer when not found', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      const result = await lookupCustomerCredits(VENUE_ID, 'notfound@example.com')

      expect(result.customer).toBeNull()
      expect(result.purchases).toEqual([])
    })

    it('should throw BadRequestError when neither email nor phone provided', async () => {
      await expect(lookupCustomerCredits(VENUE_ID)).rejects.toThrow(BadRequestError)
      await expect(lookupCustomerCredits(VENUE_ID)).rejects.toThrow('Se requiere email o telefono para consultar creditos')
    })

    it('should find customer by email', async () => {
      const customer = createMockCustomer()
      prismaMock.customer.findFirst.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([])

      await lookupCustomerCredits(VENUE_ID, 'maria@example.com')

      expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({
        where: {
          venueId: VENUE_ID,
          email: 'maria@example.com',
        },
      })
    })

    it('should find customer by phone', async () => {
      const customer = createMockCustomer()
      prismaMock.customer.findFirst.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([])

      await lookupCustomerCredits(VENUE_ID, undefined, '+525551234567')

      expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({
        where: {
          venueId: VENUE_ID,
          phone: '+525551234567',
        },
      })
    })

    it('should only return ACTIVE purchases with remaining balance', async () => {
      const customer = createMockCustomer()
      prismaMock.customer.findFirst.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([])

      await lookupCustomerCredits(VENUE_ID, 'maria@example.com')

      expect(prismaMock.creditPackPurchase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId: VENUE_ID,
            customerId: CUSTOMER_ID,
            status: CreditPurchaseStatus.ACTIVE,
            OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
          }),
          include: expect.objectContaining({
            itemBalances: expect.objectContaining({
              where: {
                remainingQuantity: { gt: 0 },
                product: { allowCreditRedemption: true },
              },
            }),
          }),
        }),
      )
    })

    it('should exclude expired purchases', async () => {
      const customer = createMockCustomer()
      prismaMock.customer.findFirst.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([])

      await lookupCustomerCredits(VENUE_ID, 'maria@example.com')

      // The query uses OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      // which excludes purchases whose expiresAt is in the past
      const callArgs = prismaMock.creditPackPurchase.findMany.mock.calls[0][0]
      expect(callArgs.where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }])
    })

    it('should order by expiration (soonest first)', async () => {
      const customer = createMockCustomer()
      prismaMock.customer.findFirst.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([])

      await lookupCustomerCredits(VENUE_ID, 'maria@example.com')

      expect(prismaMock.creditPackPurchase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { expiresAt: 'asc' },
        }),
      )
    })
  })

  // ==========================================
  // createCheckoutSession
  // ==========================================

  describe('createCheckoutSession', () => {
    const successUrl = 'https://example.com/success'
    const cancelUrl = 'https://example.com/cancel'
    const phone = '+525551234567'
    const email = 'maria@example.com'

    it('should create Stripe Checkout Session and return URL', async () => {
      const pack = createMockPack()
      prismaMock.creditPack.findFirst.mockResolvedValue(pack)

      mockStripeCheckoutCreate.mockResolvedValue({
        id: 'cs_test_session',
        url: 'https://checkout.stripe.com/session/cs_test_session',
      })

      const result = await createCheckoutSession(VENUE_ID, PACK_ID, email, phone, successUrl, cancelUrl)

      expect(result).toEqual({
        checkoutUrl: 'https://checkout.stripe.com/session/cs_test_session',
      })

      expect(mockStripeCheckoutCreate).toHaveBeenCalledWith({
        mode: 'payment',
        line_items: [{ price: 'price_test', quantity: 1 }],
        metadata: {
          type: 'credit_pack_purchase',
          venueId: VENUE_ID,
          packId: PACK_ID,
          customerPhone: phone,
          customerEmail: email,
        },
        customer_email: email,
        success_url: successUrl,
        cancel_url: cancelUrl,
      })
    })

    it('should throw NotFoundError when pack not found', async () => {
      prismaMock.creditPack.findFirst.mockResolvedValue(null)

      await expect(createCheckoutSession(VENUE_ID, 'nonexistent-pack', email, phone, successUrl, cancelUrl)).rejects.toThrow(NotFoundError)

      await expect(createCheckoutSession(VENUE_ID, 'nonexistent-pack', email, phone, successUrl, cancelUrl)).rejects.toThrow(
        'Paquete no encontrado o no disponible',
      )
    })

    it('should throw NotFoundError when pack is inactive', async () => {
      // The query filters active: true, so an inactive pack won't be found
      prismaMock.creditPack.findFirst.mockResolvedValue(null)

      await expect(createCheckoutSession(VENUE_ID, PACK_ID, email, phone, successUrl, cancelUrl)).rejects.toThrow(NotFoundError)

      expect(prismaMock.creditPack.findFirst).toHaveBeenCalledWith({
        where: { id: PACK_ID, venueId: VENUE_ID, active: true },
      })
    })

    it('should check maxPerCustomer limit and throw BadRequestError if exceeded', async () => {
      const pack = createMockPack({ maxPerCustomer: 2 })
      const customer = createMockCustomer()

      prismaMock.creditPack.findFirst.mockResolvedValue(pack)
      prismaMock.customer.findFirst.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.count.mockResolvedValue(2) // Already at limit

      await expect(createCheckoutSession(VENUE_ID, PACK_ID, email, phone, successUrl, cancelUrl)).rejects.toThrow(BadRequestError)

      await expect(createCheckoutSession(VENUE_ID, PACK_ID, email, phone, successUrl, cancelUrl)).rejects.toThrow(
        'Has alcanzado el limite de 2 compras para este paquete',
      )
    })

    it('should allow purchase when under maxPerCustomer limit', async () => {
      const pack = createMockPack({ maxPerCustomer: 3 })
      const customer = createMockCustomer()

      prismaMock.creditPack.findFirst.mockResolvedValue(pack)
      prismaMock.customer.findFirst.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.count.mockResolvedValue(1) // Under limit

      mockStripeCheckoutCreate.mockResolvedValue({
        id: 'cs_test_session',
        url: 'https://checkout.stripe.com/session/cs_test_session',
      })

      const result = await createCheckoutSession(VENUE_ID, PACK_ID, email, phone, successUrl, cancelUrl)

      expect(result.checkoutUrl).toBe('https://checkout.stripe.com/session/cs_test_session')
    })

    it('should skip maxPerCustomer check when customer does not exist yet', async () => {
      const pack = createMockPack({ maxPerCustomer: 2 })

      prismaMock.creditPack.findFirst.mockResolvedValue(pack)
      prismaMock.customer.findFirst.mockResolvedValue(null) // No customer found

      mockStripeCheckoutCreate.mockResolvedValue({
        id: 'cs_test_session',
        url: 'https://checkout.stripe.com/session/cs_test_session',
      })

      const result = await createCheckoutSession(VENUE_ID, PACK_ID, email, phone, successUrl, cancelUrl)

      expect(result.checkoutUrl).toBe('https://checkout.stripe.com/session/cs_test_session')
      // Should not check purchase count when customer doesn't exist
      expect(prismaMock.creditPackPurchase.count).not.toHaveBeenCalled()
    })

    it('should create Stripe product/price if not yet created on pack', async () => {
      const pack = createMockPack({ stripeProductId: null, stripePriceId: null })

      prismaMock.creditPack.findFirst.mockResolvedValue(pack)

      mockStripeProductsCreate.mockResolvedValue({ id: 'prod_new_123' })
      mockStripePricesCreate.mockResolvedValue({ id: 'price_new_456' })
      prismaMock.creditPack.update.mockResolvedValue({
        ...pack,
        stripeProductId: 'prod_new_123',
        stripePriceId: 'price_new_456',
      })

      mockStripeCheckoutCreate.mockResolvedValue({
        id: 'cs_test_session',
        url: 'https://checkout.stripe.com/session/cs_test_session',
      })

      await createCheckoutSession(VENUE_ID, PACK_ID, email, phone, successUrl, cancelUrl)

      expect(mockStripeProductsCreate).toHaveBeenCalledWith({
        name: 'Pack Fitness',
        metadata: {
          type: 'credit_pack',
          venueId: VENUE_ID,
          packId: PACK_ID,
        },
      })

      expect(mockStripePricesCreate).toHaveBeenCalledWith({
        product: 'prod_new_123',
        unit_amount: 60000, // 600 * 100
        currency: 'mxn',
        metadata: {
          type: 'credit_pack',
          venueId: VENUE_ID,
          packId: PACK_ID,
        },
      })

      expect(prismaMock.creditPack.update).toHaveBeenCalledWith({
        where: { id: PACK_ID },
        data: {
          stripeProductId: 'prod_new_123',
          stripePriceId: 'price_new_456',
        },
      })

      // The new price ID should be used for the checkout session
      expect(mockStripeCheckoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: 'price_new_456', quantity: 1 }],
        }),
      )
    })

    it('should use existing stripePriceId if already set', async () => {
      const pack = createMockPack({
        stripeProductId: 'prod_existing',
        stripePriceId: 'price_existing',
      })

      prismaMock.creditPack.findFirst.mockResolvedValue(pack)

      mockStripeCheckoutCreate.mockResolvedValue({
        id: 'cs_test_session',
        url: 'https://checkout.stripe.com/session/cs_test_session',
      })

      await createCheckoutSession(VENUE_ID, PACK_ID, email, phone, successUrl, cancelUrl)

      // Should NOT create new Stripe product/price
      expect(mockStripeProductsCreate).not.toHaveBeenCalled()
      expect(mockStripePricesCreate).not.toHaveBeenCalled()
      expect(prismaMock.creditPack.update).not.toHaveBeenCalled()

      expect(mockStripeCheckoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: 'price_existing', quantity: 1 }],
        }),
      )
    })

    it('should pass correct metadata to Stripe session', async () => {
      const pack = createMockPack()
      prismaMock.creditPack.findFirst.mockResolvedValue(pack)

      mockStripeCheckoutCreate.mockResolvedValue({
        id: 'cs_test_session',
        url: 'https://checkout.stripe.com/session/cs_test_session',
      })

      await createCheckoutSession(VENUE_ID, PACK_ID, email, phone, successUrl, cancelUrl)

      expect(mockStripeCheckoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            type: 'credit_pack_purchase',
            venueId: VENUE_ID,
            packId: PACK_ID,
            customerPhone: phone,
            customerEmail: email,
          },
        }),
      )
    })

    it('should omit customerEmail from metadata when email is undefined', async () => {
      const pack = createMockPack()
      prismaMock.creditPack.findFirst.mockResolvedValue(pack)

      mockStripeCheckoutCreate.mockResolvedValue({
        id: 'cs_test_session',
        url: 'https://checkout.stripe.com/session/cs_test_session',
      })

      await createCheckoutSession(VENUE_ID, PACK_ID, undefined, phone, successUrl, cancelUrl)

      const callArgs = mockStripeCheckoutCreate.mock.calls[0][0]
      expect(callArgs.metadata).toEqual({
        type: 'credit_pack_purchase',
        venueId: VENUE_ID,
        packId: PACK_ID,
        customerPhone: phone,
      })
      // customer_email should not be set when email is undefined
      expect(callArgs.customer_email).toBeUndefined()
    })
  })

  // ==========================================
  // fulfillPurchase
  // ==========================================

  describe('fulfillPurchase', () => {
    const checkoutSessionId = 'cs_test_fulfill_123'

    const createMockStripeSession = (overrides: Record<string, any> = {}) => ({
      id: checkoutSessionId,
      metadata: {
        type: 'credit_pack_purchase',
        venueId: VENUE_ID,
        packId: PACK_ID,
        customerPhone: '+525551234567',
        customerEmail: 'maria@example.com',
      },
      customer_email: null,
      amount_total: 60000, // $600 in cents
      payment_intent: 'pi_test_123',
      payment_status: 'paid',
      ...overrides,
    })

    it('should create purchase, item balances, and PURCHASE transactions', async () => {
      const session = createMockStripeSession()
      const pack = createMockPack()
      const customer = createMockCustomer()
      const newPurchase = createMockPurchase({ stripeCheckoutSessionId: checkoutSessionId })

      mockStripeCheckoutRetrieve.mockResolvedValue(session)
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null) // Not yet processed
      prismaMock.creditPack.findUnique.mockResolvedValue(pack)
      prismaMock.customer.findUnique.mockResolvedValue(customer) // findOrCreateCustomer uses findUnique
      prismaMock.creditPackPurchase.create.mockResolvedValue(newPurchase)
      prismaMock.creditItemBalance.create.mockResolvedValueOnce(createMockBalance({ id: 'bal-1', productId: 'prod-yoga' }))
      prismaMock.creditItemBalance.create.mockResolvedValueOnce(createMockBalance({ id: 'bal-2', productId: 'prod-shake' }))
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.customer.update.mockResolvedValue(customer)

      const result = await fulfillPurchase(checkoutSessionId)

      expect(result).toEqual(newPurchase)

      // Purchase created
      expect(prismaMock.creditPackPurchase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          venueId: VENUE_ID,
          customerId: CUSTOMER_ID,
          creditPackId: PACK_ID,
          stripeCheckoutSessionId: checkoutSessionId,
          stripePaymentIntentId: 'pi_test_123',
          amountPaid: new Decimal(600),
          status: CreditPurchaseStatus.ACTIVE,
          expiresAt: expect.any(Date),
        }),
      })

      // Two item balances created (one per pack item)
      expect(prismaMock.creditItemBalance.create).toHaveBeenCalledTimes(2)

      // First balance (Yoga, quantity 10)
      expect(prismaMock.creditItemBalance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          creditPackItemId: 'item-1',
          productId: 'prod-yoga',
          originalQuantity: 10,
          remainingQuantity: 10,
        }),
      })

      // Second balance (Shake, quantity 2)
      expect(prismaMock.creditItemBalance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          creditPackItemId: 'item-2',
          productId: 'prod-shake',
          originalQuantity: 2,
          remainingQuantity: 2,
        }),
      })

      // Two PURCHASE transactions created
      expect(prismaMock.creditTransaction.create).toHaveBeenCalledTimes(2)
      expect(prismaMock.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          venueId: VENUE_ID,
          customerId: CUSTOMER_ID,
          type: 'PURCHASE',
          quantity: 10,
        }),
      })
      expect(prismaMock.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          venueId: VENUE_ID,
          customerId: CUSTOMER_ID,
          type: 'PURCHASE',
          quantity: 2,
        }),
      })
    })

    it('should handle idempotency (skip if already processed)', async () => {
      const session = createMockStripeSession()
      const existingPurchase = createMockPurchase({ stripeCheckoutSessionId: checkoutSessionId })

      mockStripeCheckoutRetrieve.mockResolvedValue(session)
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(existingPurchase)

      const result = await fulfillPurchase(checkoutSessionId)

      expect(result).toEqual(existingPurchase)
      // Should not create anything new
      expect(prismaMock.creditPack.findUnique).not.toHaveBeenCalled()
      expect(prismaMock.creditPackPurchase.create).not.toHaveBeenCalled()
      expect(prismaMock.creditItemBalance.create).not.toHaveBeenCalled()
      expect(prismaMock.creditTransaction.create).not.toHaveBeenCalled()
    })

    it('should calculate expiresAt from validityDays', async () => {
      const session = createMockStripeSession()
      const pack = createMockPack({ validityDays: 30 })
      const customer = createMockCustomer()
      const newPurchase = createMockPurchase()

      mockStripeCheckoutRetrieve.mockResolvedValue(session)
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null)
      prismaMock.creditPack.findUnique.mockResolvedValue(pack)
      prismaMock.customer.findUnique.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.create.mockResolvedValue(newPurchase)
      prismaMock.creditItemBalance.create.mockResolvedValue(createMockBalance())
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.customer.update.mockResolvedValue(customer)

      const beforeCall = Date.now()
      await fulfillPurchase(checkoutSessionId)
      const afterCall = Date.now()

      const createCall = prismaMock.creditPackPurchase.create.mock.calls[0][0]
      const expiresAt = createCall.data.expiresAt as Date

      // expiresAt should be ~30 days from now
      const expectedMin = beforeCall + 30 * 24 * 60 * 60 * 1000
      const expectedMax = afterCall + 30 * 24 * 60 * 60 * 1000
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin)
      expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax)
    })

    it('should set expiresAt to null when validityDays is null', async () => {
      const session = createMockStripeSession()
      const pack = createMockPack({ validityDays: null })
      const customer = createMockCustomer()
      const newPurchase = createMockPurchase({ expiresAt: null })

      mockStripeCheckoutRetrieve.mockResolvedValue(session)
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null)
      prismaMock.creditPack.findUnique.mockResolvedValue(pack)
      prismaMock.customer.findUnique.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.create.mockResolvedValue(newPurchase)
      prismaMock.creditItemBalance.create.mockResolvedValue(createMockBalance())
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.customer.update.mockResolvedValue(customer)

      await fulfillPurchase(checkoutSessionId)

      const createCall = prismaMock.creditPackPurchase.create.mock.calls[0][0]
      expect(createCall.data.expiresAt).toBeNull()
    })

    it('should find customer by email', async () => {
      const session = createMockStripeSession({
        metadata: {
          type: 'credit_pack_purchase',
          venueId: VENUE_ID,
          packId: PACK_ID,
          customerPhone: '+525551234567',
          customerEmail: 'maria@example.com',
        },
      })
      const pack = createMockPack()
      const customer = createMockCustomer()
      const newPurchase = createMockPurchase()

      mockStripeCheckoutRetrieve.mockResolvedValue(session)
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null)
      prismaMock.creditPack.findUnique.mockResolvedValue(pack)
      prismaMock.customer.findUnique.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.create.mockResolvedValue(newPurchase)
      prismaMock.creditItemBalance.create.mockResolvedValue(createMockBalance())
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.customer.update.mockResolvedValue(customer)

      await fulfillPurchase(checkoutSessionId)

      // findOrCreateCustomer tries email first via findUnique with venueId_email
      expect(prismaMock.customer.findUnique).toHaveBeenCalledWith({
        where: { venueId_email: { venueId: VENUE_ID, email: 'maria@example.com' } },
      })
    })

    it('should find customer by phone', async () => {
      const session = createMockStripeSession({
        metadata: {
          type: 'credit_pack_purchase',
          venueId: VENUE_ID,
          packId: PACK_ID,
          customerPhone: '+525551234567',
          // No customerEmail
        },
        customer_email: null,
      })
      const pack = createMockPack()
      const customer = createMockCustomer()
      const newPurchase = createMockPurchase()

      mockStripeCheckoutRetrieve.mockResolvedValue(session)
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null)
      prismaMock.creditPack.findUnique.mockResolvedValue(pack)
      // No customer found by email (email is undefined so findUnique by email is not called)
      // Found by phone
      prismaMock.customer.findUnique.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.create.mockResolvedValue(newPurchase)
      prismaMock.creditItemBalance.create.mockResolvedValue(createMockBalance())
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.customer.update.mockResolvedValue(customer)

      await fulfillPurchase(checkoutSessionId)

      // When no email, findOrCreateCustomer goes straight to phone lookup
      expect(prismaMock.customer.findUnique).toHaveBeenCalledWith({
        where: { venueId_phone: { venueId: VENUE_ID, phone: '+525551234567' } },
      })
    })

    it('should create new customer if not found', async () => {
      const session = createMockStripeSession()
      const pack = createMockPack()
      const newCustomer = createMockCustomer({ id: 'new-cust-id' })
      const newPurchase = createMockPurchase({ customerId: 'new-cust-id' })

      mockStripeCheckoutRetrieve.mockResolvedValue(session)
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null)
      prismaMock.creditPack.findUnique.mockResolvedValue(pack)
      // Not found by email or phone
      prismaMock.customer.findUnique.mockResolvedValue(null)
      prismaMock.customer.create.mockResolvedValue(newCustomer)
      prismaMock.creditPackPurchase.create.mockResolvedValue(newPurchase)
      prismaMock.creditItemBalance.create.mockResolvedValue(createMockBalance())
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.customer.update.mockResolvedValue(newCustomer)

      await fulfillPurchase(checkoutSessionId)

      expect(prismaMock.customer.create).toHaveBeenCalledWith({
        data: {
          venueId: VENUE_ID,
          email: 'maria@example.com',
          phone: '+525551234567',
        },
      })
    })

    it('should increment customer totalSpent', async () => {
      const session = createMockStripeSession({ amount_total: 75000 }) // $750
      const pack = createMockPack()
      const customer = createMockCustomer()
      const newPurchase = createMockPurchase()

      mockStripeCheckoutRetrieve.mockResolvedValue(session)
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null)
      prismaMock.creditPack.findUnique.mockResolvedValue(pack)
      prismaMock.customer.findUnique.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.create.mockResolvedValue(newPurchase)
      prismaMock.creditItemBalance.create.mockResolvedValue(createMockBalance())
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.customer.update.mockResolvedValue(customer)

      await fulfillPurchase(checkoutSessionId)

      expect(prismaMock.customer.update).toHaveBeenCalledWith({
        where: { id: CUSTOMER_ID },
        data: {
          totalSpent: { increment: new Decimal(750) },
        },
      })
    })

    it('should skip non-credit-pack sessions (different metadata.type)', async () => {
      const session = createMockStripeSession({
        metadata: {
          type: 'subscription', // Not credit_pack_purchase
          venueId: VENUE_ID,
        },
      })

      mockStripeCheckoutRetrieve.mockResolvedValue(session)

      const result = await fulfillPurchase(checkoutSessionId)

      expect(result).toBeUndefined()
      expect(prismaMock.creditPackPurchase.findUnique).not.toHaveBeenCalled()
      expect(prismaMock.creditPack.findUnique).not.toHaveBeenCalled()
    })
  })

  // ==========================================
  // checkRedemptionEligibility
  // ==========================================

  describe('checkRedemptionEligibility', () => {
    it('should return best balance (FIFO by expiration)', async () => {
      const balance = createMockBalance({
        remainingQuantity: 5,
        creditPackPurchase: {
          id: 'purchase-001',
          expiresAt: new Date('2026-06-01'),
          creditPack: { name: 'Pack Fitness' },
        },
      })

      prismaMock.creditItemBalance.findFirst.mockResolvedValue(balance)

      const result = await checkRedemptionEligibility(VENUE_ID, CUSTOMER_ID, 'prod-yoga')

      expect(result).toEqual(balance)
      expect(result!.remainingQuantity).toBe(5)
      expect(result!.creditPackPurchase.creditPack.name).toBe('Pack Fitness')

      expect(prismaMock.creditItemBalance.findFirst).toHaveBeenCalledWith({
        where: {
          productId: 'prod-yoga',
          remainingQuantity: { gt: 0 },
          product: { allowCreditRedemption: true },
          creditPackPurchase: {
            venueId: VENUE_ID,
            customerId: CUSTOMER_ID,
            status: CreditPurchaseStatus.ACTIVE,
            OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
          },
        },
        include: {
          creditPackPurchase: {
            select: { id: true, expiresAt: true, creditPack: { select: { name: true } } },
          },
        },
        orderBy: {
          creditPackPurchase: { expiresAt: 'asc' },
        },
      })
    })

    it('should return null when no eligible balance exists', async () => {
      prismaMock.creditItemBalance.findFirst.mockResolvedValue(null)

      const result = await checkRedemptionEligibility(VENUE_ID, CUSTOMER_ID, 'prod-yoga')

      expect(result).toBeNull()
    })

    it('should exclude balances with remainingQuantity = 0', async () => {
      prismaMock.creditItemBalance.findFirst.mockResolvedValue(null)

      await checkRedemptionEligibility(VENUE_ID, CUSTOMER_ID, 'prod-yoga')

      // The query filters remainingQuantity > 0
      expect(prismaMock.creditItemBalance.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            remainingQuantity: { gt: 0 },
          }),
        }),
      )
    })

    it('should exclude expired purchases', async () => {
      prismaMock.creditItemBalance.findFirst.mockResolvedValue(null)

      await checkRedemptionEligibility(VENUE_ID, CUSTOMER_ID, 'prod-yoga')

      const callArgs = prismaMock.creditItemBalance.findFirst.mock.calls[0][0]
      expect(callArgs.where.creditPackPurchase.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }])
    })

    it('should exclude non-ACTIVE purchases', async () => {
      prismaMock.creditItemBalance.findFirst.mockResolvedValue(null)

      await checkRedemptionEligibility(VENUE_ID, CUSTOMER_ID, 'prod-yoga')

      const callArgs = prismaMock.creditItemBalance.findFirst.mock.calls[0][0]
      expect(callArgs.where.creditPackPurchase.status).toBe(CreditPurchaseStatus.ACTIVE)
    })
  })

  // ==========================================
  // redeemForReservation
  // ==========================================

  describe('redeemForReservation', () => {
    const reservationId = 'reservation-001'

    it('should lock balance, decrement, and create REDEEM transaction', async () => {
      const balanceRow = {
        id: BALANCE_ID,
        remainingQuantity: 5,
        creditPackPurchaseId: 'purchase-001',
        productId: 'prod-yoga',
      }
      const purchase = {
        status: CreditPurchaseStatus.ACTIVE,
        expiresAt: new Date('2026-06-01'),
        venueId: VENUE_ID,
        customerId: CUSTOMER_ID,
      }

      prismaMock.$queryRaw.mockResolvedValue([balanceRow])
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(purchase)
      prismaMock.creditItemBalance.update.mockResolvedValue({
        ...balanceRow,
        remainingQuantity: 4,
      })
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.creditItemBalance.findMany.mockResolvedValue([
        { remainingQuantity: 4 }, // Still has balance left
      ])

      const result = await redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)

      expect(result).toEqual({ redeemed: true })

      // Balance decremented
      expect(prismaMock.creditItemBalance.update).toHaveBeenCalledWith({
        where: { id: BALANCE_ID },
        data: { remainingQuantity: { decrement: 1 } },
      })

      // REDEEM transaction created
      expect(prismaMock.creditTransaction.create).toHaveBeenCalledWith({
        data: {
          venueId: VENUE_ID,
          customerId: CUSTOMER_ID,
          creditPackPurchaseId: 'purchase-001',
          creditItemBalanceId: BALANCE_ID,
          type: 'REDEEM',
          quantity: -1,
          reservationId,
        },
      })
    })

    it('should throw NotFoundError when balance does not exist', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]) // No balance found

      await expect(redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)).rejects.toThrow(NotFoundError)

      await expect(redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)).rejects.toThrow(
        'Balance de credito no encontrado',
      )
    })

    it('should throw BadRequestError when no credits remaining', async () => {
      const balanceRow = {
        id: BALANCE_ID,
        remainingQuantity: 0,
        creditPackPurchaseId: 'purchase-001',
        productId: 'prod-yoga',
      }

      prismaMock.$queryRaw.mockResolvedValue([balanceRow])

      await expect(redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)).rejects.toThrow(BadRequestError)

      await expect(redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)).rejects.toThrow(
        'No hay creditos disponibles en este balance',
      )
    })

    it('should throw BadRequestError when purchase not ACTIVE', async () => {
      const balanceRow = {
        id: BALANCE_ID,
        remainingQuantity: 5,
        creditPackPurchaseId: 'purchase-001',
        productId: 'prod-yoga',
      }
      const purchase = {
        status: CreditPurchaseStatus.EXHAUSTED,
        expiresAt: new Date('2026-06-01'),
        venueId: VENUE_ID,
        customerId: CUSTOMER_ID,
      }

      prismaMock.$queryRaw.mockResolvedValue([balanceRow])
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(purchase)

      await expect(redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)).rejects.toThrow(BadRequestError)

      await expect(redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)).rejects.toThrow(
        'La compra de creditos ya no esta activa',
      )
    })

    it('should throw BadRequestError when credits expired', async () => {
      const balanceRow = {
        id: BALANCE_ID,
        remainingQuantity: 5,
        creditPackPurchaseId: 'purchase-001',
        productId: 'prod-yoga',
      }
      const purchase = {
        status: CreditPurchaseStatus.ACTIVE,
        expiresAt: new Date('2025-01-01'), // In the past
        venueId: VENUE_ID,
        customerId: CUSTOMER_ID,
      }

      prismaMock.$queryRaw.mockResolvedValue([balanceRow])
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(purchase)

      await expect(redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)).rejects.toThrow(BadRequestError)

      await expect(redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)).rejects.toThrow('Los creditos han expirado')
    })

    it('should throw BadRequestError when customerId does not match', async () => {
      const balanceRow = {
        id: BALANCE_ID,
        remainingQuantity: 5,
        creditPackPurchaseId: 'purchase-001',
        productId: 'prod-yoga',
      }
      const purchase = {
        status: CreditPurchaseStatus.ACTIVE,
        expiresAt: new Date('2026-06-01'),
        venueId: VENUE_ID,
        customerId: 'different-customer-id', // Mismatch
      }

      prismaMock.$queryRaw.mockResolvedValue([balanceRow])
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(purchase)

      await expect(redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)).rejects.toThrow(BadRequestError)

      await expect(redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)).rejects.toThrow(
        'Balance de credito no valido para este cliente',
      )
    })

    it('should throw BadRequestError when venueId does not match', async () => {
      const balanceRow = {
        id: BALANCE_ID,
        remainingQuantity: 5,
        creditPackPurchaseId: 'purchase-001',
        productId: 'prod-yoga',
      }
      const purchase = {
        status: CreditPurchaseStatus.ACTIVE,
        expiresAt: new Date('2026-06-01'),
        venueId: 'different-venue-id', // Mismatch
        customerId: CUSTOMER_ID,
      }

      prismaMock.$queryRaw.mockResolvedValue([balanceRow])
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(purchase)

      await expect(redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)).rejects.toThrow(BadRequestError)

      await expect(redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)).rejects.toThrow(
        'Balance de credito no valido para este cliente',
      )
    })

    it('should mark purchase EXHAUSTED when all balances depleted', async () => {
      const balanceRow = {
        id: BALANCE_ID,
        remainingQuantity: 1, // Last credit
        creditPackPurchaseId: 'purchase-001',
        productId: 'prod-yoga',
      }
      const purchase = {
        status: CreditPurchaseStatus.ACTIVE,
        expiresAt: new Date('2026-06-01'),
        venueId: VENUE_ID,
        customerId: CUSTOMER_ID,
      }

      prismaMock.$queryRaw.mockResolvedValue([balanceRow])
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(purchase)
      prismaMock.creditItemBalance.update.mockResolvedValue({
        ...balanceRow,
        remainingQuantity: 0,
      })
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.creditItemBalance.findMany.mockResolvedValue([]) // No remaining balances

      await redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)

      expect(prismaMock.creditPackPurchase.update).toHaveBeenCalledWith({
        where: { id: 'purchase-001' },
        data: { status: CreditPurchaseStatus.EXHAUSTED },
      })
    })

    it('should NOT mark purchase EXHAUSTED when other balances remain', async () => {
      const balanceRow = {
        id: BALANCE_ID,
        remainingQuantity: 1,
        creditPackPurchaseId: 'purchase-001',
        productId: 'prod-yoga',
      }
      const purchase = {
        status: CreditPurchaseStatus.ACTIVE,
        expiresAt: new Date('2026-06-01'),
        venueId: VENUE_ID,
        customerId: CUSTOMER_ID,
      }

      prismaMock.$queryRaw.mockResolvedValue([balanceRow])
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(purchase)
      prismaMock.creditItemBalance.update.mockResolvedValue({
        ...balanceRow,
        remainingQuantity: 0,
      })
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.creditItemBalance.findMany.mockResolvedValue([
        { remainingQuantity: 3 }, // Another balance still has credits
      ])

      await redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, reservationId)

      // Should NOT update purchase status
      expect(prismaMock.creditPackPurchase.update).not.toHaveBeenCalled()
    })
  })

  // ==========================================
  // REGRESSION TESTS
  // ==========================================

  describe('Regression Tests', () => {
    it('Multi-tenant isolation: getAvailablePacks filters by venueId', async () => {
      prismaMock.creditPack.findMany.mockResolvedValue([])

      await getAvailablePacks('venue-ABC')

      expect(prismaMock.creditPack.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ venueId: 'venue-ABC' }),
        }),
      )
    })

    it('Multi-tenant isolation: lookupCustomerCredits filters by venueId', async () => {
      const customer = createMockCustomer({ venueId: 'venue-ABC' })
      prismaMock.customer.findFirst.mockResolvedValue(customer)
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([])

      await lookupCustomerCredits('venue-ABC', 'test@example.com')

      expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({ venueId: 'venue-ABC' }),
      })
      expect(prismaMock.creditPackPurchase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ venueId: 'venue-ABC' }),
        }),
      )
    })

    it('Multi-tenant isolation: createCheckoutSession filters by venueId', async () => {
      const pack = createMockPack({ venueId: 'venue-XYZ' })
      prismaMock.creditPack.findFirst.mockResolvedValue(pack)

      mockStripeCheckoutCreate.mockResolvedValue({
        id: 'cs_test_session',
        url: 'https://checkout.stripe.com/session/cs_test_session',
      })

      await createCheckoutSession(
        'venue-XYZ',
        PACK_ID,
        'test@example.com',
        '+525551234567',
        'https://example.com/success',
        'https://example.com/cancel',
      )

      expect(prismaMock.creditPack.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({ venueId: 'venue-XYZ' }),
      })
    })

    it('Multi-tenant isolation: checkRedemptionEligibility filters by venueId', async () => {
      prismaMock.creditItemBalance.findFirst.mockResolvedValue(null)

      await checkRedemptionEligibility('venue-MULTI', CUSTOMER_ID, 'prod-yoga')

      expect(prismaMock.creditItemBalance.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            creditPackPurchase: expect.objectContaining({ venueId: 'venue-MULTI' }),
          }),
        }),
      )
    })

    it('Idempotency: fulfillPurchase is idempotent on stripeCheckoutSessionId', async () => {
      const existingPurchase = createMockPurchase({ stripeCheckoutSessionId: 'cs_idempotent' })

      mockStripeCheckoutRetrieve.mockResolvedValue({
        id: 'cs_idempotent',
        metadata: {
          type: 'credit_pack_purchase',
          venueId: VENUE_ID,
          packId: PACK_ID,
          customerPhone: '+525551234567',
          customerEmail: 'maria@example.com',
        },
        customer_email: null,
        amount_total: 60000,
        payment_intent: 'pi_test_123',
        payment_status: 'paid',
      })

      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(existingPurchase)

      // Call twice
      const result1 = await fulfillPurchase('cs_idempotent')
      const result2 = await fulfillPurchase('cs_idempotent')

      // Both return the same existing purchase
      expect(result1).toEqual(existingPurchase)
      expect(result2).toEqual(existingPurchase)

      // No new records created
      expect(prismaMock.creditPackPurchase.create).not.toHaveBeenCalled()
    })

    it('Concurrency safety: redeemForReservation uses serializable retry', async () => {
      const { withSerializableRetry } = require('@/services/dashboard/reservation.dashboard.service')

      const balanceRow = {
        id: BALANCE_ID,
        remainingQuantity: 5,
        creditPackPurchaseId: 'purchase-001',
        productId: 'prod-yoga',
      }
      const purchase = {
        status: CreditPurchaseStatus.ACTIVE,
        expiresAt: new Date('2026-06-01'),
        venueId: VENUE_ID,
        customerId: CUSTOMER_ID,
      }

      prismaMock.$queryRaw.mockResolvedValue([balanceRow])
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(purchase)
      prismaMock.creditItemBalance.update.mockResolvedValue({
        ...balanceRow,
        remainingQuantity: 4,
      })
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.creditItemBalance.findMany.mockResolvedValue([{ remainingQuantity: 4 }])

      await redeemForReservation(VENUE_ID, CUSTOMER_ID, BALANCE_ID, 'res-001')

      // withSerializableRetry should have been called
      expect(withSerializableRetry).toHaveBeenCalled()
    })

    it('FIFO ordering: checkRedemptionEligibility returns soonest-expiring balance', async () => {
      prismaMock.creditItemBalance.findFirst.mockResolvedValue(null)

      await checkRedemptionEligibility(VENUE_ID, CUSTOMER_ID, 'prod-yoga')

      // Verify orderBy uses expiresAt ascending (soonest first)
      expect(prismaMock.creditItemBalance.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: {
            creditPackPurchase: { expiresAt: 'asc' },
          },
        }),
      )
    })
  })
})
