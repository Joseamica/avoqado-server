const mockPrisma = {
  kdsOrder: { findMany: jest.fn(), count: jest.fn() },
  order: { findMany: jest.fn().mockResolvedValue([]) },
  printStation: { findMany: jest.fn().mockResolvedValue([]) },
}
jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
import { listKdsOrders } from '../../../../src/services/mobile/kds.mobile.service'
const order = (id: string) => ({
  id,
  orderNumber: id,
  orderType: 'DINE_IN',
  orderId: null,
  status: 'NEW',
  createdAt: new Date('2026-10-08'),
  startedAt: null,
  completedAt: null,
  items: [],
})
const page = (offset = 0, limit = 100) => listKdsOrders('venue', undefined, undefined, { urgencyVersion: 1, offset, limit })
beforeEach(() => jest.clearAllMocks())
it('selects urgent tickets before the limit, even when older than a hundred normal tickets', async () => {
  mockPrisma.kdsOrder.count.mockResolvedValue(1)
  mockPrisma.kdsOrder.findMany.mockResolvedValueOnce([order('old-urgent')]).mockResolvedValueOnce([order('normal')])
  expect((await page()).map(o => o.id)).toEqual(['old-urgent', 'normal'])
  expect(mockPrisma.kdsOrder.findMany).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      take: 1,
      where: expect.objectContaining({
        venueId: 'venue',
        AND: expect.arrayContaining([expect.objectContaining({ preparationVersion: 1, items: expect.any(Object) })]),
      }),
    }),
  )
  expect(mockPrisma.kdsOrder.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ take: 99, skip: 0 }))
})
it('pages across the urgent and normal boundary without fetching all tickets', async () => {
  mockPrisma.kdsOrder.count.mockResolvedValue(3)
  mockPrisma.kdsOrder.findMany.mockResolvedValue([order('normal')])
  expect((await page(5, 10)).map(o => o.id)).toEqual(['normal'])
  expect(mockPrisma.kdsOrder.findMany).toHaveBeenCalledTimes(1)
  expect(mockPrisma.kdsOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 2, take: 10 }))
})
it('rejects invalid pagination instead of exposing an unbounded scan', async () => {
  await expect(page(-1)).rejects.toThrow()
  await expect(page(0, 101)).rejects.toThrow()
  expect(mockPrisma.kdsOrder.findMany).not.toHaveBeenCalled()
})
