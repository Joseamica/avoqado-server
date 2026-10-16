// tests/unit/services/online-ordering/transitions.service.test.ts
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { BadRequestError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  __esModule: true,
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({ __esModule: true, debeMarcarCocina: jest.fn() }))
jest.mock('@/services/shared/orderCancelGuard', () => ({ __esModule: true, findLiveTerminalCharge: jest.fn() }))
jest.mock('@/services/mobile/order.mobile.service', () => ({ __esModule: true, cancelOrder: jest.fn() }))
jest.mock('@/services/online-ordering/notifications.service', () => ({
  __esModule: true,
  notifyOrderEvent: jest.fn(async () => undefined),
}))
jest.mock('@/services/online-ordering/settings.service', () => ({ __esModule: true, getSettings: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn() },
}))

import { armarComandasTrasCommit } from '@/services/kds/kitchenTicketAuthoring.service'
import { debeMarcarCocina } from '@/services/kds/kitchenDisplayStations'
import { findLiveTerminalCharge } from '@/services/shared/orderCancelGuard'
import { cancelOrder } from '@/services/mobile/order.mobile.service'
import { notifyOrderEvent } from '@/services/online-ordering/notifications.service'
import { getSettings } from '@/services/online-ordering/settings.service'
import {
  acceptOnlineOrder,
  cancelOnlineOrderByCustomer,
  cancelOnlineOrderByStaff,
  expireOnlineOrder,
  markOnlineOrderDelivered,
  markOnlineOrderReady,
  rejectOnlineOrder,
} from '@/services/online-ordering/transitions.service'

const D = (v: string) => new Prisma.Decimal(v)
const NOW = new Date('2026-10-14T18:30:00.000Z')
const base = { venueId: 'v1', orderId: 'ord1', staffId: 'staff1', now: NOW }
const OPEN = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY']
const PAID = { status: 'COMPLETED', paymentStatus: 'PAID', paidAmount: D('206.00') }

const row = (o: { status?: string; order?: Record<string, unknown>; acceptDeadlineAt?: Date } = {}) => ({
  id: 'oo1',
  status: o.status ?? 'PENDING_ACCEPTANCE',
  paymentMode: 'PAY_AT_PICKUP',
  acceptDeadlineAt: o.acceptDeadlineAt ?? new Date(NOW.getTime() + 300_000),
  order: { orderNumber: 'WABCD', status: 'PENDING', paymentStatus: 'PENDING', paidAmount: D('0'), ...(o.order ?? {}) },
})

beforeEach(() => {
  ;(getSettings as jest.Mock).mockResolvedValue({ defaultPrepMinutes: 15 })
  ;(debeMarcarCocina as jest.Mock).mockResolvedValue(true)
  ;(findLiveTerminalCharge as jest.Mock).mockResolvedValue(null)
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([{ id: 'ord1' }]) // lockExistingOrderForPayment
  prismaMock.onlineOrder.findFirst.mockResolvedValue(row() as any)
  prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
  ;(cancelOrder as jest.Mock).mockImplementation(async (_v: string, orderId: string, _r: unknown, _s: unknown, dentroDeLaTx: any) => {
    await dentroDeLaTx(prismaMock, { orderId })
  })
})

