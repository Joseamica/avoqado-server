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
  it('only sums payments whose verification is COMPLETED', async () => {
    mockedPaymentFindMany.mockResolvedValue([
      { amount: 100, saleVerification: { status: 'COMPLETED' } },
      { amount: 50, saleVerification: { status: 'PENDING' } }, // en revisión — NO entra
      { amount: 25, saleVerification: { status: 'FAILED' } }, // rechazada — NO entra
      { amount: 10, saleVerification: null }, // sin verificación — NO entra
    ])

    const summary = await getOrgSalesSummary(ORG_ID, {})

    expect(summary.confirmedRevenue).toBe(100)
    // totalRevenue keeps legacy semantics (every completed payment) for backwards compat
    expect(summary.totalRevenue).toBe(185)
    expect(summary.completedCount).toBe(1)
    expect(summary.pendingCount).toBe(1)
    expect(summary.failedCount).toBe(1)
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
