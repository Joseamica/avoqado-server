/**
 * Org Sale Verification Aggregations Tests (Asana 1215613218390496)
 *
 * Covers the PlayTelecom org "Ventas" executive dashboard fixes:
 *   - getOrgSalesSummary: `confirmedRevenue` only sums payments whose
 *     SaleVerification is COMPLETED ("solo ventas confirmadas en totales").
 *     Regression: the "Monto confirmado" KPI used totalRevenue, which
 *     includes PENDING ("en revisión") and unverified sales.
 *   - getSalesBySupervisor: a venue's MANAGER (the real "Supervisor
 *     responsable") takes precedence over ADMIN in attribution.
 *     Regression: org ADMINs (e.g. executives) with a lower staffId were
 *     reported as supervisors of every store.
 *   - getSalesBySupervisor / getSalesByStore: expose `byMonth` buckets
 *     (client tables are month-by-month) while keeping `byWeek`.
 *   - getSalesByPromoter: new monthly grouping by the staff who sold.
 */

import {
  getOrgSalesSummary,
  getSalesBySupervisor,
  getSalesByStore,
  getSalesByPromoter,
  getSalesByPromoterDaily,
  getSalesByWeek,
  getSalesBySaleTypeWeekly,
  getSalesBySimTypeWeekly,
  getSalesBySimType,
  toSimBucket,
} from '@/services/dashboard/sale-verification.org.dashboard.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn() },
    saleVerification: { findMany: jest.fn() },
    staffVenue: { findMany: jest.fn() },
  },
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn() },
}))

jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn() },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

const mockedPaymentFindMany = prisma.payment.findMany as jest.Mock
const mockedSvFindMany = prisma.saleVerification.findMany as jest.Mock
const mockedStaffVenueFindMany = prisma.staffVenue.findMany as jest.Mock

const ORG_ID = 'org-playtelecom'

// Mid-month, midday CDMX timestamps so month/week bucketing is TZ-safe.
const MARCH = new Date('2026-03-15T18:00:00Z')
const APRIL = new Date('2026-04-15T18:00:00Z')

beforeEach(() => {
  jest.clearAllMocks()
})

describe('getOrgSalesSummary — confirmedRevenue', () => {
  it('only sums payments whose verification is COMPLETED, and counts each status', async () => {
    mockedPaymentFindMany.mockResolvedValue([
      { amount: 100, saleVerification: { status: 'COMPLETED' } },
      { amount: 50, saleVerification: { status: 'PENDING' } }, // pendiente — NO entra
      { amount: 25, saleVerification: { status: 'FAILED' } }, // "Revisar" (corregible) — NO entra
      { amount: 30, saleVerification: { status: 'REJECTED' } }, // "Rechazada" (terminal) — NO entra
      { amount: 10, saleVerification: null }, // sin verificación — NO entra
    ])

    const summary = await getOrgSalesSummary(ORG_ID, {})

    expect(summary.confirmedRevenue).toBe(100)
    // totalRevenue keeps legacy semantics (every completed payment) for backwards compat
    expect(summary.totalRevenue).toBe(215)
    expect(summary.completedCount).toBe(1)
    expect(summary.pendingCount).toBe(1)
    expect(summary.failedCount).toBe(1)
    expect(summary.rejectedCount).toBe(1)
    expect(summary.withoutVerificationCount).toBe(1)
  })

  it('returns zero confirmedRevenue when nothing is confirmed', async () => {
    mockedPaymentFindMany.mockResolvedValue([
      { amount: 50, saleVerification: { status: 'PENDING' } },
      { amount: 10, saleVerification: null },
    ])

    const summary = await getOrgSalesSummary(ORG_ID, {})

    expect(summary.confirmedRevenue).toBe(0)
    expect(summary.totalRevenue).toBe(60)
  })
})

