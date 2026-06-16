/*
  API tests for the sales-summary export route:
    GET /api/v1/dashboard/reports/venues/:venueId/sales-summary/export

  Streams a CSV/XLSX/PDF of the sales summary.
    - mode=summary flattens getSalesSummary() (Free-tier today-only via range clamp).
    - mode=detailed is PREMIUM-gated on TRANSACTION_EXPORT and emits per-payment rows,
      with a pre-flight row-cap → 413.

  Six assertions (regression):
   1. summary mode → 200 + text/csv + attachment Content-Disposition.
   2. detailed mode for a non-entitled venue → 403 carrying the platform-wide
      feature-gate contract (featureCode='TRANSACTION_EXPORT', subscriptionRequired=true).
   3. detailed mode over the row cap → 413 with { success: false }.
   4. detailed mode for a PREMIUM venue → 200 + text/csv.
   5. detailed mode + paymentMethod=QR_LEGACY → 400 (BadRequest), NOT 500. Legacy QR
      transactions have no per-payment row in the native Payment table; the controller
      rejects them BEFORE buildPaymentWhereFilter('QR_LEGACY') can throw. (Edge bug fix.)
   6. summary mode + sections=merchantAccounts tier gate (FIX 1, tier-leak): a
      NON-entitled venue (ADVANCED_REPORTS=false) → 200 but getSalesSummary is called
      with includeMerchantBreakdown:false (flag dropped → no per-merchant rows leak).
      Positive twin: an entitled venue (ADVANCED_REPORTS=true) → includeMerchantBreakdown:true.

  Harness mirrors tests/api-tests/dashboard/saleVerificationEdit.api.test.ts: Prisma is
  globally mocked via tests/__helpers__/setup.ts (prismaMock) and the REAL controller +
  REAL route run against the mock. There is NO real test database.

  DEVIATION FROM THE PLAN (mocking mechanism): the plan used jest.spyOn(access,…) /
  jest.spyOn(svc,…). That does NOT work here — beforeAll calls jest.resetModules() before
  importing @/app, so the app's middleware/controller capture a *different* module
  instance of basePlan.service / sales-summary.dashboard.service than the test's top-level
  `import * as`. A spy on the test's instance never intercepts the app's instance, and the
  route's clampSalesSummaryRangeToToday middleware (which also calls venueHasFeatureAccess)
  hit the REAL impl → 500. Fixed by following the repo's established pattern
  (tests/unit/services/planState.retentionOffer.test.ts): jest.mock(..., factory) preserving
  the real module and overriding only the fns we drive, via hoisted mock vars. This replaces
  the module for ALL importers (middleware + controller) regardless of resetModules.
  Assertions + the 4 cases are unchanged.
*/

import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { prismaMock } from '@tests/__helpers__/setup'
import type { SalesSummaryResponse } from '@/services/dashboard/sales-summary.dashboard.service'
// Real MindForm venue id — the ONE venue allowed to filter QR_LEGACY. Imported (not
// hard-coded) so the test stays in lockstep with the controller's own guard source.
import { MINDFORM_NEW_VENUE_ID as MINDFORM_VENUE_ID } from '@/services/legacy/qrPayments.legacy.service'

// ── Hoisted mock fns (driven per test) ─────────────────────────────────────
const mockVenueHasFeatureAccess = jest.fn<Promise<boolean>, [string, string]>()
const mockGetSalesSummary = jest.fn()
const mockCountSalesSummaryDetailRows = jest.fn()
const mockFetchSalesSummaryDetailRows = jest.fn()

// Replace the module for EVERY importer (route middleware + controller). Preserve the
// real module so types/other exports are intact; override only venueHasFeatureAccess.
jest.mock('@/services/access/basePlan.service', () => {
  const actual = jest.requireActual('@/services/access/basePlan.service')
  return { __esModule: true, ...actual, venueHasFeatureAccess: (...a: [string, string]) => mockVenueHasFeatureAccess(...a) }
})

