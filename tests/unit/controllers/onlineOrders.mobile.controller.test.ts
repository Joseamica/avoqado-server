// H3: la resolución de permisos es la REAL de `checkPermission` (`resolveUserRoleForVenue` + `evaluateRolePermission`) sobre el
// Prisma mockeado global: rol en `staffVenue`, permisos personalizados en `venueRolePermission`.
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/online-ordering/inbox.service', () => ({ __esModule: true, listInbox: jest.fn() }))
jest.mock('@/services/online-ordering/presence.service', () => ({
  __esModule: true,
  touchInboxPoll: jest.fn(),
  getAcceptingStatus: jest.fn(),
}))
jest.mock('@/services/online-ordering/settings.service', () => ({ __esModule: true, pauseOnlineOrdering: jest.fn() }))
jest.mock('@/services/online-ordering/transitions.service', () => ({
  __esModule: true,
  acceptOnlineOrder: jest.fn(),
  rejectOnlineOrder: jest.fn(),
  markOnlineOrderReady: jest.fn(),
  markOnlineOrderDelivered: jest.fn(),
  cancelOnlineOrderByStaff: jest.fn(),
}))
jest.mock('@/services/online-ordering/printClaim.service', () => ({
  __esModule: true,
  claimOnlineOrderPrint: jest.fn(),
  confirmOnlineOrderPrinted: jest.fn(),
}))

import { listInbox } from '@/services/online-ordering/inbox.service'
import { getAcceptingStatus, touchInboxPoll } from '@/services/online-ordering/presence.service'
import { pauseOnlineOrdering } from '@/services/online-ordering/settings.service'
import {
  acceptOnlineOrder,
  cancelOnlineOrderByStaff,
  markOnlineOrderDelivered,
  markOnlineOrderReady,
  rejectOnlineOrder,
} from '@/services/online-ordering/transitions.service'
import { claimOnlineOrderPrint } from '@/services/online-ordering/printClaim.service'
import * as ctrl from '@/controllers/mobile/onlineOrders.mobile.controller'

const LISTA = { serverTime: 'x', counts: { pending: 0, active: 0, done: 0 }, orders: [], truncated: false }
/** La fila de `StaffVenue` que `resolveUserRoleForVenue` lee para el rol en este negocio. */
const enElNegocio = (role: string) => ({ role, active: true, permissionSetId: null, permissionSet: null })

function mock(over: { query?: object; body?: object; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'x-device-id': 'dev1', ...(over.headers ?? {}) }
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  const req: any = {
    params: { venueId: 'v1', orderId: 'ord1' },
    query: over.query ?? {},
    body: over.body ?? {},
    authContext: { userId: 'staff1' },
    header: (n: string) => headers[n.toLowerCase()],
  }
  return { req, res, next: jest.fn() }
}

beforeEach(() => {
  ;(listInbox as jest.Mock).mockResolvedValue(LISTA)
  ;(touchInboxPoll as jest.Mock).mockResolvedValue(true)
  ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ status: 'OPEN', reason: null, config: {} })
  // Por defecto: una cajera activa (CASHIER tiene `orders:update`) sin permisos personalizados del negocio.
  prismaMock.staff.findUnique.mockResolvedValue({ active: true } as any)
  prismaMock.staffVenue.findUnique.mockResolvedValue(enElNegocio('CASHIER') as any)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
})