describe('getSalesBySupervisor — MANAGER-first attribution', () => {
  it('attributes sales to the venue MANAGER even when an ADMIN has a lower staffId', async () => {
    mockedSvFindMany.mockResolvedValue([
      { createdAt: MARCH, venueId: 'venue-1' },
      { createdAt: APRIL, venueId: 'venue-1' },
    ])
    // ADMIN sorts first by staffId — the old logic picked it as "supervisor".
    mockedStaffVenueFindMany.mockResolvedValue([
      { venueId: 'venue-1', staffId: 'a-admin', role: 'ADMIN', staff: { id: 'a-admin', firstName: 'Jordi', lastName: 'Mota' } },
      { venueId: 'venue-1', staffId: 'z-manager', role: 'MANAGER', staff: { id: 'z-manager', firstName: 'Hugo', lastName: 'Gonzalez' } },
    ])

    const rows = await getSalesBySupervisor(ORG_ID, {})

    expect(rows).toHaveLength(1)
    expect(rows[0].supervisorId).toBe('z-manager')
    expect(rows[0].supervisorName).toBe('Hugo Gonzalez')
    expect(rows[0].total).toBe(2)
    // Month buckets exposed for the month-by-month client tables
    expect(rows[0].byMonth).toEqual({ '2026-03': 1, '2026-04': 1 })
    expect(Object.keys(rows[0].byWeek)).toHaveLength(2)
  })

  it('falls back to ADMIN when the venue has no MANAGER', async () => {
    mockedSvFindMany.mockResolvedValue([{ createdAt: MARCH, venueId: 'venue-1' }])
    mockedStaffVenueFindMany.mockResolvedValue([
      { venueId: 'venue-1', staffId: 'a-admin', role: 'ADMIN', staff: { id: 'a-admin', firstName: 'Edgar', lastName: 'Salazar' } },
    ])

    const rows = await getSalesBySupervisor(ORG_ID, {})

    expect(rows[0].supervisorId).toBe('a-admin')
    expect(rows[0].supervisorName).toBe('Edgar Salazar')
  })

  it('reports "Sin supervisor" when the venue has neither', async () => {
    mockedSvFindMany.mockResolvedValue([{ createdAt: MARCH, venueId: 'venue-1' }])
    mockedStaffVenueFindMany.mockResolvedValue([])

    const rows = await getSalesBySupervisor(ORG_ID, {})

    expect(rows[0].supervisorId).toBeNull()
    expect(rows[0].supervisorName).toBe('Sin supervisor')
  })
})

describe('getSalesByStore — byMonth buckets', () => {
  it('exposes month buckets alongside weeks', async () => {
    mockedSvFindMany.mockResolvedValue([
      { createdAt: MARCH, venue: { id: 'venue-1', name: 'BAE POZOS' } },
      { createdAt: MARCH, venue: { id: 'venue-1', name: 'BAE POZOS' } },
      { createdAt: APRIL, venue: { id: 'venue-2', name: 'GEOPLAZAS' } },
    ])

    const rows = await getSalesByStore(ORG_ID, {})

    expect(rows).toHaveLength(2)
    // Sorted desc by total
    expect(rows[0].venueName).toBe('BAE POZOS')
    expect(rows[0].byMonth).toEqual({ '2026-03': 2 })
    expect(rows[1].byMonth).toEqual({ '2026-04': 1 })
  })
})

describe('getSalesByPromoter — monthly grouping', () => {
  it('groups by verification staff, sorted desc, with "Sin promotor" fallback', async () => {
    mockedSvFindMany.mockResolvedValue([
      { createdAt: MARCH, staff: { id: 's1', firstName: 'Susana', lastName: 'Valdez' } },
      { createdAt: APRIL, staff: { id: 's1', firstName: 'Susana', lastName: 'Valdez' } },
      { createdAt: APRIL, staff: { id: 's2', firstName: 'Ricardo', lastName: 'Martinez' } },
      { createdAt: APRIL, staff: null },
    ])

    const rows = await getSalesByPromoter(ORG_ID, {})

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      staffId: 's1',
      promoterName: 'Susana Valdez',
      total: 2,
      byMonth: { '2026-03': 1, '2026-04': 1 },
    })
    expect(rows[1]).toMatchObject({ staffId: 's2', total: 1 })
    expect(rows[2]).toMatchObject({ staffId: null, promoterName: 'Sin promotor', total: 1 })
  })

  it('only queries CONFIRMED verifications (status=COMPLETED in the where clause)', async () => {
    mockedSvFindMany.mockResolvedValue([])

    await getSalesByPromoter(ORG_ID, {})

    expect(mockedSvFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'COMPLETED', venue: { organizationId: ORG_ID } }),
      }),
    )
  })
})

