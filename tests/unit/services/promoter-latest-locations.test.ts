const mockVenueFindUnique = jest.fn()
const mockPingFindMany = jest.fn()
const mockStaffFindMany = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) },
    promoterLocationPing: { findMany: (...a: unknown[]) => mockPingFindMany(...(a as [])) },
    staff: { findMany: (...a: unknown[]) => mockStaffFindMany(...(a as [])) },
  },
}))

import { getLatestPromoterLocationsForVenue } from '../../../src/services/promoters/promoterLocation.service'

beforeEach(() => jest.clearAllMocks())

it('returns the latest ping per promoter', async () => {
  mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  mockPingFindMany.mockResolvedValue([
    { staffId: 'p1', latitude: 1, longitude: 2, accuracy: 5, capturedAt: new Date('2026-05-01T18:00:00Z'), source: 'PERIODIC' },
    { staffId: 'p1', latitude: 1, longitude: 2, accuracy: 5, capturedAt: new Date('2026-05-01T17:00:00Z'), source: 'PERIODIC' },
    { staffId: 'p2', latitude: 3, longitude: 4, accuracy: 5, capturedAt: new Date('2026-05-01T16:00:00Z'), source: 'PERIODIC' },
  ])
  mockStaffFindMany.mockResolvedValue([
    { id: 'p1', firstName: 'Ana', lastName: 'León' },
    { id: 'p2', firstName: 'Beto', lastName: 'Ruiz' },
  ])
  const res = await getLatestPromoterLocationsForVenue('v1', '2026-05-01')
  expect(res).toHaveLength(2)
  const p1 = res.find(r => r.promoterId === 'p1')!
  expect(p1.name).toBe('Ana León')
  expect(p1.latest?.capturedAt).toEqual(new Date('2026-05-01T18:00:00Z'))
})