describe('acceptOnlineOrder', () => {
  it('CAS desde «por aceptar» con la hora vigente; confirma la Order sólo si sigue PENDING; arma comanda, avisa y audita', async () => {
    const r = await acceptOnlineOrder({ ...base, estimatedMinutes: 20 })

    const cas = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(cas.where).toEqual({ id: 'oo1', status: { in: ['PENDING_ACCEPTANCE'] }, acceptDeadlineAt: { gt: NOW } })
    expect(cas.data).toEqual({ status: 'ACCEPTED', acceptedAt: NOW, estimatedReadyAt: new Date(NOW.getTime() + 20 * 60_000) })

    const orderUpdate = prismaMock.order.updateMany.mock.calls[0][0] as any
    expect(orderUpdate.where).toEqual({ id: 'ord1', venueId: 'v1', status: { in: ['PENDING'] } })
    expect(orderUpdate.data).toEqual({ status: 'CONFIRMED', kitchenPendingAt: NOW })

    expect(r).toEqual({ outcome: 'OK', status: 'ACCEPTED', estimatedReadyAt: new Date(NOW.getTime() + 20 * 60_000).toISOString() })
    expect(debeMarcarCocina).toHaveBeenCalledWith('v1', { orderId: 'ord1' })
    expect(armarComandasTrasCommit).toHaveBeenCalledWith('v1', 'ord1', 'ROUND')
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord1', 'ACCEPTED')
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_ACCEPTED', staffId: 'staff1' }))
  })

  it('sin minutos usa el tiempo de preparación del negocio', async () => {
    await acceptOnlineOrder(base)
    const cas = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(cas.data.estimatedReadyAt).toEqual(new Date(NOW.getTime() + 15 * 60_000))
  })

  it('sin comanda que marcar no deja marca ni arma comanda (igual que el cobro)', async () => {
    ;(debeMarcarCocina as jest.Mock).mockResolvedValue(false)
    await acceptOnlineOrder(base)
    expect((prismaMock.order.updateMany.mock.calls[0][0] as any).data).toEqual({ status: 'CONFIRMED' })
    expect(armarComandasTrasCommit).not.toHaveBeenCalled()
  })

  it('el reloj se toma DESPUÉS del candado: esperar la orden no estira la hora límite (R1)', async () => {
    const antes = new Date('2026-10-14T18:39:59.000Z')
    const despues = new Date('2026-10-14T18:40:01.000Z')
    jest.useFakeTimers({ now: antes, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] })
    try {
      ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async () => {
        jest.setSystemTime(despues) // la espera del candado cruzó la hora límite (18:40:00)
        return [{ id: 'ord1' }]
      })
      prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ acceptDeadlineAt: new Date('2026-10-14T18:40:00.000Z') }) as any)
      await acceptOnlineOrder({ venueId: 'v1', orderId: 'ord1', staffId: 'staff1' }) // sin `now`: reloj real
      const cas = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
      expect(cas.where.acceptDeadlineAt).toEqual({ gt: despues })
      expect(cas.data.acceptedAt).toEqual(despues)
    } finally {
      jest.useRealTimers()
    }
  })

  it('si aceptar pierde por la hora, se vence ahí mismo y responde EXPIRED (R1)', async () => {
    const vencida = new Date(NOW.getTime() - 1_000)
    prismaMock.onlineOrder.findFirst
      .mockResolvedValueOnce(row({ acceptDeadlineAt: vencida }) as any) // aceptar: lectura bajo el candado
      .mockResolvedValueOnce({ status: 'PENDING_ACCEPTANCE', acceptDeadlineAt: vencida } as any) // relectura tras perder el CAS
      .mockResolvedValueOnce(row({ acceptDeadlineAt: vencida }) as any) // vencer: lectura bajo el candado
    prismaMock.onlineOrder.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })

    await expect(acceptOnlineOrder(base)).resolves.toEqual({ outcome: 'STALE', status: 'EXPIRED' })
    expect((prismaMock.onlineOrder.updateMany.mock.calls[1][0] as any).data).toMatchObject({ status: 'EXPIRED', expiredAt: NOW })
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord1', 'EXPIRED')
    expect(notifyOrderEvent).not.toHaveBeenCalledWith('ord1', 'ACCEPTED')
  })

  it('una Order cancelada por otra vía no se revive: el pedido se sincroniza a CANCELLED_BY_STAFF (R2)', async () => {
    prismaMock.onlineOrder.findFirst
      .mockResolvedValueOnce(row({ order: { status: 'CANCELLED' } }) as any)
      .mockResolvedValueOnce({ status: 'CANCELLED_BY_STAFF' } as any)

    await expect(acceptOnlineOrder(base)).resolves.toEqual({ outcome: 'STALE', status: 'CANCELLED_BY_STAFF' })
    const sync = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(sync.where).toMatchObject({ venueId: 'v1', orderId: 'ord1', order: { status: { in: ['CANCELLED', 'DELETED'] } } })
    expect(sync.data).toMatchObject({ status: 'CANCELLED_BY_STAFF', cancelledBy: 'ORDER_CANCELLED_ELSEWHERE' })
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
    expect(notifyOrderEvent).not.toHaveBeenCalled()
    expect(armarComandasTrasCommit).not.toHaveBeenCalled()
  })

  it('un pedido ya cobrado se acepta aunque haya pasado la hora, sin reabrir la Order ni armar otra comanda (R1)', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ order: PAID, acceptDeadlineAt: new Date(NOW.getTime() - 60_000) }) as any)
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 }) // la Order COMPLETED no está en `PENDING`

    await expect(acceptOnlineOrder(base)).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })
    const cas = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(cas.where.acceptDeadlineAt).toBeUndefined()
    expect((prismaMock.order.updateMany.mock.calls[0][0] as any).where.status).toEqual({ in: ['PENDING'] })
    expect(armarComandasTrasCommit).not.toHaveBeenCalled()
  })

  it('si otro ganó (count 0) responde STALE con el estado vigente y NO toca la Order ni avisa', async () => {
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.onlineOrder.findFirst
      .mockResolvedValueOnce(row() as any)
      .mockResolvedValueOnce({ status: 'ACCEPTED', acceptDeadlineAt: new Date(NOW.getTime() + 300_000) } as any)
    await expect(acceptOnlineOrder(base)).resolves.toEqual({ outcome: 'STALE', status: 'ACCEPTED' })
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
    expect(notifyOrderEvent).not.toHaveBeenCalled()
  })

  it('una orden de otro negocio o inexistente es NOT_FOUND (el candado no la encuentra)', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
    await expect(acceptOnlineOrder(base)).resolves.toEqual({ outcome: 'NOT_FOUND' })
  })
})