// Preserve the real sales-summary service (flattenSalesSummaryForExport, types,
// buildPaymentWhereFilter, etc.) and override only the data-fetching fns.
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => {
  const actual = jest.requireActual('@/services/dashboard/sales-summary.dashboard.service')
  return {
    __esModule: true,
    ...actual,
    getSalesSummary: (...a: unknown[]) => mockGetSalesSummary(...a),
    countSalesSummaryDetailRows: (...a: unknown[]) => mockCountSalesSummaryDetailRows(...a),
    fetchSalesSummaryDetailRows: (...a: unknown[]) => mockFetchSalesSummaryDetailRows(...a),
  }
})

let app: Express
const TEST_SECRET = 'test-secret'
// CUID-style ids for realism/consistency with the other api-tests.
const ORG_ID = 'cltestorgsse01234567890123'
const VENUE_ID = 'cltestvenuesse0123456789012'
const STAFF_ID = 'cltestuseridsse012345678901'

// A historical range (NOT "today"): only reachable when ADVANCED_REPORTS is granted, so the
// clamp middleware passes it through (every case mocks ADVANCED_REPORTS=true).
const RANGE = 'startDate=2026-06-01T00:00:00.000Z&endDate=2026-06-07T23:59:59.999Z'

// A TODAY-only range in the venue timezone (America/Mexico_City — what venue.findUnique mocks).
// The Free-tier clamp (clampSalesSummaryRangeToToday) lets a NON-entitled venue through ONLY
// when both startDate and endDate fall on today's calendar date in that tz. We compute the
// instants dynamically (start-of-day / end-of-day of today's Mexico_City date) so the
// non-entitled summary case can reach the controller without ADVANCED_REPORTS. Mirrors the
// instants the dashboard sends for a same-day query.
const VENUE_TZ = 'America/Mexico_City'
const todayRange = () => {
  const todayKey = formatInTimeZone(new Date(), VENUE_TZ, 'yyyy-MM-dd') // e.g. 2026-06-15
  const startISO = fromZonedTime(`${todayKey}T00:00:00.000`, VENUE_TZ).toISOString()
  const endISO = fromZonedTime(`${todayKey}T23:59:59.999`, VENUE_TZ).toISOString()
  return `startDate=${startISO}&endDate=${endISO}`
}

// Minimally-valid SalesSummaryResponse — the REAL flattener reads `summary` + byPaymentMethod.
// byMerchantAccount is intentionally ABSENT (mirrors getSalesSummary dropping it when
// includeMerchantBreakdown is false), so the flattener produces zero 'merchantAccounts' rows.
const makeFakeReport = (): SalesSummaryResponse => ({
  dateRange: { startDate: new Date('2026-06-01'), endDate: new Date('2026-06-07') },
  reportType: 'summary',
  summary: {
    grossSales: 1000,
    items: 1000,
    serviceCosts: 0,
    discounts: 100,
    refunds: 25,
    netSales: 875,
    deferredSales: 0,
    taxes: 140,
    tips: 60,
    platformFees: 12,
    staffCommissions: 0,
    commissions: 12,
    totalCollected: 935,
    netProfit: 863,
    transactionCount: 42,
  },
  byPaymentMethod: [{ method: 'CARD', amount: 700, count: 30, percentage: 70 }],
  filtered: false,
})

const exportUrl = (qs: string) => `/api/v1/dashboard/reports/venues/${VENUE_ID}/sales-summary/export?${qs}`

beforeAll(async () => {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test'
  process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || TEST_SECRET
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session'
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie'
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb'

  jest.resetModules()

  // Bypass express-session middleware (not relevant to these routes).
  jest.mock('@/config/session', () => ({
    __esModule: true,
    default: (_req: any, _res: any, next: any) => next(),
  }))

  const mod = await import('@/app')
  app = mod.default
})

