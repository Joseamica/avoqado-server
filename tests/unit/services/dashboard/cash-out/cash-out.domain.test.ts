import {
  venueBusinessDate,
  weekStartMonday,
  selectRateTier,
  buildCommissionEntry,
  isSchemeActiveOn,
  validateRateTable,
  weekRangeUtc,
} from '@/services/dashboard/cash-out/cash-out.domain'

const MX = 'America/Mexico_City'

// 1. NEW FEATURE TESTS — the core "are we computing the right thing" logic

describe('cash-out domain — venueBusinessDate (venue-local calendar date, host-tz-independent)', () => {
  it('uses the venue-local day, NOT the UTC day (prod runs UTC — documented money bug)', () => {
    // 2026-06-26T02:00:00Z === 2026-06-25 20:00 in Mexico City (UTC-6).
    // A naive UTC read would wrongly say 2026-06-26.
    expect(venueBusinessDate(new Date('2026-06-26T02:00:00.000Z'), MX)).toBe('2026-06-25')
  })

  it('returns the venue day for a clearly mid-day Mexico timestamp', () => {
    // 2026-06-26T18:00:00Z === 2026-06-26 12:00 Mexico
    expect(venueBusinessDate(new Date('2026-06-26T18:00:00.000Z'), MX)).toBe('2026-06-26')
  })
})

describe('cash-out domain — weekStartMonday (Lun–Dom escalation week)', () => {
  it('Friday → that week Monday', () => {
    expect(weekStartMonday('2026-06-26')).toBe('2026-06-22')
  })

  it('Monday → itself', () => {
    expect(weekStartMonday('2026-06-22')).toBe('2026-06-22')
  })

  it('Sunday belongs to the week that started Monday (Lun–Dom, not Sun–Sat)', () => {
    expect(weekStartMonday('2026-06-28')).toBe('2026-06-22')
  })

  it('crosses the month boundary correctly', () => {
    expect(weekStartMonday('2026-07-01')).toBe('2026-06-29')
  })
})

describe('cash-out domain — selectRateTier (escalated commission by accumulated weekly count)', () => {
  const rates = [
    { saleType: 'LINEA_NUEVA' as const, minCount: 1, maxCount: 5, amount: 30 },
    { saleType: 'LINEA_NUEVA' as const, minCount: 6, maxCount: 10, amount: 40 },
    { saleType: 'LINEA_NUEVA' as const, minCount: 11, maxCount: null, amount: 50 },
    { saleType: 'PORTABILIDAD' as const, minCount: 1, maxCount: 5, amount: 25 },
    { saleType: 'PORTABILIDAD' as const, minCount: 6, maxCount: null, amount: 35 },
  ]

  it('1st sale of the week → first tier', () => {
    expect(selectRateTier(rates, 'LINEA_NUEVA', 1)?.amount).toBe(30)
  })

  it('escalates exactly at the tier boundary (5 → 6)', () => {
    expect(selectRateTier(rates, 'LINEA_NUEVA', 5)?.amount).toBe(30)
    expect(selectRateTier(rates, 'LINEA_NUEVA', 6)?.amount).toBe(40)
  })

  it('open-ended top tier covers counts beyond the table', () => {
    expect(selectRateTier(rates, 'LINEA_NUEVA', 11)?.amount).toBe(50)
    expect(selectRateTier(rates, 'LINEA_NUEVA', 99)?.amount).toBe(50)
  })

  it('filters by sale type (Portabilidad ≠ Línea Nueva)', () => {
    expect(selectRateTier(rates, 'PORTABILIDAD', 3)?.amount).toBe(25)
    expect(selectRateTier(rates, 'PORTABILIDAD', 7)?.amount).toBe(35)
  })

  it('returns undefined when no tier matches (misconfiguration — caller must handle, never silently pay)', () => {
    const capped = [{ saleType: 'LINEA_NUEVA' as const, minCount: 1, maxCount: 5, amount: 30 }]
    expect(selectRateTier(capped, 'LINEA_NUEVA', 6)).toBeUndefined()
  })
})