describe('rejectOnlineOrder', () => {
  it('REJECTED con motivo; la Order abierta se cancela; avisa y audita', async () => {
    const r = await rejectOnlineOrder({ ...base, reason: 'OUT_OF_ITEMS', note: 'sin pollo' })
    const cas = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(cas.data).toEqual({ status: 'REJECTED', rejectReason: 'OUT_OF_ITEMS', rejectNote: 'sin pollo', rejectedAt: NOW })
    const orderUpdate = prismaMock.order.updateMany.mock.calls[0][0] as any
    expect(orderUpdate.where.status).toEqual({ in: OPEN })
    expect(orderUpdate.data).toEqual({ status: 'CANCELLED' })
    expect(findLiveTerminalCharge).toHaveBeenCalledWith(prismaMock, { venueId: 'v1', orderId: 'ord1' })
    expect(r).toEqual({ outcome: 'OK', status: 'REJECTED' })
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord1', 'REJECTED')
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_REJECTED' }))
  })

  it('con dinero en la cuenta no toca nada: HAS_PAYMENTS (R1)', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ order: PAID }) as any)
    await expect(rejectOnlineOrder({ ...base, reason: 'TOO_BUSY' })).resolves.toEqual({ outcome: 'HAS_PAYMENTS' })
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
  })

  it('con un cobro de terminal en curso tampoco: HAS_PAYMENTS (§C.6)', async () => {
    ;(findLiveTerminalCharge as jest.Mock).mockResolvedValue({ requestId: 'tpr1' })
    await expect(rejectOnlineOrder({ ...base, reason: 'TOO_BUSY' })).resolves.toEqual({ outcome: 'HAS_PAYMENTS' })
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
  })
})

describe('expireOnlineOrder', () => {
  it('sólo vence si la hora ya pasó y se audita con actor de sistema', async () => {
    const r = await expireOnlineOrder({ venueId: 'v1', orderId: 'ord1', now: NOW })
    const cas = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(cas.where).toEqual({ id: 'oo1', status: { in: ['PENDING_ACCEPTANCE'] }, acceptDeadlineAt: { lte: NOW } })
    expect(cas.data).toEqual({ status: 'EXPIRED', expiredAt: NOW })
    expect(r).toEqual({ outcome: 'OK', status: 'EXPIRED' })
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord1', 'EXPIRED')
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_EXPIRED', staffId: null }))
  })

  it('si el restaurante aceptó justo antes (count 0) es STALE y no avisa', async () => {
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.onlineOrder.findFirst
      .mockResolvedValueOnce(row() as any)
      .mockResolvedValueOnce({ status: 'ACCEPTED', acceptDeadlineAt: NOW } as any)
    await expect(expireOnlineOrder({ venueId: 'v1', orderId: 'ord1', now: NOW })).resolves.toEqual({ outcome: 'STALE', status: 'ACCEPTED' })
    expect(notifyOrderEvent).not.toHaveBeenCalled()
  })

  it('una cuenta ya cobrada no se vence: HAS_PAYMENTS (el job lo cuenta como noop)', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ order: PAID }) as any)
    await expect(expireOnlineOrder({ venueId: 'v1', orderId: 'ord1', now: NOW })).resolves.toEqual({ outcome: 'HAS_PAYMENTS' })
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
  })
})

