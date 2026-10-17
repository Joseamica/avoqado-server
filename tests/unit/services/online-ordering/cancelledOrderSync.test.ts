// tests/unit/services/online-ordering/cancelledOrderSync.test.ts
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/online-ordering/notifications.service', () => ({
  __esModule: true,
  notifyOrderEvent: jest.fn(async () => undefined),
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn() },
}))

import { socketManager } from '@/communication/sockets/managers/socketManager'
import { SocketEventType } from '@/communication/sockets/types'
import { notifyOrderEvent } from '@/services/online-ordering/notifications.service'
import {
  announceCancelledElsewhere,
  CANCELLED_ELSEWHERE,
  syncOnlineOrdersOfCancelledOrders,
} from '@/services/online-ordering/cancelledOrderSync'

const NOW = new Date('2026-10-14T18:30:00.000Z')
const OPEN = ['PENDING_ACCEPTANCE', 'ACCEPTED', 'READY']
const fila = (id: string, orderStatus = 'CANCELLED') => ({
  id: `oo-${id}`,
  orderId: `ord-${id}`,
  venueId: 'v1',
  order: { orderNumber: `W${id}`, status: orderStatus },
})

describe('syncOnlineOrdersOfCancelledOrders (R2)', () => {
  it('lee con tope y orden estable sólo los pedidos abiertos de cuentas canceladas por otra vía, y cierra cada uno con SU CAS', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([fila('A'), fila('B', 'DELETED')] as any)
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })

    const won = await syncOnlineOrdersOfCancelledOrders(prismaMock, { venueId: 'v1' }, NOW)

    expect(prismaMock.onlineOrder.findMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', status: { in: OPEN }, order: { status: { in: ['CANCELLED', 'DELETED'] } } },
      select: { id: true, orderId: true, venueId: true, order: { select: { orderNumber: true, status: true } } },
      orderBy: { id: 'asc' },
      take: 100,
    })
    const data = { status: 'CANCELLED_BY_STAFF', cancelledAt: NOW, cancelledBy: CANCELLED_ELSEWHERE }
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenNthCalledWith(1, { where: { id: 'oo-A', status: { in: OPEN } }, data })
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenNthCalledWith(2, { where: { id: 'oo-B', status: { in: OPEN } }, data })
    expect(won).toEqual([
      { id: 'oo-A', orderId: 'ord-A', venueId: 'v1', orderNumber: 'WA', orderStatus: 'CANCELLED' },
      { id: 'oo-B', orderId: 'ord-B', venueId: 'v1', orderNumber: 'WB', orderStatus: 'DELETED' },
    ])
    // Sincronizar NO avisa: el aviso sale después del commit, desde quien la llamó.
    expect(notifyOrderEvent).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('de dos pasadas que compiten por el mismo pedido (bandeja y job) gana una: sólo la ganadora lo devuelve y sólo ella avisa', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([fila('A')] as any)
    prismaMock.onlineOrder.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    const [a, b] = await Promise.all([
      syncOnlineOrdersOfCancelledOrders(prismaMock, { venueId: 'v1' }, NOW),
      syncOnlineOrdersOfCancelledOrders(prismaMock, {}, NOW),
    ])
    announceCancelledElsewhere(a, NOW)
    announceCancelledElsewhere(b, NOW)

    expect([a.length, b.length].sort()).toEqual([0, 1])
    expect(notifyOrderEvent).toHaveBeenCalledTimes(1)
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord-A', 'CANCELLED')
    expect(socketManager.broadcastToVenue).toHaveBeenCalledTimes(1)
    expect(socketManager.broadcastToVenue).toHaveBeenCalledWith(
      'v1',
      SocketEventType.ORDER_UPDATED,
      expect.objectContaining({ orderId: 'ord-A', orderNumber: 'WA', onlineStatus: 'CANCELLED_BY_STAFF', status: 'CANCELLED' }),
    )
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith({
      staffId: null,
      venueId: 'v1',
      action: 'ONLINE_ORDER_CANCELLED_BY_STAFF',
      entity: 'OnlineOrder',
      entityId: 'oo-A',
      data: { orderNumber: 'WA', cancelledBy: CANCELLED_ELSEWHERE },
    })
  })

  it('el job (sin venueId) cubre todos los negocios, una transición lo acota a su orden y un venueId vacío NUNCA es «todos»', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([])
    await syncOnlineOrdersOfCancelledOrders(prismaMock, {}, NOW)
    expect((prismaMock.onlineOrder.findMany.mock.calls[0][0] as any).where).not.toHaveProperty('venueId')
    await syncOnlineOrdersOfCancelledOrders(prismaMock, { venueId: 'v1', orderId: 'ord1' }, NOW)
    expect((prismaMock.onlineOrder.findMany.mock.calls[1][0] as any).where).toMatchObject({ venueId: 'v1', orderId: 'ord1' })
    await syncOnlineOrdersOfCancelledOrders(prismaMock, { venueId: '' }, NOW)
    expect((prismaMock.onlineOrder.findMany.mock.calls[2][0] as any).where).toMatchObject({ venueId: '' })
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
  })
})
