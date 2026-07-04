import {
  getSettlementsLandingInWeek,
  projectPaymentSettlement,
  venueWeekBounds,
} from '@/services/dashboard/settlementCalendar.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { formatInTimeZone } from 'date-fns-tz'

const TZ = 'America/Mexico_City'

const cfg = {
  merchantAccountId: 'm1',
  cardType: 'CREDIT' as const,
  settlementDays: 1,
  settlementDayType: 'BUSINESS_DAYS' as const,
  cutoffTime: '23:00',
  cutoffTimezone: TZ,
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
}

describe('projectPaymentSettlement', () => {
  it('projects net = gross − (charge+fixed) onto the venue-tz settlement day', () => {
    const p = {
      amount: 1000,
      tipAmount: 50,
      createdAt: new Date('2026-07-04T02:00:00Z'),
      merchantAccountId: 'm1',
      transactionCost: { transactionType: 'CREDIT' as const, venueChargeAmount: 30, venueFixedFee: 5 },
    }
    expect(projectPaymentSettlement(p, [cfg], TZ)).toEqual({
      settlementDateKey: '2026-07-06',
      gross: 1050,
      commission: 35,
      net: 1015,
      settlementDays: 1,
    })
  })

  it('returns null with no cost', () => {
    const p = {
      amount: 100,
      tipAmount: 0,
      createdAt: new Date('2026-07-01T18:00:00Z'),
      merchantAccountId: 'm1',
      transactionCost: null,
    }
    expect(projectPaymentSettlement(p, [cfg], TZ)).toBeNull()
  })

  it('returns null when no active config matches the merchant×cardType', () => {
    const p = {
      amount: 100,
      tipAmount: 0,
      createdAt: new Date('2026-07-01T18:00:00Z'),
      merchantAccountId: 'zzz',
      transactionCost: { transactionType: 'CREDIT' as const, venueChargeAmount: 4, venueFixedFee: 0 },
    }
    expect(projectPaymentSettlement(p, [cfg], TZ)).toBeNull()
  })
})

describe('getSettlementsLandingInWeek', () => {
  const merchant = { displayName: 'Amaena - B', alias: null, provider: { name: 'AngelPay (Nexgo)' } }
  // Week Mon 2026-07-06 → Sun 2026-07-12, in venue tz (MX = UTC−6).
  const weekStart = new Date('2026-07-06T06:00:00Z') // Mon 00:00 MX
  const weekEnd = new Date('2026-07-13T05:59:59Z') // Sun 23:59 MX

  it('buckets net by SETTLEMENT day: cross-week sales land in-week; no-rule & out-of-week excluded', async () => {
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue([
      // Sold Fri 2026-07-03 20:00 MX → 1 biz day → lands Mon 07-06 (in week)
      {
        amount: 1000,
        tipAmount: 0,
        createdAt: new Date('2026-07-04T02:00:00Z'),
        merchantAccountId: 'm1',
        transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 30, venueFixedFee: 5 },
        merchantAccount: merchant,
      },
      // Sold Mon 2026-07-06 12:00 MX → 1 biz day → lands Tue 07-07 (in week)
      {
        amount: 500,
        tipAmount: 50,
        createdAt: new Date('2026-07-06T18:00:00Z'),
        merchantAccountId: 'm1',
        transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 16.5, venueFixedFee: 5 },
        merchantAccount: merchant,
      },
      // No active config (merchant m2) → cannot be placed on any landing day → excluded
      {
        amount: 700,
        tipAmount: 0,
        createdAt: new Date('2026-07-05T18:00:00Z'),
        merchantAccountId: 'm2',
        transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 25, venueFixedFee: 0 },
        merchantAccount: { displayName: 'Sin regla', alias: null, provider: { name: 'Blumon' } },
      },
      // Sold Sat 2026-07-11 20:00 MX → 1 biz day → lands Mon 07-13 (NEXT week) → excluded
      {
        amount: 200,
        tipAmount: 0,
        createdAt: new Date('2026-07-12T02:00:00Z'),
        merchantAccountId: 'm1',
        transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 6, venueFixedFee: 0 },
        merchantAccount: merchant,
      },
    ])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([
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

    const r = await getSettlementsLandingInWeek('v1', weekStart, weekEnd, TZ)

    expect(r.weekStart).toBe('2026-07-06')
    expect(r.weekEnd).toBe('2026-07-12')
    expect(r.days.map(d => d.date)).toEqual(['2026-07-06', '2026-07-07']) // sorted; P3 no-rule + P4 next-week gone
    const [mon, tue] = r.days
    expect(mon).toMatchObject({ date: '2026-07-06', gross: 1000, commission: 35, net: 965, count: 1 })
    expect(mon.byMerchant).toEqual([
      { merchantAccountId: 'm1', displayName: 'Amaena - B', provider: 'AngelPay (Nexgo)', gross: 1000, commission: 35, net: 965, count: 1 },
    ])
    expect(mon.byCardType).toEqual([{ cardType: 'CREDIT', gross: 1000, commission: 35, net: 965, count: 1 }])
    expect(tue).toMatchObject({ date: '2026-07-07', gross: 550, commission: 21.5, net: 528.5, count: 1 })
    expect(r.weekTotal).toEqual({ gross: 1550, commission: 56.5, net: 1493.5, count: 2 })
    expect(['settled', 'today', 'projected']).toContain(mon.status)
  })

  it('returns an empty week (no days, zero totals) when nothing lands', async () => {
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue([])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([])
    const r = await getSettlementsLandingInWeek('v1', weekStart, weekEnd, TZ)
    expect(r.days).toEqual([])
    expect(r.weekTotal).toEqual({ gross: 0, commission: 0, net: 0, count: 0 })
  })
})

