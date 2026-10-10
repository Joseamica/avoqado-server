import { buildOrderItemsData } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn().mockResolvedValue(true) }))
const course = { id: 'desserts', label: 'Postres', kind: 'STANDARD' as const, preparationVersion: 1 as const, sortOrder: 3 }
it('preserves normal counter product snapshots including preparation negotiation without changing the price', async () => {
  prismaMock.product.findMany.mockResolvedValue([{ id: 'coffee', name: 'Café', sku: 'CAFE', price: 80, soldByWeight: false }])
  const result = await buildOrderItemsData('venue-a', [{ productId: 'coffee', quantity: 2, serviceCourse: course }])
  expect(result.subtotal).toBe(160)
  expect(result.itemsData[0]).toMatchObject({ serviceCourse: course, course: 'Postres', quantity: 2 })
})
