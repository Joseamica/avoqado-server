import { getCrossVenueSettlementCalendar } from '@/services/superadmin/settlementCalendar.superadmin.service'
import { resolveWindow } from '@/controllers/superadmin/settlementCalendar.controller'
import { prismaMock } from '@tests/__helpers__/setup'

const TZ = 'America/Mexico_City'

const cfg = (merchantAccountId: string, settlementDays = 1) => ({
  merchantAccountId,
  cardType: 'CREDIT' as const,
  settlementDays,
  settlementDayType: 'BUSINESS_DAYS' as const,
  cutoffTime: '23:00',
  cutoffTimezone: TZ,
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
})

const venue = (id: string, name: string, timezone: string | null = TZ) => ({ id, name, timezone })
const cost = (charge: number, fixed = 0) => ({ transactionType: 'CREDIT' as const, venueChargeAmount: charge, venueFixedFee: fixed })
const withAgg = (name: string) => ({ aggregatorId: 'agg1', aggregator: { name } })
const noAgg = { aggregatorId: null, aggregator: null }

/** Sold Fri 2026-07-03 20:00 MX (= 07-04T02:00Z) → 1 business day → lands Mon 2026-07-06. */
const SOLD_FRI = new Date('2026-07-04T02:00:00Z')
/** Sold Mon 2026-07-06 10:00 MX → 1 business day → lands Tue 2026-07-07. */
const SOLD_MON = new Date('2026-07-06T16:00:00Z')

function mockPayments(rows: any[]) {
  ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue(rows)
}
function mockConfigs(rows: any[]) {
  ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue(rows)
}

describe('getCrossVenueSettlementCalendar', () => {
  beforeEach(() => jest.clearAllMocks())

  it('groups by landing day and then by venue, netting commission out', async () => {
    mockPayments([
      {
        amount: 1000,
        tipAmount: 50,
        createdAt: SOLD_FRI,
        venueId: 'v1',
        merchantAccountId: 'm1',
        transactionCost: cost(30, 5),
        venue: venue('v1', 'Mindform'),
        merchantAccount: noAgg,
      },
      {
        amount: 500,
        tipAmount: 0,
        createdAt: SOLD_FRI,
        venueId: 'v2',
        merchantAccountId: 'm1',
        transactionCost: cost(20),
        venue: venue('v2', 'Doña Simona'),
        merchantAccount: withAgg('Externo'),
      },
    ])
    mockConfigs([cfg('m1')])

    const r = await getCrossVenueSettlementCalendar('2026-07-01', '2026-07-31')

    expect(r.days).toHaveLength(1)
    const day = r.days[0]
    expect(day.date).toBe('2026-07-06')
    // 1050 − 35 = 1015 ; 500 − 20 = 480
    expect(day.net).toBe(1495)
    expect(day.gross).toBe(1550)
    expect(day.count).toBe(2)
    // Sorted by net desc
    expect(day.venues.map(v => [v.venueName, v.net])).toEqual([
      ['Mindform', 1015],
      ['Doña Simona', 480],
    ])
    expect(r.total.net).toBe(1495)
    expect(r.venueCount).toBe(2)
  })

  it('badges the venue-day when ANY of its money went through an aggregator', async () => {
    mockPayments([
      {
        amount: 100,
        tipAmount: 0,
        createdAt: SOLD_FRI,
        venueId: 'v1',
        merchantAccountId: 'm1',
        transactionCost: cost(0),
        venue: venue('v1', 'Amaena'),
        merchantAccount: withAgg('Externo'),
      },
      // Same venue, DIFFERENT merchant with no aggregator — a real prod shape
      // (Amaena has both "Amaena - B" and "Amaena - A"). The venue-day must still
      // be badged, and must not double-count or split into two venue rows.
      {
        amount: 200,
        tipAmount: 0,
        createdAt: SOLD_FRI,
        venueId: 'v1',
        merchantAccountId: 'm2',
        transactionCost: cost(0),
        venue: venue('v1', 'Amaena'),
        merchantAccount: noAgg,
      },
    ])
    mockConfigs([cfg('m1'), cfg('m2')])

    const r = await getCrossVenueSettlementCalendar('2026-07-01', '2026-07-31')

    expect(r.days[0].venues).toHaveLength(1)
    expect(r.days[0].venues[0]).toMatchObject({
      venueName: 'Amaena',
      net: 300,
      count: 2,
      hasAggregator: true,
      aggregatorNames: ['Externo'],
    })
  })

  it('reports unprojectable card money separately instead of dropping it', async () => {
    mockPayments([
      // No transactionCost → cannot be costed or dated
      {
        amount: 700,
        tipAmount: 10,
        createdAt: SOLD_FRI,
        venueId: 'v1',
        merchantAccountId: 'm1',
        transactionCost: null,
        venue: venue('v1', 'IQ'),
        merchantAccount: noAgg,
      },
      // Has cost but NO settlement rule for its merchant
      {
        amount: 300,
        tipAmount: 0,
        createdAt: SOLD_FRI,
        venueId: 'v1',
        merchantAccountId: 'unknown-merchant',
        transactionCost: cost(5),
        venue: venue('v1', 'IQ'),
        merchantAccount: noAgg,
      },
    ])
    mockConfigs([cfg('m1')])

    const r = await getCrossVenueSettlementCalendar('2026-07-01', '2026-07-31')

    expect(r.days).toHaveLength(0)
    expect(r.total.net).toBe(0)
    expect(r.unprojected).toEqual({ count: 2, gross: 1010 })
  })

  it('excludes money landing outside the requested window', async () => {
    mockPayments([
      { ...base('v1', 'Mindform', SOLD_FRI), amount: 100 }, // lands 07-06
      { ...base('v1', 'Mindform', SOLD_MON), amount: 200 }, // lands 07-07
    ])
    mockConfigs([cfg('m1')])

    // Window is only 07-06 → 07-06, so the 07-07 landing must be excluded.
    const r = await getCrossVenueSettlementCalendar('2026-07-06', '2026-07-06')

    expect(r.days).toHaveLength(1)
    expect(r.days[0].date).toBe('2026-07-06')
    expect(r.days[0].net).toBe(100)
    expect(r.total.count).toBe(1)
  })

  it('over-fetches by a 21-day lookback so cross-window sales still land in-window', async () => {
    mockPayments([])
    mockConfigs([])

    await getCrossVenueSettlementCalendar('2026-07-01', '2026-07-31')

    const where = (prismaMock.payment.findMany as jest.Mock).mock.calls[0][0].where
    // 2026-07-01 minus 21 days = 2026-06-10
    expect(where.createdAt.gte.toISOString()).toBe('2026-06-10T00:00:00.000Z')
    // CASH never settles — it must never enter the calendar.
    expect(where.method).toEqual({ not: 'CASH' })
    expect(where.merchantAccountId).toEqual({ not: null })
    expect(where.status).toBe('COMPLETED')
  })

  it('falls back to the default timezone when a venue has none', async () => {
    mockPayments([{ ...base('v1', 'Sin TZ', SOLD_FRI, null), amount: 100 }])
    mockConfigs([cfg('m1')])

    const r = await getCrossVenueSettlementCalendar('2026-07-01', '2026-07-31')

    // Still lands on the Mexico-local business day, not a UTC-shifted one.
    expect(r.days[0].date).toBe('2026-07-06')
  })

  it('marks past days settled and future days projected', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-07T18:00:00Z')) // 12:00 MX on 07-07
    try {
      mockPayments([
        { ...base('v1', 'A', SOLD_FRI), amount: 100 }, // lands 07-06 → past
        { ...base('v1', 'A', SOLD_MON), amount: 200 }, // lands 07-07 → today
      ])
      mockConfigs([cfg('m1')])

      const r = await getCrossVenueSettlementCalendar('2026-07-01', '2026-07-31')

      expect(r.days.map(d => [d.date, d.status])).toEqual([
        ['2026-07-06', 'settled'],
        ['2026-07-07', 'today'],
      ])
    } finally {
      jest.useRealTimers()
    }
  })

  // Regression: the whole point of this screen is to agree with the per-venue page,
  // which recomputes LIVE. If someone "optimizes" this to read the stored
  // transaction.estimatedSettlementDate, the two screens silently diverge.
  it('does not read the stored estimatedSettlementDate', async () => {
    mockPayments([])
    mockConfigs([])
    await getCrossVenueSettlementCalendar('2026-07-01', '2026-07-31')
    const select = (prismaMock.payment.findMany as jest.Mock).mock.calls[0][0].select
    expect(select.transaction).toBeUndefined()
  })
})