/** JWT matching AvoqadoJwtPayload — tokenVenueId === :venueId so the token role drives access. */
const makeToken = (role: string) =>
  jwt.sign({ sub: STAFF_ID, orgId: ORG_ID, venueId: VENUE_ID, role }, process.env.ACCESS_TOKEN_SECRET || TEST_SECRET)

const authHeader = (role: string) => ({ Authorization: `Bearer ${makeToken(role)}` })

beforeEach(() => {
  // No SUPERADMIN bypass; no per-venue custom permission override.
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  // venue.findUnique is hit by the clamp middleware + summary-mode timezone fetch.
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
})

describe('GET /api/v1/dashboard/reports/venues/:venueId/sales-summary/export', () => {
  it('summary mode returns a CSV (200, text/csv)', async () => {
    // venueHasFeatureAccess: true for any code (ADVANCED_REPORTS clamp passthrough + merchant gate).
    mockVenueHasFeatureAccess.mockResolvedValue(true)
    mockGetSalesSummary.mockResolvedValue(makeFakeReport())

    const res = await request(app)
      .get(exportUrl(`mode=summary&format=csv&${RANGE}`))
      .set(authHeader('OWNER'))

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('attachment')
  })

  it('detailed mode is PREMIUM-gated: 403 for a non-entitled venue', async () => {
    // ADVANCED_REPORTS true (clamp passes) but TRANSACTION_EXPORT false → controller 403.
    mockVenueHasFeatureAccess.mockImplementation(async (_v, code) => code === 'ADVANCED_REPORTS')

    const res = await request(app)
      .get(exportUrl(`mode=detailed&format=csv&${RANGE}`))
      .set(authHeader('OWNER'))

    expect(res.status).toBe(403)
    // Must match the platform-wide feature-gate contract verbatim — featureCode +
    // subscriptionRequired are what the dashboard FeatureGate/upsell + export dialog read.
    expect(res.body.featureCode).toBe('TRANSACTION_EXPORT')
    expect(res.body.subscriptionRequired).toBe(true)
  })

  it('row-cap exceeded returns 413', async () => {
    mockVenueHasFeatureAccess.mockResolvedValue(true)
    mockCountSalesSummaryDetailRows.mockResolvedValue(20_000)

    const res = await request(app)
      .get(exportUrl(`mode=detailed&format=csv&${RANGE}`))
      .set(authHeader('OWNER'))

    expect(res.status).toBe(413)
    expect(res.body.success).toBe(false)
  })

  it('detailed CSV for a PREMIUM venue returns 200', async () => {
    mockVenueHasFeatureAccess.mockResolvedValue(true)
    mockCountSalesSummaryDetailRows.mockResolvedValue(3)
    mockFetchSalesSummaryDetailRows.mockResolvedValue([])

    const res = await request(app)
      .get(exportUrl(`mode=detailed&format=csv&${RANGE}`))
      .set(authHeader('OWNER'))

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
  })

  // ── FIX (edge bug): QR_LEGACY in detailed mode must 400, NEVER 500 ──────────
  // Legacy QR transactions live in the legacy avo-pwa store, not the native Payment
  // table that the detailed export reads. Without the controller guard, paymentMethod
  // =QR_LEGACY flows into buildPaymentWhereFilter('QR_LEGACY') which THROWS → unhandled
  // 500. The controller now rejects it up front with a BadRequestError (400).
  //
  // CRITICAL: we must use the MindForm venue id here. For ANY OTHER venue, the earlier
  // "QR_LEGACY filter is only available for the MindForm venue" guard already 400s before
  // the detailed branch — so a non-MindForm venue would pass even WITHOUT the new guard and
  // wouldn't exercise the fix. The MindForm venue clears that earlier guard and reaches the
  // detailed branch, where ONLY the new guard stands between QR_LEGACY and the throwing
  // buildPaymentWhereFilter('QR_LEGACY'). The JWT venueId === MindForm id so the token role
  // drives access (no staffVenue lookup needed; mirrors makeToken/authHeader for VENUE_ID).
  it('detailed mode + paymentMethod=QR_LEGACY (MindForm venue) returns 400 (BadRequest), not 500', async () => {
    mockVenueHasFeatureAccess.mockResolvedValue(true) // ADVANCED_REPORTS clamp + TRANSACTION_EXPORT

    const mindformToken = jwt.sign(
      { sub: STAFF_ID, orgId: ORG_ID, venueId: MINDFORM_VENUE_ID, role: 'OWNER' },
      process.env.ACCESS_TOKEN_SECRET || TEST_SECRET,
    )
    const mindformUrl = `/api/v1/dashboard/reports/venues/${MINDFORM_VENUE_ID}/sales-summary/export?mode=detailed&format=csv&paymentMethod=QR_LEGACY&${RANGE}`

    const res = await request(app)
      .get(mindformUrl)
      .set({ Authorization: `Bearer ${mindformToken}` })

    expect(res.status).toBe(400)
    // The per-payment fetch must NEVER run for QR_LEGACY (would have thrown → 500).
    expect(mockCountSalesSummaryDetailRows).not.toHaveBeenCalled()
    expect(mockFetchSalesSummaryDetailRows).not.toHaveBeenCalled()
  })

  // ── FIX 1 coverage (tier-leak): merchantAccounts section must NOT leak PRO data ──
  // The merchant-reconciliation block (byMerchantAccount) rides ADVANCED_REPORTS (PRO).
  // A NON-entitled venue requesting sections=merchantAccounts must still get a 200, but
  // the controller must call getSalesSummary with includeMerchantBreakdown:false so
  // byMerchantAccount is omitted and the REAL flattener emits ZERO merchantAccounts rows.
  it('summary mode drops includeMerchantBreakdown for a NON-entitled venue (no tier leak)', async () => {
    // ADVANCED_REPORTS=false for ALL codes → not entitled. To reach the controller despite the
    // Free-tier clamp (which also checks ADVANCED_REPORTS), we use a today-only range so the
    // clamp passes the request through.
    mockVenueHasFeatureAccess.mockResolvedValue(false)
    mockGetSalesSummary.mockResolvedValue(makeFakeReport())

    const res = await request(app)
      .get(exportUrl(`mode=summary&format=csv&sections=merchantAccounts&${todayRange()}`))
      .set(authHeader('OWNER'))

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')

    // Most direct, robust assertion of FIX 1: the controller dropped the flag.
    expect(mockGetSalesSummary).toHaveBeenCalledTimes(1)
    const [, filters] = mockGetSalesSummary.mock.calls[0] as [string, { includeMerchantBreakdown?: boolean }]
    expect(filters.includeMerchantBreakdown).toBe(false)

    // And the REAL flattener (not mocked) genuinely produced NO merchant-account rows:
    // byMerchantAccount is absent in makeFakeReport, so the CSV body has zero 'merchantAccounts' rows.
    expect(res.text).not.toMatch(/merchantAccounts/)
  })

  // Positive twin: an entitled venue (ADVANCED_REPORTS=true) keeps includeMerchantBreakdown:true.
  it('summary mode keeps includeMerchantBreakdown for an ENTITLED venue', async () => {
    mockVenueHasFeatureAccess.mockResolvedValue(true)
    mockGetSalesSummary.mockResolvedValue(makeFakeReport())

    const res = await request(app)
      .get(exportUrl(`mode=summary&format=csv&sections=merchantAccounts&${RANGE}`))
      .set(authHeader('OWNER'))

    expect(res.status).toBe(200)
    expect(mockGetSalesSummary).toHaveBeenCalledTimes(1)
    const [, filters] = mockGetSalesSummary.mock.calls[0] as [string, { includeMerchantBreakdown?: boolean }]
    expect(filters.includeMerchantBreakdown).toBe(true)
  })
})
