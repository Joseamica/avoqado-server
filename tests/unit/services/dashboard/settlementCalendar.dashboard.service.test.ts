import { getSettlementsLandingInWeek, projectPaymentSettlement } from '@/services/dashboard/settlementCalendar.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

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
      { amount: 1000, tipAmount: 0, createdAt: new Date('2026-07-04T02:00:00Z'), merchantAccountId: 'm1', transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 30, venueFixedFee: 5 }, merchantAccount: merchant },
      // Sold Mon 2026-07-06 12:00 MX → 1 biz day → lands Tue 07-07 (in week)
      { amount: 500, tipAmount: 50, createdAt: new Date('2026-07-06T18:00:00Z'), merchantAccountId: 'm1', transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 16.5, venueFixedFee: 5 }, merchantAccount: merchant },
      // No active config (merchant m2) → cannot be placed on any landing day → excluded
      { amount: 700, tipAmount: 0, createdAt: new Date('2026-07-05T18:00:00Z'), merchantAccountId: 'm2', transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 25, venueFixedFee: 0 }, merchantAccount: { displayName: 'Sin regla', alias: null, provider: { name: 'Blumon' } } },
      // Sold Sat 2026-07-11 20:00 MX → 1 biz day → lands Mon 07-13 (NEXT week) → excluded
      { amount: 200, tipAmount: 0, createdAt: new Date('2026-07-12T02:00:00Z'), merchantAccountId: 'm1', transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 6, venueFixedFee: 0 }, merchantAccount: merchant },
    ])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([
      { merchantAccountId: 'm1', cardType: 'CREDIT', settlementDays: 1, settlementDayType: 'BUSINESS_DAYS', cutoffTime: '23:00', cutoffTimezone: TZ, effectiveFrom: new Date('2026-01-01'), effectiveTo: null },
    ])

    const r = await getSettlementsLandingInWeek('v1', weekStart, weekEnd, TZ)

    expect(r.weekStart).toBe('2026-07-06')
    expect(r.weekEnd).toBe('2026-07-12')
    expect(r.days.map(d => d.date)).toEqual(['2026-07-06', '2026-07-07']) // sorted; P3 no-rule + P4 next-week gone
    const [mon, tue] = r.days
    expect(mon).toMatchObject({ date: '2026-07-06', gross: 1000, commission: 35, net: 965, count: 1 })
    expect(mon.byMerchant).toEqual([{ merchantAccountId: 'm1', displayName: 'Amaena - B', provider: 'AngelPay (Nexgo)', gross: 1000, commission: 35, net: 965, count: 1 }])
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