describe('markOnlineOrderReady', () => {
  it('ACCEPTED → READY; la Order sólo desde CONFIRMED/PREPARING; avisa al comensal', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ status: 'ACCEPTED', order: { status: 'CONFIRMED' } }) as any)
    const r = await markOnlineOrderReady(base)
    const cas = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(cas.where.status).toEqual({ in: ['ACCEPTED'] })
    expect(cas.data).toEqual({ status: 'READY', readyAt: NOW })
    const orderUpdate = prismaMock.order.updateMany.mock.calls[0][0] as any
    expect(orderUpdate.where.status).toEqual({ in: ['CONFIRMED', 'PREPARING'] })
    expect(orderUpdate.data).toEqual({ status: 'READY' })
    expect(r).toEqual({ outcome: 'OK', status: 'READY' })
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord1', 'READY')
  })

  it('una Order ya cobrada (COMPLETED) no regresa a abierta: sólo el pedido pasa a READY (R1)', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ status: 'ACCEPTED', order: PAID }) as any)
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 })
    await expect(markOnlineOrderReady(base)).resolves.toEqual({ outcome: 'OK', status: 'READY' })
    expect((prismaMock.order.updateMany.mock.calls[0][0] as any).where.status).toEqual({ in: ['CONFIRMED', 'PREPARING'] })
  })
})

describe('markOnlineOrderDelivered', () => {
  it('pagar al recoger exige la orden PAGADA, leída bajo el candado', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ status: 'READY', order: { status: 'READY' } }) as any)
    await expect(markOnlineOrderDelivered(base)).resolves.toEqual({ outcome: 'PAYMENT_REQUIRED' })
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
  })

  it('con la orden pagada pasa a COMPLETED desde READY o ACCEPTED; la Order se completa sólo si sigue abierta', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ status: 'READY', order: PAID }) as any)
    const r = await markOnlineOrderDelivered(base)
    const cas = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(cas.where.status).toEqual({ in: ['READY', 'ACCEPTED'] })
    expect(cas.data).toEqual({ status: 'COMPLETED', completedAt: NOW })
    const orderUpdate = prismaMock.order.updateMany.mock.calls[0][0] as any
    expect(orderUpdate.where.status).toEqual({ in: OPEN })
    expect(orderUpdate.data).toEqual({ status: 'COMPLETED', completedAt: NOW })
    expect(r).toEqual({ outcome: 'OK', status: 'COMPLETED' })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_COLLECTED' }))
  })
})

describe('cancelOnlineOrderByCustomer', () => {
  it('sólo mientras está por aceptar; busca por token y lo valida DENTRO del venue de la URL', async () => {
    prismaMock.onlineOrder.findUnique.mockResolvedValue({ orderId: 'ord1', venueId: 'v1' } as any)
    const r = await cancelOnlineOrderByCustomer({ venueId: 'v1', trackingToken: 'T'.repeat(32), now: NOW })
    expect(prismaMock.onlineOrder.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { trackingToken: 'T'.repeat(32) } }))
    const cas = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(cas.where.status).toEqual({ in: ['PENDING_ACCEPTANCE'] })
    expect(cas.data).toEqual({ status: 'CANCELLED_BY_CUSTOMER', cancelledAt: NOW, cancelledBy: 'CUSTOMER' })
    expect(r).toEqual({ outcome: 'OK', status: 'CANCELLED_BY_CUSTOMER' })
    // H9: el comensal recibe la confirmación de su cancelación, como cuando cancela el personal
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord1', 'CANCELLED')
  })

  it('un token de otro negocio es NOT_FOUND', async () => {
    prismaMock.onlineOrder.findUnique.mockResolvedValue({ orderId: 'ord1', venueId: 'OTRO' } as any)
    await expect(cancelOnlineOrderByCustomer({ venueId: 'v1', trackingToken: 'T'.repeat(32) })).resolves.toEqual({ outcome: 'NOT_FOUND' })
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
  })

  it('con dinero en la cuenta el comensal ya no cancela: HAS_PAYMENTS (R1)', async () => {
    prismaMock.onlineOrder.findUnique.mockResolvedValue({ orderId: 'ord1', venueId: 'v1' } as any)
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ order: PAID }) as any)
    await expect(cancelOnlineOrderByCustomer({ venueId: 'v1', trackingToken: 'T'.repeat(32), now: NOW })).resolves.toEqual({
      outcome: 'HAS_PAYMENTS',
    })
    expect(notifyOrderEvent).not.toHaveBeenCalled()
  })
})