describe('venueWeekBounds', () => {
  const dateKey = (d: Date) => formatInTimeZone(d, TZ, 'yyyy-MM-dd')

  it('returns the Monday–Sunday venue-local week containing a mid-week date', () => {
    const { weekStart, weekEnd } = venueWeekBounds('2026-07-08', TZ) // Wed
    expect(dateKey(weekStart)).toBe('2026-07-06') // Mon
    expect(dateKey(weekEnd)).toBe('2026-07-12') // Sun
  })

  it('anchors correctly at the week edges (Monday and Sunday map to the same week)', () => {
    expect(dateKey(venueWeekBounds('2026-07-06', TZ).weekStart)).toBe('2026-07-06') // Monday itself
    expect(dateKey(venueWeekBounds('2026-07-12', TZ).weekStart)).toBe('2026-07-06') // Sunday → same Monday
    expect(dateKey(venueWeekBounds('2026-07-13', TZ).weekStart)).toBe('2026-07-13') // next Monday
  })

  it('week spans exactly 7 venue-local days', () => {
    const { weekStart, weekEnd } = venueWeekBounds('2026-07-08', TZ)
    // Sunday 23:59:59.999 minus Monday 00:00 ≈ 7 days
    expect(weekEnd.getTime() - weekStart.getTime()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000)
    expect(weekEnd.getTime() - weekStart.getTime()).toBeLessThan(7 * 24 * 60 * 60 * 1000)
  })

  const isMonday = (d: Date) => new Date(dateKey(d) + 'T12:00:00Z').getUTCDay() === 1

  // Regression (from /full-testing): `weekStart` is a user-controlled query param.
  // These parse to NaN → pre-fix they produced an Invalid Date that crashed the
  // downstream Prisma query (500). Must fall back to a valid Monday-anchored week.
  // (Each case here genuinely FAILS without the fix — Invalid Date → getTime() NaN.)
  it.each(['garbage', '', 'DROP TABLE', '2026/07/08'])(
    'never yields an Invalid Date for unparseable weekStart=%p (would 500 pre-fix)',
    bad => {
      const { weekStart, weekEnd } = venueWeekBounds(bad, TZ)
      expect(Number.isNaN(weekStart.getTime())).toBe(false)
      expect(Number.isNaN(weekEnd.getTime())).toBe(false)
      expect(weekEnd.getTime() - weekStart.getTime()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000)
      expect(weekEnd.getTime() - weekStart.getTime()).toBeLessThan(7 * 24 * 60 * 60 * 1000)
      expect(isMonday(weekStart)).toBe(true)
    },
  )

  // Out-of-range-but-finite values: pre-fix `Date.UTC` normalizes them and the week
  // silently DRIFTS (e.g. month 13 → next Jan; year 99999 → Invalid via fromZonedTime).
  // The range guard makes them fall back to the CURRENT week — asserting equality with
  // the no-arg (current-week) result discriminates the fix (drifted week ≠ current).
  it.each(['2026-13-08', '1999-07-08', '2026-07-40', '99999-01-01'])(
    'out-of-range weekStart=%p falls back to the current venue week (no silent drift)',
    bad => {
      expect(dateKey(venueWeekBounds(bad, TZ).weekStart)).toBe(dateKey(venueWeekBounds(undefined, TZ).weekStart))
    },
  )

  // The default (no arg) is the most common path (current week) — cover it explicitly.
  it('with no weekStart returns the current venue week, Monday-anchored, containing today', () => {
    const { weekStart, weekEnd } = venueWeekBounds(undefined, TZ)
    expect(Number.isNaN(weekStart.getTime())).toBe(false)
    expect(isMonday(weekStart)).toBe(true)
    const now = Date.now()
    expect(now).toBeGreaterThanOrEqual(weekStart.getTime())
    expect(now).toBeLessThanOrEqual(weekEnd.getTime())
  })
})
