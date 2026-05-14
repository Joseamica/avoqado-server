import prisma from '@/utils/prismaClient'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import * as availableBalanceService from '@/services/dashboard/availableBalance.dashboard.service'
import * as commissionCalculationService from '@/services/dashboard/commission/commission-calculation.service'
import * as commissionPayoutService from '@/services/dashboard/commission/commission-payout.service'
import * as creditPackDashboardService from '@/services/dashboard/creditPack.dashboard.service'
import * as customerDashboardService from '@/services/dashboard/customer.dashboard.service'
import * as paymentLinkService from '@/services/dashboard/paymentLink.service'
import * as paymentDashboardService from '@/services/dashboard/payment.dashboard.service'
import * as reservationService from '@/services/dashboard/reservation.dashboard.service'
import * as teamDashboardService from '@/services/dashboard/team.dashboard.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: {
      findMany: jest.fn(),
    },
    product: {
      findMany: jest.fn(),
    },
    venue: {
      findUnique: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/availableBalance.dashboard.service', () => ({
  getSettlementCalendar: jest.fn(),
}))

jest.mock('@/services/dashboard/commission/commission-calculation.service', () => ({
  getVenueCommissionStats: jest.fn(),
}))

jest.mock('@/services/dashboard/commission/commission-payout.service', () => ({
  getPayoutStats: jest.fn(),
  getPayouts: jest.fn(),
}))

jest.mock('@/services/dashboard/customer.dashboard.service', () => ({
  getCustomerStats: jest.fn(),
  getCustomerById: jest.fn(),
  getCustomers: jest.fn(),
}))

jest.mock('@/services/dashboard/creditPack.dashboard.service', () => ({
  getCustomerPurchases: jest.fn(),
  getCreditPacks: jest.fn(),
}))

jest.mock('@/services/dashboard/paymentLink.service', () => ({
  getPaymentLinks: jest.fn(),
  getPaymentLinkById: jest.fn(),
}))

jest.mock('@/services/dashboard/payment.dashboard.service', () => ({
  getPaymentsData: jest.fn(),
  getPaymentById: jest.fn(),
}))

jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  getReservationStats: jest.fn(),
  getReservations: jest.fn(),
}))

jest.mock('@/services/dashboard/team.dashboard.service', () => ({
  getTeamMembers: jest.fn(),
}))