function base(venueId: string, venueName: string, createdAt: Date, timezone: string | null = TZ) {
  return {
    amount: 100,
    tipAmount: 0,
    createdAt,
    venueId,
    merchantAccountId: 'm1',
    transactionCost: cost(0),
    venue: venue(venueId, venueName, timezone),
    merchantAccount: noAgg,
  }
}

describe('resolveWindow', () => {
  it('expands ?month=YYYY-MM to the full calendar month', () => {
    expect(resolveWindow({ month: '2026-07' })).toEqual({ fromKey: '2026-07-01', toKey: '2026-07-31' })
  })

  it('handles short months and leap years', () => {
    expect(resolveWindow({ month: '2026-02' })).toEqual({ fromKey: '2026-02-01', toKey: '2026-02-28' })
    expect(resolveWindow({ month: '2024-02' })).toEqual({ fromKey: '2024-02-01', toKey: '2024-02-29' })
    expect(resolveWindow({ month: '2026-06' })).toEqual({ fromKey: '2026-06-01', toKey: '2026-06-30' })
  })

  it('accepts an explicit from/to pair', () => {
    expect(resolveWindow({ from: '2026-07-06', to: '2026-07-12' })).toEqual({ fromKey: '2026-07-06', toKey: '2026-07-12' })
  })

  it('ignores malformed input instead of producing an Invalid Date', () => {
    // A bad month/from must fall back to the current month, never crash the query.
    for (const q of [{ month: 'garbage' }, { month: '2026-13' }, { from: 'nope', to: 'nope' }, {}]) {
      const r = resolveWindow(q as any)
      expect(r.fromKey).toMatch(/^\d{4}-\d{2}-01$/)
      expect(r.toKey).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
