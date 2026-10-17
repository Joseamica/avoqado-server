// tests/unit/services/online-ordering/paidPickupSync.test.ts
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
import { announceCollectedAutomatically, syncOnlineOrdersOfPaidPickups } from '@/services/online-ordering/paidPickupSync'

const NOW = new Date('2026-10-14T18:30:00.000Z')
const fila = (id: string, o: Record<string, unknown> = {}) => ({
  id: `oo-${id}`,
  orderId: `ord-${id}`,
  venueId: 'v1',
  status: 'READY',
  paymentMode: 'PAY_AT_PICKUP',
  order: { orderNumber: `W${id}` },
  ...o,
})

describe('syncOnlineOrdersOfPaidPickups (opción 1 del founder, 17-oct)', () => {
  it('filtro EXACTO: pagar al recoger, cuenta PAGADA y viva, y LISTO o ACEPTADO ya pasada su hora; nunca por aceptar', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([])
    await syncOnlineOrdersOfPaidPickups(prismaMock, { venueId: 'v1' }, NOW)
    expect(prismaMock.onlineOrder.findMany).toHaveBeenCalledWith({
      where: {
        venueId: 'v1',
        paymentMode: 'PAY_AT_PICKUP',
        order: { paymentStatus: 'PAID', status: { notIn: ['CANCELLED', 'DELETED'] } },
        OR: [{ status: 'READY' }, { status: 'ACCEPTED', estimatedReadyAt: { lte: NOW } }],
      },
      select: { id: true, orderId: true, venueId: true, status: true, order: { select: { orderNumber: true } } },
      orderBy: { id: 'asc' },
      take: 100,
    })
    // El job lo corre para todos los negocios.
    await syncOnlineOrdersOfPaidPickups(prismaMock, {}, NOW)
    expect((prismaMock.onlineOrder.findMany.mock.calls[1][0] as any).where).not.toHaveProperty('venueId')
  })

  it('una fila con OTRO modo de pago (p. ej. la tarjeta de la fase 2) no se toca', async () => {
    // La base simulada aplica el filtro de modo: sin él, la fila con tarjeta se «entregaría» sola al aceptarse.
    const filas = [fila('A'), fila('T', { paymentMode: 'CARD_ONLINE' })]
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) =>
      filas.filter(f => a.where.paymentMode === undefined || f.paymentMode === a.where.paymentMode)) as any)
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })

    const won = await syncOnlineOrdersOfPaidPickups(prismaMock, { venueId: 'v1' }, NOW)

    expect(won.map(w => w.id)).toEqual(['oo-A'])
    const tocadas = prismaMock.onlineOrder.updateMany.mock.calls.map((c: any[]) => c[0].where.id)
    expect(tocadas).toEqual(['oo-A'])
  })

  it('CAS por fila sobre el estado leído; sólo escribe el pedido en línea, nunca la cuenta', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([fila('A'), fila('B', { status: 'ACCEPTED' })] as any)
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })

    const won = await syncOnlineOrdersOfPaidPickups(prismaMock, { venueId: 'v1' }, NOW)

    expect(prismaMock.onlineOrder.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'oo-A', status: 'READY' },
      data: { status: 'COMPLETED', completedAt: NOW },
    })
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'oo-B', status: 'ACCEPTED' },
      data: { status: 'COMPLETED', completedAt: NOW },
    })
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(won).toEqual([
      { id: 'oo-A', orderId: 'ord-A', venueId: 'v1', orderNumber: 'WA' },
      { id: 'oo-B', orderId: 'ord-B', venueId: 'v1', orderNumber: 'WB' },
    ])
  })

  it('de dos pasadas que compiten gana una; sólo la ganadora anuncia: socket a la bandeja y bitácora automática, sin aviso al comensal', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([fila('A')] as any)
    prismaMock.onlineOrder.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    const [a, b] = await Promise.all([
      syncOnlineOrdersOfPaidPickups(prismaMock, { venueId: 'v1' }, NOW),
      syncOnlineOrdersOfPaidPickups(prismaMock, {}, NOW),
    ])
    announceCollectedAutomatically(a, NOW)
    announceCollectedAutomatically(b, NOW)

    expect([a.length, b.length].sort()).toEqual([0, 1])
    expect(socketManager.broadcastToVenue).toHaveBeenCalledTimes(1)
    expect(socketManager.broadcastToVenue).toHaveBeenCalledWith(
      'v1',
      SocketEventType.ORDER_UPDATED,
      expect.objectContaining({ orderId: 'ord-A', orderNumber: 'WA', onlineStatus: 'COMPLETED', timestamp: NOW.toISOString() }),
    )
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith({
      staffId: null,
      venueId: 'v1',
      action: 'ONLINE_ORDER_COLLECTED',
      entity: 'OnlineOrder',
      entityId: 'oo-A',
      data: { orderNumber: 'WA', automatic: true },
    })
    expect(notifyOrderEvent).not.toHaveBeenCalled()
  })
})