describe('onlineOrders.mobile.controller', () => {
  it('la bandeja abierta (x-online-orders-tray: 1) late DESPUÉS de listar y devuelve el estado de la tienda (R13)', async () => {
    const { req, res, next } = mock({ query: { status: 'pending' }, headers: { 'x-online-orders-tray': '1' } })
    await ctrl.inbox(req, res, next)
    expect(listInbox).toHaveBeenCalledWith({ venueId: 'v1', filter: 'pending' })
    expect(touchInboxPoll).toHaveBeenCalledWith('v1')
    expect((listInbox as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((touchInboxPoll as jest.Mock).mock.invocationCallOrder[0])
    expect((touchInboxPoll as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (getAcceptingStatus as jest.Mock).mock.invocationCallOrder[0],
    )
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ...LISTA, store: { status: 'OPEN', reason: null } } })
  })

  it('sin la cabecera de bandeja (otra vista del panel, un script) no hay latido', async () => {
    const { req, res, next } = mock()
    await ctrl.inbox(req, res, next)
    expect(touchInboxPoll).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalled()
  })

  it('H3: un VIEWER (orders:read sin orders:update) con la cabecera mira la bandeja pero NO mantiene abierta la tienda', async () => {
    prismaMock.staffVenue.findUnique.mockResolvedValue(enElNegocio('VIEWER') as any)
    const { req, res, next } = mock({ headers: { 'x-online-orders-tray': '1' } })
    await ctrl.inbox(req, res, next)
    expect(touchInboxPoll).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ...LISTA, store: { status: 'OPEN', reason: null } } })
  })

  it('H3: cuentan los permisos personalizados del negocio: un VIEWER al que el negocio le dio orders:update sí late', async () => {
    prismaMock.staffVenue.findUnique.mockResolvedValue(enElNegocio('VIEWER') as any)
    prismaMock.venueRolePermission.findUnique.mockResolvedValue({ permissions: ['orders:update'], deniedPermissions: [] } as any)
    const { req, res, next } = mock({ headers: { 'x-online-orders-tray': '1' } })
    await ctrl.inbox(req, res, next)
    expect(touchInboxPoll).toHaveBeenCalledWith('v1')
  })

  it('soporte suplantando (aunque el suplantado sea cajera) mira la bandeja pero NO mantiene abierta la tienda: no puede contestar', async () => {
    const { req, res, next } = mock({ headers: { 'x-online-orders-tray': '1' } })
    req.authContext.isImpersonating = true
    await ctrl.inbox(req, res, next)
    expect(touchInboxPoll).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ...LISTA, store: { status: 'OPEN', reason: null } } })
  })

  it('si la lista falla no hay latido: una bandeja rota no mantiene abierta la tienda', async () => {
    ;(listInbox as jest.Mock).mockRejectedValue(new Error('db'))
    const { req, res, next } = mock({ headers: { 'x-online-orders-tray': '1' } })
    await ctrl.inbox(req, res, next)
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(touchInboxPoll).not.toHaveBeenCalled()
  })

  it('un fallo al escribir el latido no tumba la lista', async () => {
    ;(touchInboxPoll as jest.Mock).mockRejectedValue(new Error('db'))
    const { req, res, next } = mock({ headers: { 'x-online-orders-tray': '1' } })
    await ctrl.inbox(req, res, next)
    expect(res.json).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('aceptar mapea OK a 200 y STALE a 409 con el estado vigente', async () => {
    ;(acceptOnlineOrder as jest.Mock).mockResolvedValueOnce({ outcome: 'OK', status: 'ACCEPTED', estimatedReadyAt: 'x' })
    const a = mock({ body: { estimatedMinutes: 20 } })
    await ctrl.accept(a.req, a.res, a.next)
    expect(acceptOnlineOrder).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1', staffId: 'staff1', estimatedMinutes: 20 })
    expect(a.res.json).toHaveBeenCalledWith({ success: true, data: { status: 'ACCEPTED', estimatedReadyAt: 'x' } })
    ;(acceptOnlineOrder as jest.Mock).mockResolvedValueOnce({ outcome: 'STALE', status: 'EXPIRED' })
    const b = mock()
    await ctrl.accept(b.req, b.res, b.next)
    expect(b.res.status).toHaveBeenCalledWith(409)
    expect(b.res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ORDER_STATE_CHANGED', status: 'EXPIRED' }))
  })

  it('R1: ninguna transición recibe `now` del controlador (el reloj se toma DESPUÉS del candado de la orden)', async () => {
    for (const fn of [acceptOnlineOrder, rejectOnlineOrder, markOnlineOrderReady, markOnlineOrderDelivered, cancelOnlineOrderByStaff]) {
      ;(fn as jest.Mock).mockResolvedValue({ outcome: 'OK', status: 'ACCEPTED' })
    }
    for (const handler of [ctrl.accept, ctrl.reject, ctrl.ready, ctrl.delivered, ctrl.cancel]) {
      const m = mock({ body: { estimatedMinutes: 20, reason: 'TOO_BUSY' } })
      await handler(m.req, m.res, m.next)
    }
    for (const fn of [acceptOnlineOrder, rejectOnlineOrder, markOnlineOrderReady, markOnlineOrderDelivered, cancelOnlineOrderByStaff]) {
      expect(fn).toHaveBeenCalledTimes(1)
      expect((fn as jest.Mock).mock.calls[0][0]).not.toHaveProperty('now')
    }
  })

  it('entregar sin cobro es 409 PAYMENT_REQUIRED', async () => {
    ;(markOnlineOrderDelivered as jest.Mock).mockResolvedValue({ outcome: 'PAYMENT_REQUIRED' })
    const { req, res, next } = mock()
    await ctrl.delivered(req, res, next)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PAYMENT_REQUIRED' }))
  })

  it('cancelar una cuenta con dinero es 409 ORDER_HAS_PAYMENTS', async () => {
    ;(cancelOnlineOrderByStaff as jest.Mock).mockResolvedValue({ outcome: 'HAS_PAYMENTS' })
    const { req, res, next } = mock()
    await ctrl.cancel(req, res, next)
    expect(cancelOnlineOrderByStaff).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1', staffId: 'staff1' })
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: 'ORDER_HAS_PAYMENTS',
      error:
        'El pedido ya tiene un cobro, o uno en curso en la terminal. Espera a que termine; si ya se cobró, usa el reembolso de la cuenta.',
    })
  })

  it('sólo NOT_FOUND es 404; un resultado desconocido es un error del servidor, nunca «No encontramos ese pedido»', async () => {
    ;(markOnlineOrderReady as jest.Mock).mockResolvedValueOnce({ outcome: 'NOT_FOUND' })
    const a = mock()
    await ctrl.ready(a.req, a.res, a.next)
    expect(a.res.status).toHaveBeenCalledWith(404)
    expect(a.res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ORDER_NOT_FOUND' }))
    ;(markOnlineOrderReady as jest.Mock).mockResolvedValueOnce({ outcome: 'ALGO_NUEVO' })
    const b = mock()
    await ctrl.ready(b.req, b.res, b.next)
    expect(b.next).toHaveBeenCalledWith(expect.any(Error))
    expect(b.res.status).not.toHaveBeenCalled()
    expect(b.res.json).not.toHaveBeenCalled()
  })

  it('rechazar con una nota de puros espacios guarda `null`, no una cadena vacía', async () => {
    ;(rejectOnlineOrder as jest.Mock).mockResolvedValueOnce({ outcome: 'OK', status: 'REJECTED' })
    const { req, res, next } = mock({ body: { reason: 'OTHER', note: '   ' } })
    await ctrl.reject(req, res, next)
    expect(rejectOnlineOrder).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1', staffId: 'staff1', reason: 'OTHER', note: null })
  })

  it('el reclamo de impresión exige x-device-id', async () => {
    const noDevice = mock()
    noDevice.req.header = () => undefined
    await ctrl.printClaim(noDevice.req, noDevice.res, noDevice.next)
    expect(noDevice.res.status).toHaveBeenCalledWith(400)
    ;(claimOnlineOrderPrint as jest.Mock).mockResolvedValue({ claimed: true })
    const ok = mock()
    await ctrl.printClaim(ok.req, ok.res, ok.next)
    expect(claimOnlineOrderPrint).toHaveBeenCalledWith('v1', 'ord1', 'dev1')
    expect(ok.res.json).toHaveBeenCalledWith({ success: true, data: { claimed: true } })
  })

  it('el reclamo usa el `:orderId` de la ruta (Order.id, el `orderId` de la bandeja) como llave `OnlineOrder.orderId`, nunca el id del pedido en línea', async () => {
    const real = jest.requireActual('@/services/online-ordering/printClaim.service')
    ;(claimOnlineOrderPrint as jest.Mock).mockImplementationOnce(real.claimOnlineOrderPrint)
    prismaMock.onlineOrder.updateMany.mockResolvedValueOnce({ count: 1 })
    const { req, res, next } = mock()
    await ctrl.printClaim(req, res, next)
    const where = (prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any).where
    expect(where).toMatchObject({ orderId: 'ord1', venueId: 'v1' })
    expect(where).not.toHaveProperty('id')
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { claimed: true } })
  })

  it('pausar desde el piso escribe la pausa con quien la pidió (R12)', async () => {
    ;(pauseOnlineOrdering as jest.Mock).mockResolvedValue({ pausedUntil: '2026-10-14T19:00:00.000Z' })
    const { req, res, next } = mock({ body: { minutes: 30 } })
    await ctrl.pause(req, res, next)
    expect(pauseOnlineOrdering).toHaveBeenCalledWith('v1', 30, 'staff1')
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { pausedUntil: '2026-10-14T19:00:00.000Z' } })
  })
})
