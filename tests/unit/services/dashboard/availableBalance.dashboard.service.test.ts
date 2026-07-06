/**
 * Regression guard for the Available Balance fee math.
 *
 * Bug (2026-07-04): getAvailableBalance netted only `venueChargeAmount` and
 * dropped `venueFixedFee`, so a venue with a per-transaction fixed fee saw an
 * overstated net / understated fees — and it disagreed with the Sales Summary
 * breakdown (which nets both) and the stored settlement net. These tests pin:
 *   - totalFees / net include venueFixedFee
 *   - card payments with NO TransactionCost are surfaced as uncosted{Count,Amount}
 *   - money is available AUTOMATICALLY once its settlement date passes (no manual
 *     "confirmar liquidación" needed)
 */

import { getAvailableBalance, getSettlementTimeline } from '@/services/dashboard/availableBalance.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { formatInTimeZone } from 'date-fns-tz'

// getLastCloseoutDate hits its own prisma path — pin it so the cash query window
// is deterministic and the test focuses on the fee math.
jest.mock('@/services/dashboard/cashCloseout.dashboard.service', () => ({
  getLastCloseoutDate: jest.fn().mockResolvedValue(new Date('2000-01-01T00:00:00.000Z')),
}))

const VENUE = 'venue-amaena'

