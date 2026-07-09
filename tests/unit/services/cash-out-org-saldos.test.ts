/**
 * Unit test (mock-first) — org-wide Cash Out saldo roll-up per promoter.
 * Proves getSaldosForOrg materializes + reconciles PER VENUE before summing
 * (the real fresh-read path — never a raw ledger groupBy that skips
 * materialize), then groups AVAILABLE entries by staff.
 */
const mockMaterialize = jest.fn()
const mockReconcile = jest.fn()
const mockGroupBy = jest.fn()
const mockStaffFindMany = jest.fn()
const mockVenueFindMany = jest.fn()
const mockOrganizationModuleFindFirst = jest.fn()
const mockVenueModuleFindFirst = jest.fn()

jest.mock('@/services/dashboard/cash-out/cash-out.ledger.service', () => ({
  materializeEntries: (...a: unknown[]) => mockMaterialize(...(a as [])),
  reconcileClawbacks: (...a: unknown[]) => mockReconcile(...(a as [])),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    promoterCommissionEntry: { groupBy: (...a: unknown[]) => mockGroupBy(...(a as [])) },
    staff: { findMany: (...a: unknown[]) => mockStaffFindMany(...(a as [])) },
    venue: { findMany: (...a: unknown[]) => mockVenueFindMany(...(a as [])) },
    // assertCashOutEnabledForOrg (called by listVenueIdsForOrg, defined in the file under
    // test) checks org-level module enablement via organizationModule.findFirst first, then
    // falls back to venueModule.findFirst. Stub org-level as enabled so listVenueIdsForOrg
    // resolves straight to venue.findMany without hitting the fallback.
    organizationModule: { findFirst: (...a: unknown[]) => mockOrganizationModuleFindFirst(...(a as [])) },
    venueModule: { findFirst: (...a: unknown[]) => mockVenueModuleFindFirst(...(a as [])) },
  },
}))

import { getSaldosForOrg } from '../../../src/services/dashboard/cash-out/cash-out.org.service'

beforeEach(() => {
  jest.clearAllMocks()
  mockOrganizationModuleFindFirst.mockResolvedValue({ id: 'om1', enabled: true })
  mockVenueFindMany.mockResolvedValue([{ id: 'v1' }])
})

it('materializes + reconciles per venue, then sums AVAILABLE by staff', async () => {
  mockMaterialize.mockResolvedValue({ created: 0 })
  mockReconcile.mockResolvedValue({ clawedBack: 0 })
  mockGroupBy.mockResolvedValue([{ venueId: 'v1', staffId: 'p1', _sum: { amount: '120.50' } }])
  mockStaffFindMany.mockResolvedValue([{ id: 'p1', firstName: 'Ana', lastName: 'León' }])

  const res = await getSaldosForOrg('o1')

  expect(mockMaterialize).toHaveBeenCalledWith('v1')
  expect(mockReconcile).toHaveBeenCalledWith('v1')
  expect(mockVenueModuleFindFirst).not.toHaveBeenCalled()
  expect(res).toEqual([{ venueId: 'v1', staffId: 'p1', promoterName: 'Ana León', saldo: '120.5' }])
})

it('returns [] without touching the ledger when the org has no active venues', async () => {
  mockVenueFindMany.mockResolvedValue([])

  const res = await getSaldosForOrg('o1')

  expect(res).toEqual([])
  expect(mockMaterialize).not.toHaveBeenCalled()
  expect(mockReconcile).not.toHaveBeenCalled()
  expect(mockGroupBy).not.toHaveBeenCalled()
})

it('sorts saldos from highest to lowest across multiple promoters/venues', async () => {
  mockMaterialize.mockResolvedValue({ created: 0 })
  mockReconcile.mockResolvedValue({ clawedBack: 0 })
  mockVenueFindMany.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }])
  mockGroupBy.mockResolvedValue([
    { venueId: 'v1', staffId: 'p1', _sum: { amount: '50' } },
    { venueId: 'v2', staffId: 'p2', _sum: { amount: '200' } },
  ])
  mockStaffFindMany.mockResolvedValue([
    { id: 'p1', firstName: 'Ana', lastName: 'León' },
    { id: 'p2', firstName: 'Beto', lastName: 'Ruiz' },
  ])

  const res = await getSaldosForOrg('o1')

  expect(mockMaterialize).toHaveBeenCalledWith('v1')
  expect(mockMaterialize).toHaveBeenCalledWith('v2')
  expect(res.map(r => r.staffId)).toEqual(['p2', 'p1'])
})