describe('cash-out domain — buildCommissionEntry (approved sale → locked ledger entry)', () => {
  const rates = [
    { saleType: 'LINEA_NUEVA' as const, minCount: 1, maxCount: 5, amount: 30 },
    { saleType: 'LINEA_NUEVA' as const, minCount: 6, maxCount: null, amount: 40 },
    { saleType: 'PORTABILIDAD' as const, minCount: 1, maxCount: null, amount: 25 },
  ]
  const base = { saleVerificationId: 'sv_1', venueId: 'v_1', staffId: 'promoter_1', timeZone: MX, rates }

  it('maps isPortabilidad and locks tier/amount for the 1st sale of the week', () => {
    const e = buildCommissionEntry({ ...base, isPortabilidad: true, saleAt: new Date('2026-06-26T18:00:00.000Z'), priorWeekCount: 0 })
    expect(e.saleType).toBe('PORTABILIDAD')
    expect(e.businessDate).toBe('2026-06-26')
    expect(e.weekStart).toBe('2026-06-22')
    expect(e.tier).toBe(1)
    expect(e.amount).toBe(25)
    expect(e.saleVerificationId).toBe('sv_1')
  })

  it('escalates end-to-end: a Línea Nueva sale after 5 prior weekly sales → tier 6, higher amount', () => {
    const e = buildCommissionEntry({ ...base, isPortabilidad: false, saleAt: new Date('2026-06-26T18:00:00.000Z'), priorWeekCount: 5 })
    expect(e.saleType).toBe('LINEA_NUEVA')
    expect(e.tier).toBe(6)
    expect(e.amount).toBe(40)
  })

  it('uses the venue-local day for businessDate/weekStart (UTC-trap: Sunday 21:00 Mexico)', () => {
    // 2026-06-29T03:00:00Z === 2026-06-28 21:00 Mexico (Sunday) → week started Mon 2026-06-22
    const e = buildCommissionEntry({ ...base, isPortabilidad: false, saleAt: new Date('2026-06-29T03:00:00.000Z'), priorWeekCount: 0 })
    expect(e.businessDate).toBe('2026-06-28')
    expect(e.weekStart).toBe('2026-06-22')
  })

  it('throws (never silently $0) when no tier matches the sale count', () => {
    const capped = [{ saleType: 'LINEA_NUEVA' as const, minCount: 1, maxCount: 5, amount: 30 }]
    expect(() =>
      buildCommissionEntry({
        ...base,
        rates: capped,
        isPortabilidad: false,
        saleAt: new Date('2026-06-26T18:00:00.000Z'),
        priorWeekCount: 5,
      }),
    ).toThrow()
  })
})

describe('cash-out domain — isSchemeActiveOn (ADMIN day-selection)', () => {
  const activeDays = ['2026-06-22', '2026-06-23'] // Mon, Tue only

  it('true on an active day', () => {
    expect(isSchemeActiveOn(activeDays, '2026-06-22')).toBe(true)
  })

  it('false on a non-active day', () => {
    expect(isSchemeActiveOn(activeDays, '2026-06-24')).toBe(false)
  })
})

describe('cash-out domain — validateRateTable (catch misconfig at save time, not at payout)', () => {
  const valid = [
    { saleType: 'LINEA_NUEVA' as const, minCount: 1, maxCount: 5, amount: 30 },
    { saleType: 'LINEA_NUEVA' as const, minCount: 6, maxCount: 10, amount: 40 },
    { saleType: 'LINEA_NUEVA' as const, minCount: 11, maxCount: null, amount: 50 },
    { saleType: 'PORTABILIDAD' as const, minCount: 1, maxCount: null, amount: 25 },
  ]

  it('accepts a contiguous ladder that starts at 1 and ends open-ended (per sale type)', () => {
    expect(validateRateTable(valid)).toEqual([])
  })

  it('rejects a gap between tiers', () => {
    const gap = [
      { saleType: 'LINEA_NUEVA' as const, minCount: 1, maxCount: 5, amount: 30 },
      { saleType: 'LINEA_NUEVA' as const, minCount: 7, maxCount: null, amount: 50 }, // gap at 6
    ]
    expect(validateRateTable(gap).length).toBeGreaterThan(0)
    expect(validateRateTable(gap).join(' ')).toMatch(/LINEA_NUEVA/)
  })

  it('rejects overlapping tiers', () => {
    const overlap = [
      { saleType: 'LINEA_NUEVA' as const, minCount: 1, maxCount: 5, amount: 30 },
      { saleType: 'LINEA_NUEVA' as const, minCount: 4, maxCount: null, amount: 50 },
    ]
    expect(validateRateTable(overlap).length).toBeGreaterThan(0)
  })

  it('rejects a ladder with no open-ended top tier (counts beyond the table would be uncovered)', () => {
    const capped = [{ saleType: 'LINEA_NUEVA' as const, minCount: 1, maxCount: 5, amount: 30 }]
    expect(validateRateTable(capped).length).toBeGreaterThan(0)
  })

  it('rejects a ladder that does not start at 1', () => {
    const noStart = [{ saleType: 'LINEA_NUEVA' as const, minCount: 2, maxCount: null, amount: 30 }]
    expect(validateRateTable(noStart).length).toBeGreaterThan(0)
  })

  it('rejects maxCount < minCount and negative amounts', () => {
    expect(validateRateTable([{ saleType: 'PORTABILIDAD' as const, minCount: 5, maxCount: 3, amount: 25 }]).length).toBeGreaterThan(0)
    expect(validateRateTable([{ saleType: 'PORTABILIDAD' as const, minCount: 1, maxCount: null, amount: -5 }]).length).toBeGreaterThan(0)
  })
})

describe('cash-out domain — weekRangeUtc (venue-local Lun–Dom week → UTC bounds to query createdAt)', () => {
  it('converts Monday..nextMonday venue-local boundaries to UTC (Mexico = UTC-6, no DST)', () => {
    const { gte, lt } = weekRangeUtc('2026-06-22', MX)
    // Mon 2026-06-22 00:00 Mexico = 06:00Z ; next Mon 2026-06-29 00:00 Mexico = 06:00Z
    expect(gte.toISOString()).toBe('2026-06-22T06:00:00.000Z')
    expect(lt.toISOString()).toBe('2026-06-29T06:00:00.000Z')
  })

  it('the range is half-open [gte, lt) spanning exactly 7 days', () => {
    const { gte, lt } = weekRangeUtc('2026-06-22', MX)
    expect((lt.getTime() - gte.getTime()) / (1000 * 60 * 60 * 24)).toBe(7)
  })
})