describe('getSalesByPromoterDaily — current month, per-day + toReview', () => {
  // "Now" in venue tz (CDMX), exactly how the service derives the current month.
  function cdmxNow(): Date {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }))
  }
  // 18:00 UTC on the 1st = 12:00 CDMX on the 1st → day key `${month}-01`, TZ-stable,
  // and aligned to the SAME CDMX month the service computes (no month-boundary flake).
  function firstOfThisMonthMidday(): Date {
    const c = cdmxNow()
    return new Date(Date.UTC(c.getFullYear(), c.getMonth(), 1, 18, 0, 0))
  }

  // A FAILED clearly in a PREVIOUS month (1 year before, 1st at noon CDMX).
  function failedLastYear(): Date {
    const c = cdmxNow()
    return new Date(Date.UTC(c.getFullYear() - 1, c.getMonth(), 1, 18, 0, 0))
  }

  it('counts COMPLETED per day in total, splits FAILED into this-month (toReview) vs prior (toReviewPrevious), excludes both from total, sorted desc', async () => {
    const d1 = firstOfThisMonthMidday()
    const prev = failedLastYear()
    mockedSvFindMany.mockResolvedValue([
      // staff A: 2 confirmed (this month) + 1 to-review (this month) + 1 to-review (prior month)
      { createdAt: d1, status: 'COMPLETED', staff: { id: 'A', firstName: 'Nancy', lastName: 'Casillas' } },
      { createdAt: d1, status: 'COMPLETED', staff: { id: 'A', firstName: 'Nancy', lastName: 'Casillas' } },
      { createdAt: d1, status: 'FAILED', staff: { id: 'A', firstName: 'Nancy', lastName: 'Casillas' } },
      { createdAt: prev, status: 'FAILED', staff: { id: 'A', firstName: 'Nancy', lastName: 'Casillas' } },
      // staff B: 1 confirmed
      { createdAt: d1, status: 'COMPLETED', staff: { id: 'B', firstName: 'Patricia', lastName: 'Navarro' } },
      // staff C: ONLY a prior-month to-review → must still appear (promoter must act), total 0
      { createdAt: prev, status: 'FAILED', staff: { id: 'C', firstName: 'Lucía', lastName: 'Briones' } },
    ])

    const result = await getSalesByPromoterDaily(ORG_ID)

    expect(result.rows[0]).toMatchObject({ staffId: 'A', total: 2, toReview: 1, toReviewPrevious: 1 })
    expect(result.rows[1]).toMatchObject({ staffId: 'B', total: 1, toReview: 0, toReviewPrevious: 0 })
    const cRow = result.rows.find(r => r.staffId === 'C')!
    expect(cRow).toMatchObject({ total: 0, toReview: 0, toReviewPrevious: 1 })
    // Confirmed-only day buckets; the 1st carries staff A's two confirmed sales
    const dayKey = `${result.month}-01`
    expect(result.rows[0].byDay[dayKey]).toBe(2)
    // byDay never includes FAILED → sum of byDay equals total (neither to-review count leaks in)
    expect(Object.values(result.rows[0].byDay).reduce((a, b) => a + b, 0)).toBe(result.rows[0].total)
  })

  it('queries COMPLETED (this month) OR FAILED (any date), so prior-month to-review is available', async () => {
    mockedSvFindMany.mockResolvedValue([])

    const result = await getSalesByPromoterDaily(ORG_ID)

    const call = mockedSvFindMany.mock.calls[0][0]
    expect(call.where.venue).toEqual({ organizationId: ORG_ID })
    // OR: COMPLETED scoped to current month, FAILED unscoped (all dates)
    expect(call.where.OR).toEqual([{ status: 'COMPLETED', createdAt: { gte: expect.any(Date) } }, { status: 'FAILED' }])
    // month is the current CDMX YYYY-MM; days run 1..today
    const c = cdmxNow()
    expect(result.month).toBe(`${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}`)
    expect(result.days.length).toBe(c.getDate())
    expect(result.days[0]).toBe(`${result.month}-01`)
  })
})

