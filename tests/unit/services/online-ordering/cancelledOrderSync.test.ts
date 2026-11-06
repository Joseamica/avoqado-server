// tests/unit/services/online-ordering/cancelledOrderSync.test.ts
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
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
  cerrarCanceladasReleyendo,
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

  it('A5: si el CAS de una fila falla, se registra con su id y la pasada sigue; las que sí cerraron se devuelven y se anuncian', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([fila('A'), fila('B'), fila('C')] as any)
    prismaMock.onlineOrder.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce({ count: 1 })
    const error = jest.spyOn(logger, 'error')

    const won = await syncOnlineOrdersOfCancelledOrders(prismaMock, { venueId: 'v1' }, NOW)

    expect(won.map(w => w.id)).toEqual(['oo-A', 'oo-C'])
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ onlineOrderId: 'oo-B' }))
    announceCancelledElsewhere(won, NOW)
    expect((notifyOrderEvent as jest.Mock).mock.calls).toEqual([
      ['ord-A', 'CANCELLED'],
      ['ord-C', 'CANCELLED'],
    ])
  })
})

describe('cerrarCanceladasReleyendo (R12: la bandeja, las listas y el job releen la cuenta bajo el candado)', () => {
  const CANCELADA = { status: { in: ['CANCELLED', 'DELETED'] } }
  /** La base simulada: cada pedido con su cuenta; el CAS aplica el filtro de la cuenta que trae. */
  let cuentas: Record<string, string>
  beforeEach(() => {
    cuentas = { 'oo-A': 'CANCELLED', 'oo-B': 'CANCELLED' }
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    // lockExistingOrderForPayment: devuelve la orden que se pidió (su primer valor interpolado).
    ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (_sql: unknown, orderId: string) => [{ id: orderId }])
    prismaMock.onlineOrder.updateMany.mockImplementation((async (a: any) => ({
      count: !a.where.order || a.where.order.status.in.includes(cuentas[a.where.id]) ? 1 : 0,
    })) as any)
  })

  it('lee con tope (cliente raíz) y cierra cada candidato en SU transacción, con el candado antes de un CAS que vuelve a exigir la cuenta cancelada', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([fila('A'), fila('B', 'DELETED')] as any)

    const won = await cerrarCanceladasReleyendo({ venueId: 'v1' }, () => NOW)

    expect(prismaMock.onlineOrder.findMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', status: { in: OPEN }, order: CANCELADA },
      select: { id: true, orderId: true, venueId: true, order: { select: { orderNumber: true, status: true } } },
      orderBy: { id: 'asc' },
      take: 100,
    })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    const data = { status: 'CANCELLED_BY_STAFF', cancelledAt: NOW, cancelledBy: CANCELLED_ELSEWHERE }
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'oo-A', status: { in: OPEN }, order: CANCELADA },
      data,
    })
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.onlineOrder.updateMany.mock.invocationCallOrder[0])
    expect(won.map(w => [w.id, w.orderStatus])).toEqual([
      ['oo-A', 'CANCELLED'],
      ['oo-B', 'DELETED'],
    ])
    expect(notifyOrderEvent).not.toHaveBeenCalled() // el aviso es de quien llama, después
  })

  it('carrera r3/r4: la bandeja leyó la cuenta CANCELLED; antes de su CAS el dinero tardío la reabrió y pasó el folio a ACCEPTED ⇒ no lo cancela', async () => {
    prismaMock.onlineOrder.findMany.mockImplementation((async () => {
      const leidas = [fila('A')]
      cuentas['oo-A'] = 'COMPLETED' // el cobro capturado gana el candado primero y reabre la cuenta
      return leidas
    }) as any)

    const won = await cerrarCanceladasReleyendo({ venueId: 'v1' }, () => NOW)

    expect(won).toEqual([])
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenCalledTimes(1)
  })

  it('una orden que ya no es del negocio (el candado no la encuentra) no se toca; una fila que truena se registra y la pasada sigue', async () => {
    prismaMock.onlineOrder.findMany.mockResolvedValue([fila('A'), fila('B'), fila('C')] as any)
    cuentas['oo-C'] = 'CANCELLED'
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([])
    ;(prismaMock.$transaction as jest.Mock)
      .mockImplementationOnce(async (fn: any) => fn(prismaMock))
      .mockRejectedValueOnce(new Error('lock timeout'))
    const error = jest.spyOn(logger, 'error')

    const won = await cerrarCanceladasReleyendo({}, () => NOW)

    expect(won.map(w => w.id)).toEqual(['oo-C'])
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ onlineOrderId: 'oo-B' }))
    expect((prismaMock.onlineOrder.findMany.mock.calls[0][0] as any).where).not.toHaveProperty('venueId')
  })
})

describe('R52 · cerrarCanceladasReleyendo lee el reloj al escribir', () => {
  it('`cancelledAt` es la hora leída DESPUÉS del candado de la orden, no la hora con la que empezó la pasada o la petición', async () => {
    const PASADA = new Date('2026-11-06T09:59:50.000Z')
    const BAJO_CANDADO = new Date('2026-11-06T10:00:05.000Z')
    let ahora = PASADA
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (_sql: unknown, orderId: string) => {
      ahora = BAJO_CANDADO // la espera del candado
      return [{ id: orderId }]
    })
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.onlineOrder.findMany.mockResolvedValue([fila('A')] as any)

    const won = await cerrarCanceladasReleyendo({}, () => ahora)

    expect(won.map(w => w.id)).toEqual(['oo-A'])
    expect((prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any).data).toEqual({
      status: 'CANCELLED_BY_STAFF',
      cancelledAt: BAJO_CANDADO,
      cancelledBy: CANCELLED_ELSEWHERE,
    })
  })
})
