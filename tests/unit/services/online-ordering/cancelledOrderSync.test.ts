// tests/unit/services/online-ordering/cancelledOrderSync.test.ts
import { prismaMock } from '@tests/__helpers__/setup'
import { CANCELLED_ELSEWHERE, syncOnlineOrdersOfCancelledOrders } from '@/services/online-ordering/cancelledOrderSync'

const NOW = new Date('2026-10-14T18:30:00.000Z')

describe('syncOnlineOrdersOfCancelledOrders (R2)', () => {
  it('cierra con CAS sólo los pedidos abiertos cuya cuenta se canceló por otra vía, sin aviso de «vencido»', async () => {
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 2 })
    await expect(syncOnlineOrdersOfCancelledOrders(prismaMock, { venueId: 'v1' }, NOW)).resolves.toBe(2)
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenCalledWith({
      where: {
        venueId: 'v1',
        status: { in: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'READY'] },
        order: { status: { in: ['CANCELLED', 'DELETED'] } },
      },
      data: { status: 'CANCELLED_BY_STAFF', cancelledAt: NOW, cancelledBy: CANCELLED_ELSEWHERE },
    })
  })

  it('el job lo llama para todos los negocios (sin venueId) y una transición lo acota a su orden', async () => {
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 0 })
    await syncOnlineOrdersOfCancelledOrders(prismaMock, {}, NOW)
    expect((prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any).where.venueId).toBeUndefined()
    await syncOnlineOrdersOfCancelledOrders(prismaMock, { venueId: 'v1', orderId: 'ord1' }, NOW)
    expect((prismaMock.onlineOrder.updateMany.mock.calls[1][0] as any).where).toMatchObject({ venueId: 'v1', orderId: 'ord1' })
  })
})