describe('toSimBucket', () => {
  it('maps the three fixed categories exactly', () => {
    expect(toSimBucket('SIM de Intercambio')).toBe('SIM de Intercambio')
    expect(toSimBucket('$100 de Promotor')).toBe('$100 de Promotor')
    expect(toSimBucket('SIM de Evento')).toBe('SIM de Evento')
  })
  it('is trim/case-insensitive', () => {
    expect(toSimBucket('  sim de intercambio ')).toBe('SIM de Intercambio')
  })
  it('routes E-SIM de promotor, null and unknowns to "Otros SIMs"', () => {
    expect(toSimBucket('E-SIM de promotor')).toBe('Otros SIMs')
    expect(toSimBucket(null)).toBe('Otros SIMs')
    expect(toSimBucket('Cualquier otra')).toBe('Otros SIMs')
  })
})

describe('getSalesBySaleTypeWeekly', () => {
  it('splits COMPLETED sales by isPortabilidad into fixed weekly rows', async () => {
    const w1 = new Date('2026-03-09T18:00:00Z') // 2026-W11
    const w2 = new Date('2026-03-16T18:00:00Z') // 2026-W12
    mockedSvFindMany.mockResolvedValue([
      { createdAt: w1, isPortabilidad: false },
      { createdAt: w1, isPortabilidad: true },
      { createdAt: w2, isPortabilidad: false },
    ])
    const rows = await getSalesBySaleTypeWeekly(ORG_ID, {})
    expect(rows.map(r => r.name)).toEqual(['Líneas Nuevas', 'Portabilidades'])
    expect(rows[0]).toMatchObject({ total: 2, byWeek: { '2026-W11': 1, '2026-W12': 1 } })
    expect(rows[1]).toMatchObject({ total: 1, byWeek: { '2026-W11': 1 } })
  })
  it('returns both rows even when one type has zero sales', async () => {
    mockedSvFindMany.mockResolvedValue([{ createdAt: new Date('2026-03-09T18:00:00Z'), isPortabilidad: false }])
    const rows = await getSalesBySaleTypeWeekly(ORG_ID, {})
    expect(rows.map(r => r.name)).toEqual(['Líneas Nuevas', 'Portabilidades'])
    expect(rows[1]).toMatchObject({ total: 0, byWeek: {} })
  })
  it('only queries CONFIRMED verifications', async () => {
    mockedSvFindMany.mockResolvedValue([])
    await getSalesBySaleTypeWeekly(ORG_ID, {})
    expect(mockedSvFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'COMPLETED', venue: { organizationId: ORG_ID } }) }),
    )
  })
})

describe('toIsoWeekKey (via getSalesBySaleTypeWeekly week keys)', () => {
  it('produces ISO year-week keys and orders correctly across a year boundary', async () => {
    // 2025-12-29 (Mon) is ISO 2026-W01; 2026-01-05 (Mon) is 2026-W02
    const dec29 = new Date('2025-12-29T18:00:00Z')
    const jan05 = new Date('2026-01-05T18:00:00Z')
    mockedSvFindMany.mockResolvedValue([
      { createdAt: dec29, isPortabilidad: false },
      { createdAt: jan05, isPortabilidad: false },
    ])
    const rows = await getSalesBySaleTypeWeekly(ORG_ID, {})
    const lineas = rows.find(r => r.name === 'Líneas Nuevas')!
    expect(Object.keys(lineas.byWeek).sort()).toEqual(['2026-W01', '2026-W02'])
  })
})

describe('getSalesBySimTypeWeekly', () => {
  const w11 = new Date('2026-03-09T18:00:00Z') // 2026-W11
  const cat = (name: string | null) => ({ payment: { order: { items: name === null ? [] : [{ serializedItem: { category: { name } } }] } } })

  it('groups by SIM bucket per week; 3 fixed always present; Otros only when > 0', async () => {
    mockedSvFindMany.mockResolvedValue([
      { createdAt: w11, ...cat('SIM de Intercambio') },
      { createdAt: w11, ...cat('SIM de Intercambio') },
      { createdAt: w11, ...cat('SIM de Evento') },
      { createdAt: w11, ...cat('E-SIM de promotor') }, // → Otros SIMs
    ])
    const rows = await getSalesBySimTypeWeekly(ORG_ID, {})
    expect(rows.map(r => r.name)).toEqual(['SIM de Intercambio', '$100 de Promotor', 'SIM de Evento', 'Otros SIMs'])
    expect(rows[0]).toMatchObject({ total: 2, byWeek: { '2026-W11': 2 } })
    expect(rows[1]).toMatchObject({ total: 0, byWeek: {} }) // $100 fixed, zero, still present
    expect(rows[2]).toMatchObject({ total: 1 })
    expect(rows[3]).toMatchObject({ name: 'Otros SIMs', total: 1 })
  })

  it('omits "Otros SIMs" when every sale is a fixed category', async () => {
    mockedSvFindMany.mockResolvedValue([{ createdAt: w11, ...cat('$100 de Promotor') }])
    const rows = await getSalesBySimTypeWeekly(ORG_ID, {})
    expect(rows.map(r => r.name)).toEqual(['SIM de Intercambio', '$100 de Promotor', 'SIM de Evento'])
  })

  it('treats a sale with no serialized item as Otros SIMs', async () => {
    mockedSvFindMany.mockResolvedValue([{ createdAt: w11, ...cat(null) }])
    const rows = await getSalesBySimTypeWeekly(ORG_ID, {})
    expect(rows.find(r => r.name === 'Otros SIMs')).toMatchObject({ total: 1 })
  })
})