describe('SharedQueryService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers().setSystemTime(new Date('2026-05-12T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('getPendingOrders', () => {
    it('counts every open order and separates stale orders from recent wait-time metrics', async () => {
      ;(prisma.order.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'order-recent',
          status: 'PENDING',
          createdAt: new Date('2026-05-11T23:30:00.000Z'),
        },
        {
          id: 'order-stale',
          status: 'CONFIRMED',
          createdAt: new Date('2026-05-10T23:30:00.000Z'),
        },
      ])

      const result = await SharedQueryService.getPendingOrders('venue-test')

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId: 'venue-test',
            status: { in: ['PENDING', 'CONFIRMED', 'PREPARING', 'READY'] },
          }),
        }),
      )
      expect((prisma.order.findMany as jest.Mock).mock.calls[0][0].where.createdAt).toBeUndefined()
      expect(result.total).toBe(2)
      expect(result.recentOpenTotal).toBe(1)
      expect(result.staleOpenTotal).toBe(1)
      expect(result.byStatus.pending).toBe(1)
      expect(result.byStatus.confirmed).toBe(1)
      expect(result.averageWaitMinutes).toBe(30)
      expect(result.oldestOrderMinutes).toBe(30)
    })
  })

  describe('getSettlementCalendarForPeriod', () => {
    it('uses the available-balance settlement calendar as source of truth', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'UTC', currency: 'MXN' })
      ;(availableBalanceService.getSettlementCalendar as jest.Mock).mockResolvedValue([
        {
          settlementDate: new Date('2026-05-12T12:00:00.000Z'),
          totalNetAmount: 1000,
          transactionCount: 2,
          status: 'PENDING',
          byCardType: [{ cardType: 'DEBIT', netAmount: 1000, transactionCount: 2 }],
        },
        {
          settlementDate: new Date('2026-05-12T18:00:00.000Z'),
          totalNetAmount: 250.5,
          transactionCount: 1,
          status: 'PENDING',
          byCardType: [{ cardType: 'CREDIT', netAmount: 250.5, transactionCount: 1 }],
        },
      ])

      const result = await SharedQueryService.getSettlementCalendarForPeriod('venue-test', 'today')

      expect(availableBalanceService.getSettlementCalendar).toHaveBeenCalledWith('venue-test', {
        from: new Date('2026-05-12T00:00:00.000Z'),
        to: new Date('2026-05-12T23:59:59.999Z'),
      })
      expect(result.totalNetAmount).toBe(1250.5)
      expect(result.transactionCount).toBe(3)
      expect(result.currency).toBe('MXN')
      expect(result.entries).toHaveLength(2)
    })
  })

  describe('getSettlementDetailForPeriod', () => {
    it('returns settlement entries with card breakdown from the available-balance service', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'UTC', currency: 'MXN' })
      ;(availableBalanceService.getSettlementCalendar as jest.Mock).mockResolvedValue([
        {
          settlementDate: new Date('2026-05-12T12:00:00.000Z'),
          totalNetAmount: 1000,
          transactionCount: 2,
          status: 'PENDING',
          byCardType: [
            { cardType: 'DEBIT', netAmount: 700, transactionCount: 1 },
            { cardType: 'CREDIT', netAmount: 300, transactionCount: 1 },
          ],
        },
      ])

      const result = await SharedQueryService.getSettlementDetailForPeriod('venue-test', 'today')

      expect(result.entries[0].byCardType).toEqual([
        { cardType: 'DEBIT', netAmount: 700, transactionCount: 1 },
        { cardType: 'CREDIT', netAmount: 300, transactionCount: 1 },
      ])
      expect(result.totalNetAmount).toBe(1000)
    })
  })

  describe('getProductSalesByName', () => {
    it('resolves plural and accent-insensitive product names before querying sales', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'UTC', currency: 'MXN' })
      ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'product-jicama',
          name: 'Jícama con chile',
        },
      ])
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([
        {
          productName: 'Jícama con chile',
          quantitySold: BigInt(4),
          revenue: { toNumber: () => 200 },
          orderCount: BigInt(3),
        },
      ])

      const result = await SharedQueryService.getProductSalesByName('venue-test', 'jicamas', 'thisMonth')

      expect(prisma.product.findMany).toHaveBeenCalledWith({
        where: {
          venueId: 'venue-test',
          active: true,
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
        },
        take: 500,
      })
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(result.searchTerm).toBe('jicamas')
      expect(result.productName).toBe('Jícama con chile')
      expect(result.quantitySold).toBe(4)
      expect(result.revenue).toBe(200)
    })
  })

  describe('getPaymentLinks', () => {
    it('uses the dashboard payment link service as source of truth', async () => {
      ;(paymentLinkService.getPaymentLinks as jest.Mock).mockResolvedValue({
        total: 1,
        limit: 10,
        offset: 0,
        hasMore: false,
        paymentLinks: [
          {
            id: 'pl-1',
            title: 'Cena privada',
            shortCode: 'abc12345',
            status: 'ACTIVE',
            purpose: 'PAYMENT',
            amountType: 'FIXED',
            amount: 500,
            currency: 'MXN',
            isReusable: true,
            totalCollected: 1000,
            paymentCount: 2,
            createdAt: new Date('2026-05-12T12:00:00.000Z'),
            expiresAt: null,
            createdBy: { firstName: 'Ana', lastName: 'Admin' },
            _count: { checkoutSessions: 3 },
          },
        ],
      })

      const result = await SharedQueryService.getPaymentLinks('venue-test', { limit: 10, status: 'ACTIVE' })

      expect(paymentLinkService.getPaymentLinks).toHaveBeenCalledWith('venue-test', {
        status: 'ACTIVE',
        search: undefined,
        limit: 10,
        offset: undefined,
      })
      expect(result.links).toEqual([
        expect.objectContaining({
          title: 'Cena privada',
          amount: 500,
          totalCollected: 1000,
          paymentCount: 2,
          checkoutSessionCount: 3,
          createdByName: 'Ana Admin',
        }),
      ])
    })
  })

  describe('getPaymentLinksSummary', () => {
    it('summarizes payment links from the dashboard payment link service', async () => {
      ;(paymentLinkService.getPaymentLinks as jest.Mock).mockResolvedValue({
        total: 2,
        limit: 100,
        offset: 0,
        hasMore: false,
        paymentLinks: [
          {
            id: 'pl-1',
            status: 'ACTIVE',
            amountType: 'FIXED',
            currency: 'MXN',
            totalCollected: 1000,
            paymentCount: 2,
            _count: { checkoutSessions: 3 },
          },
          {
            id: 'pl-2',
            status: 'PAUSED',
            amountType: 'OPEN',
            currency: 'MXN',
            totalCollected: 250,
            paymentCount: 1,
            _count: { checkoutSessions: 1 },
          },
        ],
      })

      const result = await SharedQueryService.getPaymentLinksSummary('venue-test')

      expect(paymentLinkService.getPaymentLinks).toHaveBeenCalledWith('venue-test', { limit: 100, offset: 0 })
      expect(result).toEqual({
        totalLinks: 2,
        activeLinks: 1,
        pausedLinks: 1,
        fixedAmountLinks: 1,
        openAmountLinks: 1,
        totalCollected: 1250,
        paymentCount: 3,
        checkoutSessionCount: 4,
        currency: 'MXN',
      })
    })
  })

  describe('compareProductSales', () => {
    it('compares two product terms with weekend and night filters scoped to the venue', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'UTC', currency: 'MXN' })
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([
        {
          productName: 'Hamburguesa BBQ',
          quantitySold: BigInt(6),
          revenue: { toNumber: () => 900 },
          orderCount: BigInt(4),
        },
        {
          productName: 'Pizza Pepperoni',
          quantitySold: BigInt(3),
          revenue: { toNumber: () => 450 },
          orderCount: BigInt(3),
        },
      ])

      const result = await SharedQueryService.compareProductSales('venue-test', {
        leftTerm: 'hamburguesa',
        rightTerm: 'pizza',
        period: 'thisMonth',
        weekendOnly: true,
        nightOnly: true,
      })

      expect(prisma.venue.findUnique).toHaveBeenCalledWith({
        where: { id: 'venue-test' },
        select: { timezone: true, currency: true },
      })
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        leftTerm: 'hamburguesa',
        rightTerm: 'pizza',
        filters: {
          period: 'thisMonth',
          weekendOnly: true,
          nightOnly: true,
          timezone: 'UTC',
        },
        left: {
          revenue: 900,
          quantitySold: 6,
          orderCount: 4,
          products: ['Hamburguesa BBQ'],
        },
        right: {
          revenue: 450,
          quantitySold: 3,
          orderCount: 3,
          products: ['Pizza Pepperoni'],
        },
        totalRevenue: 1350,
        currency: 'MXN',
      })
    })
  })

  describe('getPaymentLinkDetail', () => {
    it('uses the dashboard payment link detail service and removes customer emails/session IDs', async () => {
      ;(paymentLinkService.getPaymentLinkById as jest.Mock).mockResolvedValue({
        id: 'pl-1',
        title: 'Cena privada',
        shortCode: 'abc12345',
        status: 'ACTIVE',
        purpose: 'PAYMENT',
        amountType: 'FIXED',
        amount: 500,
        currency: 'MXN',
        isReusable: true,
        totalCollected: 1000,
        paymentCount: 2,
        createdAt: new Date('2026-05-12T12:00:00.000Z'),
        expiresAt: null,
        createdBy: { firstName: 'Ana', lastName: 'Admin' },
        checkoutSessions: [
          {
            id: 'session-row-1',
            sessionId: 'provider-secret-session',
            amount: 500,
            status: 'COMPLETED',
            customerEmail: 'customer@example.com',
            createdAt: new Date('2026-05-12T13:00:00.000Z'),
            completedAt: new Date('2026-05-12T13:05:00.000Z'),
          },
        ],
        _count: { checkoutSessions: 1 },
      })

      const result = await SharedQueryService.getPaymentLinkDetail('venue-test', 'pl-1')

      expect(paymentLinkService.getPaymentLinkById).toHaveBeenCalledWith('venue-test', 'pl-1')
      expect(result).toEqual(
        expect.objectContaining({
          title: 'Cena privada',
          url: 'https://pay.avoqado.io/abc12345',
          totalCollected: 1000,
          checkoutSessionCount: 1,
        }),
      )
      expect(JSON.stringify(result)).not.toContain('customer@example.com')
      expect(JSON.stringify(result)).not.toContain('provider-secret-session')
    })
  })

  describe('getCustomerSummary', () => {
    it('uses the dashboard customer stats service and returns aggregate customer data only', async () => {
      ;(customerDashboardService.getCustomerStats as jest.Mock).mockResolvedValue({
        totalCustomers: 10,
        activeCustomers: 8,
        newCustomersThisMonth: 3,
        vipCustomers: 2,
        averageLifetimeValue: 250.5,
        averageVisitsPerCustomer: 4.2,
        topSpenders: [{ id: 'cust-1', name: 'Ana Perez', totalSpent: 1000, totalVisits: 12 }],
      })

      const result = await SharedQueryService.getCustomerSummary('venue-test')

      expect(customerDashboardService.getCustomerStats).toHaveBeenCalledWith('venue-test')
      expect(result.topSpenders).toEqual([{ name: 'Ana Perez', totalSpent: 1000, totalVisits: 12 }])
      expect(JSON.stringify(result)).not.toContain('cust-1')
    })
  })

  describe('getCustomerDetail', () => {
    it('uses the dashboard customer detail service and omits contact/notes fields', async () => {
      ;(customerDashboardService.getCustomerById as jest.Mock).mockResolvedValue({
        id: 'cust-1',
        firstName: 'Ana',
        lastName: 'Perez',
        email: 'ana@example.com',
        phone: '+525500000000',
        notes: 'private note',
        loyaltyPoints: 120,
        totalVisits: 6,
        totalSpent: { toNumber: () => 1500 },
        averageOrderValue: { toNumber: () => 250 },
        active: true,
        customerGroup: { id: 'group-1', name: 'VIP', color: '#fff' },
        tags: ['frecuente'],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        lastVisitAt: new Date('2026-05-12T00:00:00.000Z'),
        orders: [
          {
            id: 'order-1',
            orderNumber: 'ORD-7',
            total: { toNumber: () => 500 },
            status: 'COMPLETED',
            createdAt: new Date('2026-05-12T20:00:00.000Z'),
          },
        ],
        loyaltyTransactions: [
          {
            id: 'tx-1',
            type: 'EARN',
            points: 50,
            createdAt: new Date('2026-05-12T20:00:00.000Z'),
          },
        ],
      })

      const result = await SharedQueryService.getCustomerDetail('venue-test', 'cust-1')

      expect(customerDashboardService.getCustomerById).toHaveBeenCalledWith('venue-test', 'cust-1')
      expect(result).toEqual(
        expect.objectContaining({
          name: 'Ana Perez',
          loyaltyPoints: 120,
          totalSpent: 1500,
          customerGroupName: 'VIP',
        }),
      )
      expect(JSON.stringify(result)).not.toContain('ana@example.com')
      expect(JSON.stringify(result)).not.toContain('+525500000000')
      expect(JSON.stringify(result)).not.toContain('private note')
      expect(JSON.stringify(result)).not.toContain('cust-1')
    })
  })

  describe('searchCustomers', () => {
    it('uses dashboard customer search and omits contact fields and internal IDs', async () => {
      ;(customerDashboardService.getCustomers as jest.Mock).mockResolvedValue({
        data: [
          {
            id: 'cust-1',
            firstName: 'Ana',
            lastName: 'Perez',
            email: 'ana@example.com',
            phone: '+525500000000',
            loyaltyPoints: 120,
            totalVisits: 6,
            totalSpent: 1500,
            averageOrderValue: 250,
            active: true,
            customerGroup: { id: 'group-1', name: 'VIP', color: '#fff' },
            tags: ['frecuente'],
            lastVisitAt: new Date('2026-05-12T00:00:00.000Z'),
            pendingOrderCount: 1,
            pendingBalance: 300,
          },
        ],
        meta: {
          totalCount: 1,
          pageSize: 5,
          currentPage: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
      })

      const result = await SharedQueryService.searchCustomers('venue-test', { search: 'Ana', limit: 5 })

      expect(customerDashboardService.getCustomers).toHaveBeenCalledWith(
        'venue-test',
        1,
        5,
        'Ana',
        undefined,
        undefined,
        undefined,
        'lastVisit',
        'desc',
        undefined,
      )
      expect(result.customers).toEqual([
        expect.objectContaining({
          name: 'Ana Perez',
          customerGroupName: 'VIP',
          totalSpent: 1500,
          pendingBalance: 300,
        }),
      ])
      expect(JSON.stringify(result)).not.toContain('cust-1')
      expect(JSON.stringify(result)).not.toContain('ana@example.com')
      expect(JSON.stringify(result)).not.toContain('+525500000000')
      expect(JSON.stringify(result)).not.toContain('group-1')
    })
  })

  describe('getCreditPackBalance', () => {
    it('uses dashboard credit-pack purchases and returns balances without internal IDs or customer contact', async () => {
      ;(creditPackDashboardService.getCustomerPurchases as jest.Mock).mockResolvedValue({
        purchases: [
          {
            id: 'purchase-1',
            status: 'ACTIVE',
            purchasedAt: new Date('2026-05-01T00:00:00.000Z'),
            expiresAt: new Date('2026-06-01T00:00:00.000Z'),
            customer: { id: 'cust-1', firstName: 'Ana', lastName: 'Perez', email: 'ana@example.com', phone: '+525500000000' },
            creditPack: { name: 'Clases 10' },
            itemBalances: [
              {
                id: 'balance-1',
                initialQuantity: 10,
                remainingQuantity: 7,
                product: { id: 'prod-1', name: 'Yoga', type: 'CLASS' },
              },
            ],
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      })

      const result = await SharedQueryService.getCreditPackBalance('venue-test', 'cust-1')

      expect(creditPackDashboardService.getCustomerPurchases).toHaveBeenCalledWith('venue-test', { customerId: 'cust-1', limit: 20 })
      expect(result).toEqual(
        expect.objectContaining({
          customerName: 'Ana Perez',
          activePurchases: 1,
          totalRemainingCredits: 7,
        }),
      )
      expect(result.balances).toEqual([
        expect.objectContaining({
          packName: 'Clases 10',
          productName: 'Yoga',
          remainingQuantity: 7,
          initialQuantity: 10,
        }),
      ])
      expect(JSON.stringify(result)).not.toContain('balance-1')
      expect(JSON.stringify(result)).not.toContain('purchase-1')
      expect(JSON.stringify(result)).not.toContain('ana@example.com')
    })
  })

  describe('getCreditPacksSummary', () => {
    it('summarizes credit packs without Stripe/product IDs', async () => {
      ;(creditPackDashboardService.getCreditPacks as jest.Mock).mockResolvedValue([
        {
          id: 'pack-1',
          name: 'Clases 10',
          description: 'Paquete privado',
          active: true,
          price: { toNumber: () => 1000 },
          currency: 'MXN',
          validityDays: 30,
          maxPerCustomer: 2,
          stripeProductId: 'prod_secret',
          stripePriceId: 'price_secret',
          _count: { purchases: 4 },
          items: [
            {
              id: 'item-1',
              quantity: 10,
              product: { id: 'prod-1', name: 'Yoga', type: 'CLASS', price: { toNumber: () => 150 } },
            },
          ],
        },
        {
          id: 'pack-2',
          name: 'Masajes 5',
          active: false,
          price: 750,
          currency: 'MXN',
          validityDays: null,
          maxPerCustomer: null,
          _count: { purchases: 1 },
          items: [],
        },
      ])

      const result = await SharedQueryService.getCreditPacksSummary('venue-test')

      expect(creditPackDashboardService.getCreditPacks).toHaveBeenCalledWith('venue-test')
      expect(result).toEqual(
        expect.objectContaining({
          totalPacks: 2,
          activePacks: 1,
          inactivePacks: 1,
          totalPurchases: 5,
          currency: 'MXN',
        }),
      )
      expect(JSON.stringify(result)).not.toContain('pack-1')
      expect(JSON.stringify(result)).not.toContain('prod_secret')
      expect(JSON.stringify(result)).not.toContain('prod-1')
    })
  })

  describe('getCreditPacks', () => {
    it('lists credit packs with product names and without internal IDs', async () => {
      ;(creditPackDashboardService.getCreditPacks as jest.Mock).mockResolvedValue([
        {
          id: 'pack-1',
          name: 'Clases 10',
          active: true,
          price: { toNumber: () => 1000 },
          currency: 'MXN',
          validityDays: 30,
          maxPerCustomer: 2,
          stripeProductId: 'prod_secret',
          _count: { purchases: 4 },
          items: [
            {
              id: 'item-1',
              quantity: 10,
              product: { id: 'prod-1', name: 'Yoga', type: 'CLASS', price: { toNumber: () => 150 } },
            },
          ],
        },
      ])

      const result = await SharedQueryService.getCreditPacks('venue-test', { limit: 10 })

      expect(creditPackDashboardService.getCreditPacks).toHaveBeenCalledWith('venue-test')
      expect(result.packs).toEqual([
        expect.objectContaining({
          name: 'Clases 10',
          active: true,
          price: 1000,
          purchaseCount: 4,
          items: [{ productName: 'Yoga', productType: 'CLASS', quantity: 10 }],
        }),
      ])
      expect(JSON.stringify(result)).not.toContain('pack-1')
      expect(JSON.stringify(result)).not.toContain('prod_secret')
      expect(JSON.stringify(result)).not.toContain('prod-1')
    })
  })

  describe('getTeamMembers', () => {
    it('uses the dashboard team service and strips PINs from chatbot output', async () => {
      ;(teamDashboardService.getTeamMembers as jest.Mock).mockResolvedValue({
        data: [
          {
            id: 'staff-venue-1',
            staffId: 'staff-1',
            firstName: 'Ana',
            lastName: 'Admin',
            email: 'ana@example.com',
            role: 'ADMIN',
            active: true,
            startDate: new Date('2026-01-01T00:00:00.000Z'),
            endDate: null,
            pin: '1234',
            totalSales: 5000,
            totalTips: 500,
            totalOrders: 25,
            averageRating: 0,
            permissionSetId: 'perm-1',
            permissionSetName: 'Admin',
          },
        ],
        meta: {
          totalCount: 1,
          pageSize: 10,
          currentPage: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
      })

      const result = await SharedQueryService.getTeamMembers('venue-test', { limit: 10 })

      expect(teamDashboardService.getTeamMembers).toHaveBeenCalledWith('venue-test', 1, 10, undefined)
      expect(result.members).toEqual([
        {
          staffVenueId: 'staff-venue-1',
          staffId: 'staff-1',
          name: 'Ana Admin',
          role: 'ADMIN',
          active: true,
          totalSales: 5000,
          totalTips: 500,
          totalOrders: 25,
          permissionSetName: 'Admin',
        },
      ])
      expect(JSON.stringify(result)).not.toContain('1234')
      expect(JSON.stringify(result)).not.toContain('ana@example.com')
    })
  })

  describe('getCommissionsSummary', () => {
    it('uses the dashboard commission stats service as source of truth', async () => {
      ;(commissionCalculationService.getVenueCommissionStats as jest.Mock).mockResolvedValue({
        totalPaid: 1000,
        totalPending: 250,
        totalApproved: 500,
        staffWithCommissions: 3,
        averageCommission: 125,
        topEarners: [{ staffId: 'staff-1', staffName: 'Ana Admin', totalEarned: 750, calculationCount: 6 }],
      })

      const result = await SharedQueryService.getCommissionsSummary('venue-test')

      expect(commissionCalculationService.getVenueCommissionStats).toHaveBeenCalledWith('venue-test')
      expect(result.topEarners).toEqual([{ staffName: 'Ana Admin', totalEarned: 750, calculationCount: 6 }])
      expect(JSON.stringify(result)).not.toContain('staff-1')
    })
  })

  describe('getCommissionPayoutsSummary', () => {
    it('uses commission payout dashboard services and removes staff email/payment references', async () => {
      ;(commissionPayoutService.getPayoutStats as jest.Mock).mockResolvedValue({
        totalPaid: 1000,
        totalPending: 300,
        payoutCount: 2,
        averagePayout: 500,
      })
      ;(commissionPayoutService.getPayouts as jest.Mock).mockResolvedValue([
        {
          id: 'payout-1',
          amount: { toNumber: () => 700 },
          status: 'PAID',
          paymentMethod: 'BANK_TRANSFER',
          paymentReference: 'secret-bank-ref',
          notes: 'private note',
          createdAt: new Date('2026-05-12T12:00:00.000Z'),
          paidAt: new Date('2026-05-12T18:00:00.000Z'),
          staff: { id: 'staff-1', firstName: 'Ana', lastName: 'Admin', email: 'ana@example.com' },
          summary: {
            periodStart: new Date('2026-05-01T00:00:00.000Z'),
            periodEnd: new Date('2026-05-12T23:59:59.999Z'),
            netAmount: { toNumber: () => 700 },
          },
        },
      ])

      const result = await SharedQueryService.getCommissionPayoutsSummary('venue-test', { limit: 5 })

      expect(commissionPayoutService.getPayoutStats).toHaveBeenCalledWith('venue-test')
      expect(commissionPayoutService.getPayouts).toHaveBeenCalledWith('venue-test', {})
      expect(result.recentPayouts).toEqual([
        expect.objectContaining({
          amount: 700,
          status: 'PAID',
          staffName: 'Ana Admin',
        }),
      ])
      expect(JSON.stringify(result)).not.toContain('ana@example.com')
      expect(JSON.stringify(result)).not.toContain('secret-bank-ref')
      expect(JSON.stringify(result)).not.toContain('private note')
    })
  })

  describe('getPaymentDetail', () => {
    it('uses the dashboard payment detail service and strips processor-sensitive fields', async () => {
      ;(paymentDashboardService.getPaymentById as jest.Mock).mockResolvedValue({
        id: 'payment-1',
        amount: 500,
        tipAmount: 50,
        netAmount: 550,
        currency: 'MXN',
        status: 'COMPLETED',
        method: 'CARD',
        source: 'TPV',
        cardBrand: 'VISA',
        last4: '4242',
        maskedPan: '411111******4242',
        authorizationNumber: 'secret-auth',
        referenceNumber: 'secret-ref',
        createdAt: new Date('2026-05-12T20:00:00.000Z'),
        processedBy: { firstName: 'Ana', lastName: 'Admin', email: 'ana@example.com' },
        order: {
          orderNumber: 'ORD-7',
          table: { number: '12' },
          customer: { email: 'customer@example.com', phone: '+525500000000' },
          items: [
            {
              name: 'Taco',
              quantity: 2,
              unitPrice: 100,
              total: 200,
            },
          ],
        },
        merchantAccount: { displayName: 'Stripe MXN', provider: { name: 'Stripe' } },
      })

      const result = await SharedQueryService.getPaymentDetail('venue-test', 'payment-1')

      expect(paymentDashboardService.getPaymentById).toHaveBeenCalledWith('venue-test', 'payment-1')
      expect(result).toEqual(
        expect.objectContaining({
          amount: 500,
          tipAmount: 50,
          method: 'CARD',
          last4: '4242',
          processedByName: 'Ana Admin',
          orderNumber: 'ORD-7',
        }),
      )
      expect(JSON.stringify(result)).not.toContain('411111')
      expect(JSON.stringify(result)).not.toContain('secret-auth')
      expect(JSON.stringify(result)).not.toContain('secret-ref')
      expect(JSON.stringify(result)).not.toContain('customer@example.com')
    })
  })

  describe('getReservationSummary', () => {
    it('uses the dashboard reservation stats service as source of truth', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'UTC' })
      ;(reservationService.getReservationStats as jest.Mock).mockResolvedValue({
        total: 3,
        byStatus: { CONFIRMED: 2, PENDING: 1 },
        byChannel: { WEB: 2, PHONE: 1 },
        noShowRate: 0,
      })

      const result = await SharedQueryService.getReservationSummary('venue-test', 'today')

      expect(reservationService.getReservationStats).toHaveBeenCalledWith(
        'venue-test',
        new Date('2026-05-12T00:00:00.000Z'),
        new Date('2026-05-12T23:59:59.999Z'),
      )
      expect(result).toEqual(
        expect.objectContaining({
          total: 3,
          byStatus: { CONFIRMED: 2, PENDING: 1 },
          period: 'today',
        }),
      )
    })
  })

  describe('getReservations', () => {
    it('uses the dashboard reservation list service and removes sensitive fields from the summary', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'UTC' })
      ;(reservationService.getReservations as jest.Mock).mockResolvedValue({
        data: [
          {
            confirmationCode: 'RES-ABC123',
            status: 'CONFIRMED',
            channel: 'WEB',
            startsAt: new Date('2026-05-12T20:00:00.000Z'),
            endsAt: new Date('2026-05-12T21:00:00.000Z'),
            partySize: 4,
            guestName: 'Mesa Perez',
            guestPhone: '+525500000000',
            guestEmail: 'guest@example.com',
            internalNotes: 'VIP',
            cancelSecret: 'secret',
            customer: { firstName: 'Ana', lastName: 'Perez', phone: '+525511111111', email: 'ana@example.com' },
            table: { number: '12' },
            product: { name: 'Cena' },
            assignedStaff: { firstName: 'Luis', lastName: 'Host' },
          },
        ],
        meta: { total: 1, page: 1, pageSize: 10, totalPages: 1 },
      })

      const result = await SharedQueryService.getReservations('venue-test', 'today', { limit: 10, status: 'confirmed' })

      expect(reservationService.getReservations).toHaveBeenCalledWith(
        'venue-test',
        {
          dateFrom: new Date('2026-05-12T00:00:00.000Z'),
          dateTo: new Date('2026-05-12T23:59:59.999Z'),
          status: 'CONFIRMED',
          search: undefined,
        },
        1,
        10,
      )
      expect(result.reservations).toEqual([
        {
          confirmationCode: 'RES-ABC123',
          status: 'CONFIRMED',
          channel: 'WEB',
          startsAt: new Date('2026-05-12T20:00:00.000Z'),
          endsAt: new Date('2026-05-12T21:00:00.000Z'),
          partySize: 4,
          guestName: 'Mesa Perez',
          customerName: 'Ana Perez',
          tableNumber: '12',
          productName: 'Cena',
          assignedStaffName: 'Luis Host',
        },
      ])
      expect(JSON.stringify(result)).not.toContain('guest@example.com')
      expect(JSON.stringify(result)).not.toContain('+525500000000')
      expect(JSON.stringify(result)).not.toContain('secret')
      expect(JSON.stringify(result)).not.toContain('VIP')
    })
  })

  describe('getPayments', () => {
    it('uses the dashboard payment service as source of truth and returns a safe list', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'UTC', currency: 'MXN' })
      ;(paymentDashboardService.getPaymentsData as jest.Mock).mockResolvedValue({
        data: [
          {
            id: 'payment-1',
            amount: 500,
            tipAmount: 50,
            netAmount: 550,
            currency: 'MXN',
            status: 'COMPLETED',
            method: 'CARD',
            source: 'TPV',
            cardBrand: 'VISA',
            last4: '4242',
            maskedPan: '411111******4242',
            authorizationNumber: 'secret-auth',
            referenceNumber: 'ref-123',
            createdAt: new Date('2026-05-12T20:00:00.000Z'),
            processedBy: { firstName: 'Ana', lastName: 'Admin' },
            order: { orderNumber: 'ORD-7', table: { number: '12' } },
            merchantAccount: { name: 'Stripe MXN', provider: { name: 'Stripe' } },
          },
        ],
        meta: { total: 1, page: 1, pageSize: 10, pageCount: 1 },
      })

      const result = await SharedQueryService.getPayments('venue-test', 'today', { limit: 10 })

      expect(paymentDashboardService.getPaymentsData).toHaveBeenCalledWith('venue-test', 1, 10, {
        startDate: '2026-05-12T00:00:00.000Z',
        endDate: '2026-05-12T23:59:59.999Z',
        method: undefined,
        source: undefined,
        search: undefined,
      })
      expect(result.payments).toEqual([
        expect.objectContaining({
          id: 'payment-1',
          amount: 500,
          tipAmount: 50,
          currency: 'MXN',
          status: 'COMPLETED',
          method: 'CARD',
          last4: '4242',
          processedByName: 'Ana Admin',
          orderNumber: 'ORD-7',
          tableNumber: '12',
        }),
      ])
      expect(JSON.stringify(result)).not.toContain('411111')
      expect(JSON.stringify(result)).not.toContain('secret-auth')
    })

    it('summarizes returned dashboard payments without exposing card data', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'UTC', currency: 'MXN' })
      ;(paymentDashboardService.getPaymentsData as jest.Mock).mockResolvedValue({
        data: [
          {
            id: 'payment-1',
            amount: 500,
            tipAmount: 50,
            currency: 'MXN',
            status: 'COMPLETED',
            method: 'CARD',
            source: 'TPV',
            createdAt: new Date('2026-05-12T20:00:00.000Z'),
          },
          {
            id: 'payment-2',
            amount: 100,
            tipAmount: 0,
            currency: 'MXN',
            status: 'REFUNDED',
            method: 'CASH',
            source: 'MANUAL',
            createdAt: new Date('2026-05-12T21:00:00.000Z'),
          },
        ],
        meta: { total: 2, page: 1, pageSize: 100, pageCount: 1 },
      })

      const result = await SharedQueryService.getPaymentsSummary('venue-test', 'today')

      expect(paymentDashboardService.getPaymentsData).toHaveBeenCalledWith('venue-test', 1, 100, {
        startDate: '2026-05-12T00:00:00.000Z',
        endDate: '2026-05-12T23:59:59.999Z',
      })
      expect(result).toEqual(
        expect.objectContaining({
          totalPayments: 2,
          completedPayments: 1,
          refundedPayments: 1,
          totalAmount: 600,
          totalTips: 50,
          currency: 'MXN',
        }),
      )
    })
  })
})
