import { prismaMock } from '@tests/__helpers__/setup'
import {
  getProfitMetrics,
  getVenueProfitMetrics,
  getProfitTimeSeries,
  getProviderComparison,
} from '@/services/superadmin/paymentAnalytics.service'

// The service reads TransactionCardType enum values — mock the enum
jest.mock('@prisma/client', () => {
  const actual = jest.requireActual('@prisma/client')
  return {
    ...actual,
    TransactionCardType: {
      DEBIT: 'DEBIT',
      CREDIT: 'CREDIT',
      AMEX: 'AMEX',
      INTERNATIONAL: 'INTERNATIONAL',
      OTHER: 'OTHER',
    },
  }
})

// Helper: Prisma Decimal mock
const dec = (value: number) => ({
  toNumber: () => value,
  toString: () => String(value),
})

const DATE_RANGE = {
  startDate: new Date('2025-01-01'),
  endDate: new Date('2025-01-31'),
}

describe('PaymentAnalytics Service', () => {
  // ─── getProfitMetrics ─────────────────────────────────────────

  describe('getProfitMetrics', () => {
    it('should return complete profit metrics for happy path', async () => {
      // 1. Aggregate totals
      prismaMock.transactionCost.aggregate.mockResolvedValue({
        _count: 100,
        _sum: {
          amount: dec(50000),
          providerCostAmount: dec(800),
          providerFixedFee: dec(200),
          venueChargeAmount: dec(1200),
          venueFixedFee: dec(300),
          grossProfit: dec(500),
        },
      })

      // 2. GroupBy card type
      prismaMock.transactionCost.groupBy.mockResolvedValue([
        {
          transactionType: 'DEBIT',
          _count: 60,
          _sum: {
            amount: dec(30000),
            providerCostAmount: dec(400),
            providerFixedFee: dec(100),
            venueChargeAmount: dec(700),
            venueFixedFee: dec(150),
            grossProfit: dec(250),
          },
        },
        {
          transactionType: 'CREDIT',
          _count: 40,
          _sum: {
            amount: dec(20000),
            providerCostAmount: dec(400),
            providerFixedFee: dec(100),
            venueChargeAmount: dec(500),
            venueFixedFee: dec(150),
            grossProfit: dec(250),
          },
        },
      ])

      // 3. Top venues via raw SQL
      prismaMock.$queryRaw
        .mockResolvedValueOnce([
          {
            venueId: 'v-1',
            venueName: 'Cafe Norte',
            transactions: BigInt(50),
            volume: dec(25000),
            venueCharge: dec(750),
            profit: dec(300),
          },
        ])
        // 4. Top providers via raw SQL
        .mockResolvedValueOnce([
          {
            providerId: 'prov-1',
            providerCode: 'STRIPE',
            providerName: 'Stripe MX',
            transactions: BigInt(80),
            volume: dec(40000),
            cost: dec(800),
          },
        ])

      const result = await getProfitMetrics(DATE_RANGE)

      // Volume metrics
      expect(result.totalTransactions).toBe(100)
      expect(result.totalVolume).toBe(50000)
      expect(result.averageTransactionSize).toBe(500)

      // Financial
      expect(result.totalProviderCost).toBe(1000) // 800 + 200
      expect(result.totalVenueCharge).toBe(1500) // 1200 + 300
      expect(result.totalProfit).toBe(500)
      expect(result.averageMargin).toBeCloseTo(500 / 1500, 5)

      // Card types — DEBIT and CREDIT have data, others default to 0
      expect(result.byCardType).toHaveLength(5) // All enum values
      const debit = result.byCardType.find(c => c.type === 'DEBIT')!
      expect(debit.transactions).toBe(60)
      expect(debit.volume).toBe(30000)
      const amex = result.byCardType.find(c => c.type === 'AMEX')!
      expect(amex.transactions).toBe(0)
      expect(amex.volume).toBe(0)

      // Top venues
      expect(result.topVenues).toHaveLength(1)
      expect(result.topVenues[0].venueName).toBe('Cafe Norte')
      expect(result.topVenues[0].transactions).toBe(50)

      // Top providers
      expect(result.topProviders).toHaveLength(1)
      expect(result.topProviders[0].providerCode).toBe('STRIPE')
    })

    it('should return zeros and empty defaults when no transactions exist', async () => {
      prismaMock.transactionCost.aggregate.mockResolvedValue({
        _count: 0,
        _sum: {
          amount: null,
          providerCostAmount: null,
          providerFixedFee: null,
          venueChargeAmount: null,
          venueFixedFee: null,
          grossProfit: null,
        },
      })
      prismaMock.transactionCost.groupBy.mockResolvedValue([])
      prismaMock.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([])

      const result = await getProfitMetrics(DATE_RANGE)

      expect(result.totalTransactions).toBe(0)
      expect(result.totalVolume).toBe(0)
      expect(result.averageTransactionSize).toBe(0)
      expect(result.totalProviderCost).toBe(0)
      expect(result.totalVenueCharge).toBe(0)
      expect(result.totalProfit).toBe(0)
      expect(result.averageMargin).toBe(0)

      // All card types should exist with 0 values
      for (const ct of result.byCardType) {
        expect(ct.transactions).toBe(0)
        expect(ct.volume).toBe(0)
      }

      expect(result.topVenues).toEqual([])
      expect(result.topProviders).toEqual([])
    })

    it('should handle margin zero-division when venueCharge is 0', async () => {
      prismaMock.transactionCost.aggregate.mockResolvedValue({
        _count: 5,
        _sum: {
          amount: dec(1000),
          providerCostAmount: dec(50),
          providerFixedFee: dec(10),
          venueChargeAmount: dec(0),
          venueFixedFee: dec(0),
          grossProfit: dec(0),
        },
      })
      prismaMock.transactionCost.groupBy.mockResolvedValue([])
      prismaMock.$queryRaw
        .mockResolvedValueOnce([
          {
            venueId: 'v-1',
            venueName: 'Test',
            transactions: BigInt(5),
            volume: dec(1000),
            venueCharge: dec(0),
            profit: dec(0),
          },
        ])
        .mockResolvedValueOnce([])

      const result = await getProfitMetrics(DATE_RANGE)

      expect(result.averageMargin).toBe(0)
      expect(Number.isFinite(result.averageMargin)).toBe(true)
      expect(result.topVenues[0].margin).toBe(0)
    })
  })

  // ─── getVenueProfitMetrics ────────────────────────────────────

  describe('getVenueProfitMetrics', () => {
    const venueId = 'venue-1'

    it('should return venue totals, byCardType, and byProvider', async () => {
      prismaMock.transactionCost.aggregate.mockResolvedValue({
        _count: 20,
        _sum: {
          amount: dec(10000),
          providerCostAmount: dec(200),
          providerFixedFee: dec(50),
          venueChargeAmount: dec(300),
          venueFixedFee: dec(75),
          grossProfit: dec(125),
        },
      })
      prismaMock.transactionCost.groupBy.mockResolvedValue([
        {
          transactionType: 'DEBIT',
          _count: 15,
          _sum: { amount: dec(7000), grossProfit: dec(80) },
        },
        {
          transactionType: 'CREDIT',
          _count: 5,
          _sum: { amount: dec(3000), grossProfit: dec(45) },
        },
      ])
      prismaMock.$queryRaw.mockResolvedValue([
        {
          providerId: 'prov-1',
          providerCode: 'STRIPE',
          providerName: 'Stripe MX',
          transactions: BigInt(20),
          volume: dec(10000),
          cost: dec(250),
        },
      ])

      const result = await getVenueProfitMetrics(venueId, DATE_RANGE)

      expect(result.venueId).toBe(venueId)
      expect(result.totalTransactions).toBe(20)
      expect(result.totalVolume).toBe(10000)
      expect(result.totalProviderCost).toBe(250) // 200 + 50
      expect(result.totalVenueCharge).toBe(375) // 300 + 75
      expect(result.totalProfit).toBe(125)

      // Card types
      expect(result.byCardType).toHaveLength(5) // All enum values
      const debit = result.byCardType.find((c: any) => c.type === 'DEBIT')!
      expect(debit.transactions).toBe(15)
      expect(debit.volume).toBe(7000)

      // Providers
      expect(result.byProvider).toHaveLength(1)
      expect(result.byProvider[0].providerCode).toBe('STRIPE')
      expect(result.byProvider[0].transactions).toBe(20)
    })

    it('should return all zeros when venue has no transactions', async () => {
      prismaMock.transactionCost.aggregate.mockResolvedValue({
        _count: 0,
        _sum: {
          amount: null,
          providerCostAmount: null,
          providerFixedFee: null,
          venueChargeAmount: null,
          venueFixedFee: null,
          grossProfit: null,
        },
      })
      prismaMock.transactionCost.groupBy.mockResolvedValue([])
      prismaMock.$queryRaw.mockResolvedValue([])

      const result = await getVenueProfitMetrics(venueId, DATE_RANGE)

      expect(result.totalTransactions).toBe(0)
      expect(result.totalVolume).toBe(0)
      expect(result.totalProviderCost).toBe(0)
      expect(result.totalVenueCharge).toBe(0)
      expect(result.totalProfit).toBe(0)
      expect(result.averageMargin).toBe(0)
      expect(result.byCardType.every((c: any) => c.transactions === 0)).toBe(true)
      expect(result.byProvider).toEqual([])
    })
  })

  // ─── getProfitTimeSeries ──────────────────────────────────────

  describe('getProfitTimeSeries', () => {
    it('should return daily data with correct margin calculation', async () => {
      prismaMock.$queryRaw.mockResolvedValue([
        {
          date: '2025-01-15',
          transactions: BigInt(10),
          volume: dec(5000),
          providerCost: dec(100),
          venueCharge: dec(200),
          profit: dec(100),
        },
        {
          date: '2025-01-16',
          transactions: BigInt(8),
          volume: dec(4000),
          providerCost: dec(80),
          venueCharge: dec(160),
          profit: dec(80),
        },
      ])

      const result = await getProfitTimeSeries(DATE_RANGE, 'daily')

      expect(result).toHaveLength(2)
      expect(result[0].date).toBe('2025-01-15')
      expect(result[0].transactions).toBe(10)
      expect(result[0].volume).toBe(5000)
      expect(result[0].margin).toBeCloseTo(100 / 200, 5) // profit / venueCharge
      expect(result[1].margin).toBeCloseTo(80 / 160, 5)
    })

    it('should return empty array when no data exists', async () => {
      prismaMock.$queryRaw.mockResolvedValue([])

      const result = await getProfitTimeSeries(DATE_RANGE, 'daily')

      expect(result).toEqual([])
    })
  })

  // ─── getProviderComparison ────────────────────────────────────

  describe('getProviderComparison', () => {
    it('should return providers with nested byCardType and effectiveRate', async () => {
      prismaMock.$queryRaw.mockResolvedValue([
        {
          providerId: 'prov-1',
          providerCode: 'STRIPE',
          providerName: 'Stripe MX',
          transactionType: 'DEBIT',
          transactions: BigInt(40),
          volume: dec(20000),
          cost: dec(400),
        },
        {
          providerId: 'prov-1',
          providerCode: 'STRIPE',
          providerName: 'Stripe MX',
          transactionType: 'CREDIT',
          transactions: BigInt(20),
          volume: dec(10000),
          cost: dec(300),
        },
        {
          providerId: 'prov-2',
          providerCode: 'CONEKTA',
          providerName: 'Conekta',
          transactionType: 'DEBIT',
          transactions: BigInt(15),
          volume: dec(7500),
          cost: dec(150),
        },
      ])

      const result = await getProviderComparison(DATE_RANGE)

      expect(result).toHaveLength(2)

      // Stripe: 60 txns, 30000 volume, 700 cost
      const stripe = result.find(p => p.providerCode === 'STRIPE')!
      expect(stripe.transactions).toBe(60) // 40 + 20
      expect(stripe.volume).toBe(30000) // 20000 + 10000
      expect(stripe.totalCost).toBe(700) // 400 + 300
      expect(stripe.effectiveRate).toBeCloseTo(700 / 30000, 5)

      // Stripe has byCardType with DEBIT and CREDIT populated, rest zero
      const stripeDebit = stripe.byCardType.find((c: any) => c.type === 'DEBIT')!
      expect(stripeDebit.transactions).toBe(40)
      expect(stripeDebit.effectiveRate).toBeCloseTo(400 / 20000, 5)

      const stripeAmex = stripe.byCardType.find((c: any) => c.type === 'AMEX')!
      expect(stripeAmex.transactions).toBe(0)

      // Conekta
      const conekta = result.find(p => p.providerCode === 'CONEKTA')!
      expect(conekta.transactions).toBe(15)
      expect(conekta.effectiveRate).toBeCloseTo(150 / 7500, 5)
    })

    it('should return empty array when no providers exist', async () => {
      prismaMock.$queryRaw.mockResolvedValue([])

      const result = await getProviderComparison(DATE_RANGE)

      expect(result).toEqual([])
    })
  })
})
