const mockVenueFindMany = jest.fn()
const mockStaffVenueFindMany = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findMany: (...a: unknown[]) => mockVenueFindMany(...(a as [])) },
    staffVenue: { findMany: (...a: unknown[]) => mockStaffVenueFindMany(...(a as [])) },
  },
}))
jest.mock('@/services/dashboard/sale-verification.dashboard.service', () => ({ reviewSaleVerification: jest.fn() }))
jest.mock('@/services/modules/module.service', () => ({ moduleService: {}, MODULE_CODES: {} }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { emit: jest.fn() } }))
jest.mock('@/communication/sockets/types', () => ({ SocketEventType: {} }))

import { getOrgStructure } from '../../../src/services/dashboard/sale-verification.org.dashboard.service'

beforeEach(() => jest.clearAllMocks())

it('groups promoters (CASHIER/WAITER) under the venue MANAGER; lists unassigned stores', async () => {
  mockVenueFindMany.mockResolvedValue([
    { id: 'v1', name: 'BAE Uno' },
    { id: 'v2', name: 'BAE Vacante' },
  ])
  mockStaffVenueFindMany.mockImplementation((args: any) => {
    const roles = args.where.role.in
    if (roles.includes('MANAGER')) return Promise.resolve([{ venueId: 'v1', role: 'MANAGER', staff: { id: 'sup1', firstName: 'Hugo', lastName: 'G' } }])
    return Promise.resolve([{ venueId: 'v1', staff: { id: 'p1', firstName: 'Ana', lastName: 'León' } }])
  })
  const res = await getOrgStructure('o1')
  expect(res.supervisors).toHaveLength(1)
  expect(res.supervisors[0]).toMatchObject({ supervisorId: 'sup1', supervisorName: 'Hugo G' })
  expect(res.supervisors[0].stores[0]).toMatchObject({ venueId: 'v1', promoters: [{ staffId: 'p1', name: 'Ana León' }] })
  expect(res.unassignedStores.map((s: any) => s.venueId)).toEqual(['v2'])
})