describe('weekly tables reconcile with the weekly bar', () => {
  it('grand totals: Σ sale-type == Σ sim-type == Σ by-week count', async () => {
    // Helper to build a sale record with a serialized item category name
    const c = (name: string) => ({
      payment: { amount: 100, order: { items: [{ serializedItem: { category: { name } } }] } },
    })
    const W11 = '2026-03-09T18:00:00Z' // ISO week 2026-W11
    const W12 = '2026-03-16T18:00:00Z' // ISO week 2026-W12
    // 4 sales across 2 weeks, 2 sale types, 3 SIM buckets (incl. Otros)
    const dataset = [
      { createdAt: new Date(W11), isPortabilidad: false, ...c('SIM de Intercambio') },
      { createdAt: new Date(W11), isPortabilidad: true, ...c('SIM de Evento') },
      { createdAt: new Date(W11), isPortabilidad: false, ...c('E-SIM de promotor') }, // → Otros SIMs
      { createdAt: new Date(W12), isPortabilidad: true, ...c('$100 de Promotor') },
    ]
    // All three functions share the same COMPLETED base query — one mock feeds all.
    mockedSvFindMany.mockResolvedValue(dataset)

    const byWeek = await getSalesByWeek(ORG_ID, {})
    const sale = await getSalesBySaleTypeWeekly(ORG_ID, {})
    const sim = await getSalesBySimTypeWeekly(ORG_ID, {})

    // Grand total from the bar chart (Σ count across all weeks)
    const grand = byWeek.reduce((a, r) => a + r.count, 0)

    // The two new weekly tables must agree with the bar's grand total.
    // (Per-week key reconciliation is skipped: getSalesByWeek keys by "Wxx"
    // while the two tables key by "YYYY-Www" — different formats, same invariant
    // is fully captured by the grand totals below.)
    expect(sale.reduce((a, r) => a + r.total, 0)).toBe(grand)
    expect(sim.reduce((a, r) => a + r.total, 0)).toBe(grand)

    // Additionally: the two new tables share the same "YYYY-Www" key format,
    // so we can verify per-week equality between them.
    const allWeeks = new Set([...sale.flatMap(r => Object.keys(r.byWeek)), ...sim.flatMap(r => Object.keys(r.byWeek))])
    for (const wk of allWeeks) {
      const saleWkTotal = sale.reduce((a, r) => a + (r.byWeek[wk] ?? 0), 0)
      const simWkTotal = sim.reduce((a, r) => a + (r.byWeek[wk] ?? 0), 0)
      expect(simWkTotal).toBe(saleWkTotal)
    }
  })
})

describe('getSalesBySimType — regrouped into SIM buckets', () => {
  it('collapses raw categories into the 3 fixed + Otros SIMs', async () => {
    mockedPaymentFindMany.mockResolvedValue([
      { createdAt: new Date('2026-03-15T18:00:00Z'), order: { items: [{ serializedItem: { category: { name: 'SIM de Intercambio' } } }] } },
      { createdAt: new Date('2026-03-16T18:00:00Z'), order: { items: [{ serializedItem: { category: { name: 'E-SIM de promotor' } } }] } },
    ])
    const rows = await getSalesBySimType(ORG_ID, {})
    expect(rows).toHaveLength(1)
    expect(rows[0].byCategory).toEqual({ 'SIM de Intercambio': 1, 'Otros SIMs': 1 })
    expect(rows[0].total).toBe(2)
  })
})