describe('cancelOnlineOrderByStaff (R1: reutiliza la cancelación existente)', () => {
  beforeEach(() => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue({ id: 'oo1', status: 'ACCEPTED', order: { orderNumber: 'WABCD' } } as any)
  })

  it('llama cancelOrder (candados, comandas y guardas existentes) y hace el CAS del pedido en SU transacción', async () => {
    const r = await cancelOnlineOrderByStaff(base)
    expect(cancelOrder).toHaveBeenCalledWith('v1', 'ord1', undefined, 'staff1', expect.any(Function))
    const cas = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(cas.where).toEqual({ id: 'oo1', status: { in: ['ACCEPTED', 'READY'] } })
    expect(cas.data).toEqual({ status: 'CANCELLED_BY_STAFF', cancelledAt: NOW, cancelledBy: 'staff1' })
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled() // la Order la escribe la cancelación existente
    expect(r).toEqual({ outcome: 'OK', status: 'CANCELLED_BY_STAFF' })
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord1', 'CANCELLED')
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_CANCELLED_BY_STAFF' }))
  })

  it('si la guarda existente rechaza por dinero (400), responde HAS_PAYMENTS', async () => {
    ;(cancelOrder as jest.Mock).mockRejectedValue(new BadRequestError('Cannot cancel a paid order'))
    await expect(cancelOnlineOrderByStaff(base)).resolves.toEqual({ outcome: 'HAS_PAYMENTS' })
    expect(notifyOrderEvent).not.toHaveBeenCalled()
  })

  it('un pedido que no está aceptado ni listo es STALE sin tocar la cuenta', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue({ id: 'oo1', status: 'PENDING_ACCEPTANCE', order: { orderNumber: 'WABCD' } } as any)
    await expect(cancelOnlineOrderByStaff(base)).resolves.toEqual({ outcome: 'STALE', status: 'PENDING_ACCEPTANCE' })
    expect(cancelOrder).not.toHaveBeenCalled()
  })

  // H6: con mocks no hay transacción que revertir. Aquí sólo se prueba que el gancho LANZA (es lo que hace que la transacción
  // real de `cancelOrder` se deshaga); que la `Order` NO quede cancelada lo prueba Postgres en la tarea 15.
  it('si el CAS dentro de la cancelación pierde, el gancho LANZA y responde el estado vigente sin avisar', async () => {
    let lanzoElGancho: unknown = null
    ;(cancelOrder as jest.Mock).mockImplementation(async (_v: string, orderId: string, _r: unknown, _s: unknown, dentroDeLaTx: any) => {
      try {
        await dentroDeLaTx(prismaMock, { orderId })
      } catch (error) {
        lanzoElGancho = error
        throw error
      }
    })
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.onlineOrder.findFirst
      .mockResolvedValueOnce({ id: 'oo1', status: 'ACCEPTED', order: { orderNumber: 'WABCD' } } as any)
      .mockResolvedValueOnce({ status: 'COMPLETED' } as any)
    await expect(cancelOnlineOrderByStaff(base)).resolves.toEqual({ outcome: 'STALE', status: 'COMPLETED' })
    expect(lanzoElGancho).toBeInstanceOf(Error)
    expect(notifyOrderEvent).not.toHaveBeenCalled()
  })
})