describe('getAvailableBalance — venueFixedFee + uncosted', () => {
  it('nets out venueChargeAmount + venueFixedFee (not just the percentage charge)', async () => {
    ;(prismaMock.payment.findMany as jest.Mock)
      // Card payments (first call)
      .mockResolvedValueOnce([
        {
          amount: 100,
          tipAmount: 0,
          transactionCost: { venueChargeAmount: 3, venueFixedFee: 2 },
          // Far-future settlement date → unambiguously still pending, regardless of the clock.
          transaction: { status: 'PENDING', estimatedSettlementDate: new Date('2099-01-01T00:00:00.000Z'), netSettlementAmount: null },
        },
      ])
      // Cash payments (second call)
      .mockResolvedValueOnce([])

    const summary = await getAvailableBalance(VENUE)

    // fee = 3 + 2 = 5 (the bug reported only 3)
    expect(summary.totalFees).toBe(5)
    // net = 100 - 5 = 95, pending (no stored netSettlementAmount → computed net)
    expect(summary.pendingSettlement).toBe(95)
    expect(summary.uncostedCount).toBe(0)
    expect(summary.uncostedAmount).toBe(0)
  })

  it('auto-settles by date: a PENDING transaction whose settlement date has passed counts as available', async () => {
    ;(prismaMock.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([
        // DB says PENDING, but its settlement date is in the PAST → the money landed.
        // No manual "confirmar liquidación" needed; it must show as available.
        {
          amount: 100,
          tipAmount: 0,
          transactionCost: { venueChargeAmount: 4, venueFixedFee: 0 },
          transaction: { status: 'PENDING', estimatedSettlementDate: new Date('2000-01-05T00:00:00.000Z'), netSettlementAmount: 96 },
        },
        // Future settlement date → genuinely still pending.
        {
          amount: 100,
          tipAmount: 0,
          transactionCost: { venueChargeAmount: 4, venueFixedFee: 0 },
          transaction: { status: 'PENDING', estimatedSettlementDate: new Date('2099-01-01T00:00:00.000Z'), netSettlementAmount: 96 },
        },
      ])
      .mockResolvedValueOnce([])

    const summary = await getAvailableBalance(VENUE)

    expect(summary.availableNow).toBe(96) // past-dated one landed (no cash here)
    expect(summary.pendingSettlement).toBe(96) // future-dated one still pending
  })

  it('surfaces card money with no TransactionCost as uncosted (fee 0, counted in balance)', async () => {
    ;(prismaMock.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([
        // Costed
        {
          amount: 200,
          tipAmount: 0,
          transactionCost: { venueChargeAmount: 6, venueFixedFee: 2 },
          transaction: { status: 'SETTLED', estimatedSettlementDate: null, netSettlementAmount: 192 },
        },
        // Uncosted (e.g. merchant account without a VenuePricingStructure)
        {
          amount: 500,
          tipAmount: 0,
          transactionCost: null,
          transaction: null,
        },
      ])
      .mockResolvedValueOnce([{ amount: 30, tipAmount: 0 }])

    const summary = await getAvailableBalance(VENUE)

    expect(summary.uncostedCount).toBe(1)
    expect(summary.uncostedAmount).toBe(500)
    // Costed fee only (uncosted contributes 0 fee)
    expect(summary.totalFees).toBe(8)
    // Settled uses stored net (192); cash is immediately available (30)
    expect(summary.availableNow).toBe(222)
    // Uncosted card money is still owed → pending at fee 0
    expect(summary.pendingSettlement).toBe(500)
  })
})

describe('getAvailableBalance — estimatedNextSettlement recomputes live (matches the week strip)', () => {
  const TZ = 'America/Mexico_City'

  beforeEach(() => {
    ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: TZ })
  })

  it('uses the LIVE recomputed net, not a stale stored netSettlementAmount, for the next-deposit amount', async () => {
    // Stored netSettlementAmount = 1.90 (computed before a later fee adjustment).
    // Live transactionCost now yields 1.89 (2.00 gross − 0.11 fee). The hero must
    // show 1.89 — the same number the settlement-week strip computes independently
    // from the SAME transactionCost row — never the stale stored 1.90.
    ;(prismaMock.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([
        {
          amount: 2.0,
          tipAmount: 0,
          createdAt: new Date('2098-12-30T14:00:00Z'), // far future — always still "pending" regardless of when this test runs
          merchantAccountId: 'm1',
          transactionCost: { venueChargeAmount: 0.11, venueFixedFee: 0, transactionType: 'CREDIT' },
          transaction: { status: 'PENDING', estimatedSettlementDate: new Date('2099-01-01T00:00:00Z'), netSettlementAmount: 1.9 },
        },
      ])
      .mockResolvedValueOnce([])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValueOnce([
      {
        merchantAccountId: 'm1',
        cardType: 'CREDIT',
        settlementDays: 1,
        settlementDayType: 'BUSINESS_DAYS',
        cutoffTime: '23:00',
        cutoffTimezone: TZ,
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: null,
      },
    ])

    const summary = await getAvailableBalance(VENUE)

    expect(summary.estimatedNextSettlement.amount).toBeCloseTo(1.89, 5) // live, NOT the stale stored 1.90
    expect(summary.pendingSettlement).toBeCloseTo(1.89, 5)
  })

  it('never rewrites SETTLED money: uses the stored net even if live recompute would differ', async () => {
    ;(prismaMock.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([
        {
          amount: 2.0,
          tipAmount: 0,
          createdAt: new Date('2026-07-06T14:00:00Z'),
          merchantAccountId: 'm1',
          transactionCost: { venueChargeAmount: 0.11, venueFixedFee: 0, transactionType: 'CREDIT' },
          // Already SETTLED — the bank already moved 1.90; a later rate change must NOT retroactively change it.
          transaction: { status: 'SETTLED', estimatedSettlementDate: new Date('2026-07-01T00:00:00Z'), netSettlementAmount: 1.9 },
        },
      ])
      .mockResolvedValueOnce([])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValueOnce([
      {
        merchantAccountId: 'm1',
        cardType: 'CREDIT',
        settlementDays: 1,
        settlementDayType: 'BUSINESS_DAYS',
        cutoffTime: '23:00',
        cutoffTimezone: TZ,
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: null,
      },
    ])

    const summary = await getAvailableBalance(VENUE)

    expect(summary.availableNow).toBeCloseTo(1.9, 5) // stored net kept, not recomputed to 1.89
  })

  it('buckets the next deposit by VENUE-LOCAL day, not UTC day — two payments landing the SAME local day (different UTC days) must combine into one', async () => {
    // Both payments have NO settlement config (merchant 'm2') → honest fallback to the
    // STORED estimatedSettlementDate, isolating this test to the BUCKETING key alone
    // (not the live-recompute behavior covered by the previous test). Far-future dates
    // (2099) so "already landed" never triggers regardless of when this test runs.
    //   Payment A: 2099-01-03T23:00:00Z = 2099-01-03 17:00 MX (venue-local Jan 3, UTC Jan 3)
    //   Payment B: 2099-01-04T02:00:00Z = 2099-01-03 20:00 MX (venue-local Jan 3, UTC Jan 4!)
    // A naive UTC bucket (`.toISOString().split('T')[0]`) splits these into "01-03" and
    // "01-04" — the OLD code's "first upcoming day" would show ONLY payment A's 40,
    // silently dropping B's 56 that the venue-local week strip counts on the SAME day.
    // Venue-local bucketing correctly merges both into one "01-03" day totaling 96.
    ;(prismaMock.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([
        {
          amount: 40,
          tipAmount: 0,
          createdAt: new Date('2098-12-30T14:00:00Z'),
          merchantAccountId: 'm2',
          transactionCost: { venueChargeAmount: 0, venueFixedFee: 0, transactionType: 'CREDIT' },
          transaction: { status: 'PENDING', estimatedSettlementDate: new Date('2099-01-03T23:00:00Z'), netSettlementAmount: 40 },
        },
        {
          amount: 56,
          tipAmount: 0,
          createdAt: new Date('2098-12-30T15:00:00Z'),
          merchantAccountId: 'm2',
          transactionCost: { venueChargeAmount: 0, venueFixedFee: 0, transactionType: 'CREDIT' },
          transaction: { status: 'PENDING', estimatedSettlementDate: new Date('2099-01-04T02:00:00Z'), netSettlementAmount: 56 },
        },
      ])
      .mockResolvedValueOnce([])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValueOnce([]) // no config → honest fallback for both

    const summary = await getAvailableBalance(VENUE)

    expect(formatInTimeZone(summary.estimatedNextSettlement.date!, TZ, 'yyyy-MM-dd')).toBe('2099-01-03')
    expect(summary.estimatedNextSettlement.amount).toBe(96) // 40 + 56, both merged into the correct venue-local day
  })

  it('falls back to the stored date/net when the payment has no settlement rule (honest fallback)', async () => {
    ;(prismaMock.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([
        {
          amount: 50,
          tipAmount: 0,
          createdAt: new Date('2026-07-04T02:00:00Z'),
          merchantAccountId: 'm2', // no config for this merchant
          transactionCost: { venueChargeAmount: 2, venueFixedFee: 0, transactionType: 'CREDIT' },
          transaction: { status: 'PENDING', estimatedSettlementDate: new Date('2099-01-05T00:00:00Z'), netSettlementAmount: 48 },
        },
      ])
      .mockResolvedValueOnce([])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValueOnce([])

    const summary = await getAvailableBalance(VENUE)

    expect(summary.estimatedNextSettlement.amount).toBe(48) // stored net kept — honest, not silently zeroed
    expect(summary.estimatedNextSettlement.date?.toISOString()).toBe('2099-01-05T00:00:00.000Z')
  })
})

describe('getSettlementTimeline — recompute-on-read settlement dates', () => {
  const TZ = 'America/Mexico_City'
  const range = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-10T00:00:00Z') }
  const dateKey = (d: Date | null) => (d ? formatInTimeZone(d, TZ, 'yyyy-MM-dd') : null)

  beforeEach(() => {
    ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: TZ })
  })

  it('recomputes the settlement date live and IGNORES a stale stored weekend date', async () => {
    // Sold Fri 2026-07-03 20:00 MX. Pre-fix engine stored a SUNDAY (07-05) landing;
    // the corrected engine (1 business day) lands it MONDAY 07-06. The timeline must
    // show the recomputed Monday, not the stored Sunday — otherwise it contradicts
    // the week strip on the same page.
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValueOnce([
      {
        amount: 1000,
        tipAmount: 0,
        method: 'CREDIT_CARD',
        createdAt: new Date('2026-07-04T02:00:00Z'), // Fri 20:00 MX
        merchantAccountId: 'm1',
        transactionCost: { venueChargeAmount: 30, venueFixedFee: 5, transactionType: 'CREDIT' },
        transaction: { status: 'PENDING', estimatedSettlementDate: new Date('2026-07-05T06:00:00Z'), netSettlementAmount: null }, // stale SUNDAY
      },
    ])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValueOnce([
      {
        merchantAccountId: 'm1',
        cardType: 'CREDIT',
        settlementDays: 1,
        settlementDayType: 'BUSINESS_DAYS',
        cutoffTime: '23:00',
        cutoffTimezone: TZ,
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: null,
      },
    ])

    const timeline = await getSettlementTimeline('v1', range)

    expect(timeline).toHaveLength(1)
    expect(dateKey(timeline[0].estimatedSettlementDate)).toBe('2026-07-06') // Monday (recomputed), NOT stored 07-05
  })

  it('falls back to the stored date when the payment has no settlement rule', async () => {
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValueOnce([
      {
        amount: 500,
        tipAmount: 0,
        method: 'CREDIT_CARD',
        createdAt: new Date('2026-07-04T02:00:00Z'),
        merchantAccountId: 'm2', // no config for this merchant
        transactionCost: { venueChargeAmount: 15, venueFixedFee: 0, transactionType: 'CREDIT' },
        transaction: { status: 'PENDING', estimatedSettlementDate: new Date('2026-07-07T06:00:00Z'), netSettlementAmount: null },
      },
    ])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValueOnce([])

    const timeline = await getSettlementTimeline('v1', range)

    expect(timeline).toHaveLength(1)
    expect(dateKey(timeline[0].estimatedSettlementDate)).toBe('2026-07-07') // stored date kept (honest fallback)
  })

  it('cash gets no settlement date (instant), and groups split per card type', async () => {
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValueOnce([
      {
        amount: 2000,
        tipAmount: 0,
        method: 'CASH',
        createdAt: new Date('2026-07-04T18:00:00Z'),
        merchantAccountId: null,
        transactionCost: null,
        transaction: null,
      },
      {
        amount: 100,
        tipAmount: 0,
        method: 'CREDIT_CARD',
        createdAt: new Date('2026-07-04T18:00:00Z'), // same venue-day as the cash payment
        merchantAccountId: 'm1',
        transactionCost: { venueChargeAmount: 4, venueFixedFee: 0, transactionType: 'CREDIT' },
        transaction: { status: 'PENDING', estimatedSettlementDate: null, netSettlementAmount: null },
      },
    ])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValueOnce([
      {
        merchantAccountId: 'm1',
        cardType: 'CREDIT',
        settlementDays: 1,
        settlementDayType: 'BUSINESS_DAYS',
        cutoffTime: '23:00',
        cutoffTimezone: TZ,
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: null,
      },
    ])

    const timeline = await getSettlementTimeline('v1', range)

    expect(timeline).toHaveLength(2) // one CASH group + one CREDIT group, same day
    const cash = timeline.find(t => t.cardType === 'CASH')!
    const credit = timeline.find(t => t.cardType === 'CREDIT')!
    expect(cash.estimatedSettlementDate).toBeNull()
    // Sat sale (12:00 MX) + 1 business day → Monday 07-06; recomputed even though nothing was stored.
    expect(dateKey(credit.estimatedSettlementDate)).toBe('2026-07-06')
  })
})
