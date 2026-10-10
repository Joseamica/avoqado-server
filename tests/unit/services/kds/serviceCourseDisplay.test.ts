import { prismaMock } from '../../../__helpers__/setup'
import { ventasDeComandas, anexarMesaYTiempos } from '@/services/mobile/kdsCapacidades'

it('kitchen keeps a renamed immediate label and a removed standard course by line identity', async () => {
  prismaMock.order.findMany.mockResolvedValue([{ id: 'order', type: 'DINE_IN', status: 'CONFIRMED', table: { number: '8' } }])
  const db = { ...prismaMock, deliveryLineAction: { findMany: jest.fn().mockResolvedValue([]) } }
  prismaMock.orderItem.findMany.mockResolvedValue([
    { id: 'a', orderId: 'order', course: null, serviceCourse: { id: 'immediate', label: 'Al momento', kind: 'IMMEDIATE' } },
    { id: 'b', orderId: 'order', course: 'Con el postre', serviceCourse: { id: 'historic', label: 'Con el postre', kind: 'STANDARD' } },
  ])
  const ticket = {
    orderId: 'order',
    items: [
      { id: 'ka', orderItemId: 'a' },
      { id: 'kb', orderItemId: 'b' },
    ],
  }
  const sale = (await ventasDeComandas(db as any, 'venue', [ticket])).get('order')!
  const result = anexarMesaYTiempos({ items: [{ id: 'kb' }, { id: 'ka' }] }, ticket as any, sale)
  expect(result.items).toEqual([
    expect.objectContaining({ id: 'kb', course: 'Con el postre' }),
    expect.objectContaining({ id: 'ka', course: 'Al momento' }),
  ])
  expect(prismaMock.orderItem.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ select: expect.objectContaining({ serviceCourse: true }) }),
  )
})
