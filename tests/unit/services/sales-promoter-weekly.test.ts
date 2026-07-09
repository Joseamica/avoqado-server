const mockSVFindMany = jest.fn()
const mockStaffVenueFindMany = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    saleVerification: { findMany: (...a: unknown[]) => mockSVFindMany(...(a as [])) },
    staffVenue: { findMany: (...a: unknown[]) => mockStaffVenueFindMany(...(a as [])) },
  },
}))
jest.mock('@/services/dashboard/sale-verification.dashboard.service', () => ({ reviewSaleVerification: jest.fn() }))
jest.mock('@/services/modules/module.service', () => ({ moduleService: {}, MODULE_CODES: {} }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { emit: jest.fn() } }))
jest.mock('@/communication/sockets/types', () => ({ SocketEventType: {} }))

import { getSalesByPromoterWeekly } from '../../../src/services/dashboard/sale-verification.org.dashboard.service'

beforeEach(() => jest.clearAllMocks())

it('buckets a promoter by ISO week and attributes venue + supervisor', async () => {
  mockSVFindMany.mockResolvedValue([
    {
      createdAt: new Date('2026-05-01T18:00:00Z'),
      venueId: 'v1',
      venue: { id: 'v1', name: 'BAE Uno' },
      staff: { id: 'p1', firstName: 'Ana', lastName: 'León' },
    },
    {
      createdAt: new Date('2026-05-08T18:00:00Z'),
      venueId: 'v1',
      venue: { id: 'v1', name: 'BAE Uno' },
      staff: { id: 'p1', firstName: 'Ana', lastName: 'León' },
    },
  ])
  mockStaffVenueFindMany.mockResolvedValue([{ venueId: 'v1', role: 'MANAGER', staff: { id: 'sup1', firstName: 'Hugo', lastName: 'G' } }])
  const rows = await getSalesByPromoterWeekly('o1', { from: new Date('2026-04-01'), to: new Date('2026-06-01') } as never)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    staffId: 'p1',
    venueId: 'v1',
    venueName: 'BAE Uno',
    supervisorId: 'sup1',
    supervisorName: 'Hugo G',
    total: 2,
  })
  expect(Object.values(rows[0].byWeek).reduce((a, b) => a + b, 0)).toBe(2)
})
