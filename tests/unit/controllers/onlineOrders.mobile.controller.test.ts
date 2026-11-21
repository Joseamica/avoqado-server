// H3: la resolución de permisos es la REAL de `checkPermission` (`resolveUserRoleForVenue` + `evaluateRolePermission`) sobre el
// Prisma mockeado global: rol en `staffVenue`, permisos personalizados en `venueRolePermission`.
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/online-ordering/inbox.service', () => ({ __esModule: true, listInbox: jest.fn() }))
jest.mock('@/services/online-ordering/presence.service', () => ({
  __esModule: true,
  touchInboxPoll: jest.fn(),
  touchToPayPoll: jest.fn(),
  getAcceptingStatus: jest.fn(),
  // Ronda 1: el armado del estado es el REAL (uno solo para panel, bandeja y MCP).
  storeView: jest.requireActual('@/services/online-ordering/presence.service').storeView,
}))
jest.mock('@/services/online-ordering/folios.service', () => ({ __esModule: true, listFolios: jest.fn() }))
jest.mock('@/services/online-ordering/cardAlertPresence', () => ({
  __esModule: true,
  CARD_ALERT_HEADER: 'x-online-orders-card-alert',
  touchCardAlertPoll: jest.fn(),
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
import { listFolios } from '@/services/online-ordering/folios.service'
import { getAcceptingStatus, touchInboxPoll, touchToPayPoll } from '@/services/online-ordering/presence.service'
import { pauseOnlineOrdering } from '@/services/online-ordering/settings.service'
import {
  acceptOnlineOrder,
  cancelOnlineOrderByStaff,
  markOnlineOrderDelivered,
  markOnlineOrderReady,
  rejectOnlineOrder,
} from '@/services/online-ordering/transitions.service'
import { claimOnlineOrderPrint } from '@/services/online-ordering/printClaim.service'
import { touchCardAlertPoll } from '@/services/online-ordering/cardAlertPresence'
import * as ctrl from '@/controllers/mobile/onlineOrders.mobile.controller'
import mobileRouter from '@/routes/mobile/onlineOrders.mobile.routes'

const LISTA = { serverTime: 'x', counts: { pending: 0, active: 0, done: 0 }, orders: [], truncated: false }
const FOLIOS = { serverTime: 'x', counts: { toPay: 0, toDeliver: 0 }, toPay: [], toDeliver: [] }
/** 1b: el estado de la tienda en la bandeja trae también las dos pausas (la del piso con su hora, y la del gerente). */
const TIENDA_ABIERTA = { status: 'OPEN', reason: null, pausedUntil: null, manualPause: false }
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
  ;(touchToPayPoll as jest.Mock).mockResolvedValue(true)
  ;(touchCardAlertPoll as jest.Mock).mockResolvedValue(true)
  ;(listFolios as jest.Mock).mockResolvedValue(FOLIOS)
  ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ status: 'OPEN', reason: null, config: { pausedUntil: null, manualPause: false } })
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
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ...LISTA, store: TIENDA_ABIERTA } })
  })

  it('1b: la respuesta final de la bandeja dice hasta cuándo está pausada y si la pausa es del gerente', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({
      status: 'PAUSED',
      reason: 'MANUAL_PAUSE',
      config: { pausedUntil: '2026-10-14T19:00:00.000Z', manualPause: true, enabled: true, hours: null },
    })
    const { req, res, next } = mock()
    await ctrl.inbox(req, res, next)
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { ...LISTA, store: { status: 'PAUSED', reason: 'MANUAL_PAUSE', pausedUntil: '2026-10-14T19:00:00.000Z', manualPause: true } },
    })
  })

  it('si no se pudo leer el estado de la tienda, la bandeja igual responde con `store: null`', async () => {
    ;(getAcceptingStatus as jest.Mock).mockRejectedValue(new Error('db'))
    const { req, res, next } = mock()
    await ctrl.inbox(req, res, next)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ...LISTA, store: null } })
  })

  it('A8: el cursor de los activos pasa al servicio y la respuesta trae su nextCursor', async () => {
    const CURSOR = '2026-10-14T18:30:00.000Z_oo-B099'
    ;(listInbox as jest.Mock).mockResolvedValue({ ...LISTA, truncated: true, nextCursor: 'siguiente' })
    const { req, res, next } = mock({ query: { status: 'active', cursor: CURSOR } })
    await ctrl.inbox(req, res, next)
    expect(listInbox).toHaveBeenCalledWith({ venueId: 'v1', filter: 'active', activeCursor: CURSOR })
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ nextCursor: 'siguiente' }) })
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
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ...LISTA, store: TIENDA_ABIERTA } })
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
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ...LISTA, store: TIENDA_ABIERTA } })
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

  it('aceptar con PAYMENT_REQUIRED (un folio sin pagar) responde 409 «se cobra antes de prepararlo»', async () => {
    ;(acceptOnlineOrder as jest.Mock).mockResolvedValueOnce({ outcome: 'PAYMENT_REQUIRED' })
    const a = mock()
    await ctrl.accept(a.req, a.res, a.next)
    expect(a.res.status).toHaveBeenCalledWith(409)
    expect(a.res.json).toHaveBeenCalledWith({
      success: false,
      code: 'PAYMENT_REQUIRED',
      error: 'Este pedido se cobra antes de prepararlo',
    })
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

  it('fase 2: con el banco cobrando la tarjeta es 409 ONLINE_ORDER_CONFIRMING_PAYMENT con su texto', async () => {
    ;(acceptOnlineOrder as jest.Mock).mockResolvedValue({ outcome: 'CONFIRMING_PAYMENT' })
    const { req, res, next } = mock()
    await ctrl.accept(req, res, next)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: 'ONLINE_ORDER_CONFIRMING_PAYMENT',
      error: 'Confirmando el pago con el banco. Espera unos segundos.',
    })
  })

  it('D661 (3B): el 409 OPEN_FROM_CAJA es verdad con la tarjeta sólo apartada y con un pedido que otra caja ya cobró: «No se aplicó nada», nunca «ya se pagó» ni «No se cobró nada»', async () => {
    ;(acceptOnlineOrder as jest.Mock).mockResolvedValue({ outcome: 'OPEN_FROM_CAJA' })
    const { req, res, next } = mock()
    await ctrl.accept(req, res, next)
    expect(res.status).toHaveBeenCalledWith(409)
    const body = res.json.mock.calls[0][0]
    expect(body).toMatchObject({ success: false, code: 'OPEN_FROM_CAJA' })
    expect(body.error).toMatch(/se abre desde la caja/)
    expect(body.error).toMatch(/No se aplicó nada\./)
    expect(body.error).not.toMatch(/ya se pagó|No se cobró nada/)
  })

  it('entregar uno marcado «No lo recogió» → 409 con su estado (mismo código de siempre y campos nuevos opcionales; nunca 200)', async () => {
    const CORTE = '2026-10-14T10:00:05.000Z'
    ;(markOnlineOrderDelivered as jest.Mock).mockResolvedValue({ outcome: 'STALE', status: 'COMPLETED', notPickedUpAt: CORTE })
    const a = mock()
    await ctrl.delivered(a.req, a.res, a.next)
    expect(a.res.status).toHaveBeenCalledWith(409)
    // Una app vieja lee `code` y `status` como hoy; una nueva pinta «No lo recogió» con `notPickedUpAt`.
    expect(a.res.json).toHaveBeenCalledWith({
      success: false,
      code: 'ORDER_STATE_CHANGED',
      status: 'COMPLETED',
      notPickedUpAt: CORTE,
      error: expect.stringContaining('«No lo recogió»'),
    })

    // «Devolviendo…» (reserva viva) y «Devuelto»: el mismo 409, con su marca y su texto.
    ;(markOnlineOrderDelivered as jest.Mock).mockResolvedValue({ outcome: 'STALE', status: 'READY', refundRequestedAt: CORTE })
    const b = mock()
    await ctrl.delivered(b.req, b.res, b.next)
    expect(b.res.status).toHaveBeenCalledWith(409)
    expect(b.res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ORDER_STATE_CHANGED',
        status: 'READY',
        refundRequestedAt: CORTE,
        error: expect.stringMatching(/devolviendo/),
      }),
    )
    ;(markOnlineOrderDelivered as jest.Mock).mockResolvedValue({ outcome: 'STALE', status: 'COMPLETED', refundedAt: CORTE })
    const c = mock()
    await ctrl.delivered(c.req, c.res, c.next)
    expect(c.res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ORDER_STATE_CHANGED',
        status: 'COMPLETED',
        refundedAt: CORTE,
        error: expect.stringMatching(/devolvió/),
      }),
    )

    // Sin marca, el 409 de siempre, con las mismas llaves (regresión).
    ;(markOnlineOrderDelivered as jest.Mock).mockResolvedValue({ outcome: 'STALE', status: 'CANCELLED_BY_STAFF' })
    const d = mock()
    await ctrl.delivered(d.req, d.res, d.next)
    expect(d.res.json).toHaveBeenCalledWith({
      success: false,
      code: 'ORDER_STATE_CHANGED',
      status: 'CANCELLED_BY_STAFF',
      error: 'El pedido ya cambió de estado (otro aparato, el cliente, la caja o el tiempo). Actualiza la bandeja.',
    })
  })

  it('D661 (Task 5): «Listo» sobre un pedido que se está devolviendo o ya se devolvió → el mismo 409 con su marca y un texto de «Listo»', async () => {
    const HORA = '2026-10-14T18:00:00.000Z'
    for (const [marca, texto] of [
      ['refundRequestedAt', /se está devolviendo: no se marca listo/],
      ['refundedAt', /ya se devolvió \(«Devuelto»\): no se marca listo/],
    ] as const) {
      ;(markOnlineOrderReady as jest.Mock).mockResolvedValueOnce({ outcome: 'STALE', status: 'ACCEPTED', [marca]: HORA })
      const a = mock()
      await ctrl.ready(a.req, a.res, a.next)
      expect(a.res.status).toHaveBeenCalledWith(409)
      expect(a.res.json).toHaveBeenCalledWith({
        success: false,
        code: 'ORDER_STATE_CHANGED',
        status: 'ACCEPTED',
        [marca]: HORA,
        error: expect.stringMatching(texto),
      })
    }
  })

  it('A12: entregar lo que ya estaba entregado es 200 (idempotente), no un 409 «ya cambió»', async () => {
    ;(markOnlineOrderDelivered as jest.Mock).mockResolvedValue({ outcome: 'OK', status: 'COMPLETED', unchanged: true })
    const { req, res, next } = mock()
    await ctrl.delivered(req, res, next)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { status: 'COMPLETED', unchanged: true } })
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
    expect(claimOnlineOrderPrint).toHaveBeenCalledWith('v1', 'ord1', 'dev1', expect.any(Date), false)
    expect(ok.res.json).toHaveBeenCalledWith({ success: true, data: { claimed: true } })
  })

  it('D661 · F1 (Ruling 37): el reclamo pasa si la caja marca «POSIBLE REPETIDA» (x-online-orders-card-alert: 1); otro valor o sin ella, no', async () => {
    ;(claimOnlineOrderPrint as jest.Mock).mockResolvedValue({ claimed: true, posibleRepetida: true })
    for (const [valor, marca] of [
      ['1', true],
      ['0', false],
      ['true', false],
    ] as const) {
      ;(claimOnlineOrderPrint as jest.Mock).mockClear()
      const { req, res, next } = mock({ headers: { 'x-online-orders-card-alert': valor } })
      await ctrl.printClaim(req, res, next)
      expect({ valor, args: (claimOnlineOrderPrint as jest.Mock).mock.calls[0] }).toEqual({
        valor,
        args: ['v1', 'ord1', 'dev1', expect.any(Date), marca],
      })
    }
  })

  it('M-10: un x-device-id larguísimo se recorta a 100 caracteres antes de guardarse como dueño del reclamo', async () => {
    ;(claimOnlineOrderPrint as jest.Mock).mockResolvedValue({ claimed: true })
    const { req, res, next } = mock({ headers: { 'x-device-id': `  ${'d'.repeat(5_000)}  ` } })
    await ctrl.printClaim(req, res, next)
    expect(claimOnlineOrderPrint).toHaveBeenCalledWith('v1', 'ord1', 'd'.repeat(100), expect.any(Date), false)
  })

  it('el reclamo usa el `:orderId` de la ruta (Order.id, el `orderId` de la bandeja) como llave `OnlineOrder.orderId`, nunca el id del pedido en línea', async () => {
    const real = jest.requireActual('@/services/online-ordering/printClaim.service')
    ;(claimOnlineOrderPrint as jest.Mock).mockImplementationOnce(real.claimOnlineOrderPrint)
    // Ruling 9: el reclamo lee primero el reclamo vigente y hace su CAS sobre él.
    prismaMock.onlineOrder.findFirst.mockResolvedValueOnce({ printClaimedAt: null } as any)
    prismaMock.onlineOrder.updateMany.mockResolvedValueOnce({ count: 1 })
    const { req, res, next } = mock()
    await ctrl.printClaim(req, res, next)
    const where = (prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any).where
    expect(where).toMatchObject({ orderId: 'ord1', venueId: 'v1' })
    expect(where).not.toHaveProperty('id')
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { claimed: true } })
  })

  it('pausar desde el piso escribe la pausa con quien la pidió (R12) y responde también la pausa del gerente (M-8)', async () => {
    ;(pauseOnlineOrdering as jest.Mock).mockResolvedValue({ pausedUntil: '2026-10-14T19:00:00.000Z', manualPause: false })
    const { req, res, next } = mock({ body: { minutes: 30 } })
    await ctrl.pause(req, res, next)
    expect(pauseOnlineOrdering).toHaveBeenCalledWith('v1', 30, 'staff1')
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { pausedUntil: '2026-10-14T19:00:00.000Z', manualPause: false } })
  })
})

/**
 * Founder, 16-oct: pausar desde el piso es de gerente para arriba. La ruta REAL de la app pasa por
 * `checkPermission('online-orders:pause')` (el middleware real, con la resolución real del rol), así que el PIN del gerente que
 * ya tiene el POS (`x-permission-override`) la cubre sin nada nuevo.
 */
describe('POST /pause: permiso propio y PIN del gerente', () => {
  beforeEach(() => prismaMock.venueSettings.findUnique.mockResolvedValue(null))

  const permisoDeLaPausa = () => {
    const capa = (mobileRouter as any).stack.find((l: any) => l.route?.path === '/pause' && l.route.methods.post)
    const conPermiso = capa.route.stack.map((s: any) => s.handle).filter((h: any) => h.requiredPermission)
    expect(conPermiso.map((h: any) => h.requiredPermission)).toEqual(['online-orders:pause'])
    return conPermiso[0]
  }
  const pedir = (headers: Record<string, string> = {}) => {
    const res: any = {}
    res.status = jest.fn(() => res)
    res.json = jest.fn(() => res)
    const req: any = {
      params: { venueId: 'v1' },
      headers,
      authContext: { userId: 'staff1' },
      method: 'POST',
      originalUrl: '/api/v1/mobile/venues/v1/online-orders/pause',
      get: () => undefined,
    }
    return { req, res, next: jest.fn() }
  }

  it('una cajera recibe 403 (con `overridable` si el negocio activó el PIN, para que el POS lo pida)', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ managerPinOverrideEnabled: true } as any)
    const { req, res, next } = pedir()
    await permisoDeLaPausa()(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ required: 'online-orders:pause', overridable: true }))
  })

  it('un gerente pasa', async () => {
    prismaMock.staffVenue.findUnique.mockResolvedValue(enElNegocio('MANAGER') as any)
    const { req, res, next } = pedir()
    await permisoDeLaPausa()(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('una cajera a la que el negocio le dio online-orders:pause pasa (se puede otorgar por rol)', async () => {
    prismaMock.venueRolePermission.findUnique.mockResolvedValue({ permissions: ['online-orders:pause'], deniedPermissions: [] } as any)
    const { req, res, next } = pedir()
    await permisoDeLaPausa()(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('una cajera con el PIN del gerente (token consumido para online-orders:pause) pasa', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ managerPinOverrideEnabled: true } as any)
    prismaMock.permissionOverride.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.permissionOverride.findUnique.mockResolvedValue({ authorizedById: 'sv_gerente' } as any)
    const { req, res, next } = pedir({ 'x-permission-override': 'tok_gerente' })
    await permisoDeLaPausa()(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect((prismaMock.permissionOverride.updateMany.mock.calls[0][0] as any).where).toMatchObject({
      token: 'tok_gerente',
      venueId: 'v1',
      permission: 'online-orders:pause',
    })
    expect(req.authContext.overrideAuthorizedBy).toBe('sv_gerente')
  })
})

describe('toPay (tienda híbrida T12)', () => {
  const TO_PAY = { 'x-online-orders-to-pay': '1' }
  it('la cabecera x-online-orders-to-pay: 1 toca el latido DESPUÉS de listar, sólo si la sesión tiene payments:create', async () => {
    const { req, res, next } = mock({ query: { section: 'toPay' }, headers: TO_PAY })
    await ctrl.toPay(req, res, next)
    expect(listFolios).toHaveBeenCalledWith({ venueId: 'v1', section: 'toPay' })
    expect(touchToPayPoll).toHaveBeenCalledWith('v1')
    expect((listFolios as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((touchToPayPoll as jest.Mock).mock.invocationCallOrder[0])
    expect(touchInboxPoll).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ...FOLIOS, store: TIENDA_ABIERTA } })
  })

  it('m8: el panel (toPayPanel) nunca late, aunque mande la cabecera', async () => {
    const { req, res, next } = mock({ headers: TO_PAY })
    await ctrl.toPayPanel(req, res, next)
    expect(listFolios).toHaveBeenCalled()
    expect(touchToPayPoll).not.toHaveBeenCalled()
  })

  it('sin la cabecera no late', async () => {
    const { req, res, next } = mock()
    await ctrl.toPay(req, res, next)
    expect(touchToPayPoll).not.toHaveBeenCalled()
  })

  it('una sesión sin payments:create (VIEWER) mira sin latir', async () => {
    prismaMock.staffVenue.findUnique.mockResolvedValue(enElNegocio('VIEWER') as any)
    const { req, res, next } = mock({ headers: TO_PAY })
    await ctrl.toPay(req, res, next)
    expect(touchToPayPoll).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalled()
  })

  it('una suplantación (sólo lectura) no late aunque el rol suplantado cobre', async () => {
    const { req, res, next } = mock({ headers: TO_PAY })
    req.authContext.isImpersonating = true
    await ctrl.toPay(req, res, next)
    expect(touchToPayPoll).not.toHaveBeenCalled()
  })

  it('pasa section y cursor a la lista; un fallo del latido no le cuesta la lista a la caja', async () => {
    ;(touchToPayPoll as jest.Mock).mockRejectedValue(new Error('db'))
    const { req, res, next } = mock({ query: { section: 'toDeliver', cursor: 'c' }, headers: TO_PAY })
    await ctrl.toPay(req, res, next)
    expect(listFolios).toHaveBeenCalledWith({ venueId: 'v1', section: 'toDeliver', cursor: 'c' })
    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalled()
  })
})

/**
 * D661 (r4 #4, Ruling 7): la caja ACTUALIZADA que sabe avisar los pedidos pagados en línea manda `x-online-orders-card-alert: 1`. Su
 * latido sólo cuenta de quien puede ABRIR (= cobrar) esos pedidos: `orders:update`. Dice además si la respuesta que recibió fue
 * RÁPIDA (`pollSeconds` <= 30): sólo así la tienda ofrece la tarjeta en «Nadie».
 */
describe('toPay · el latido de la caja que avisa (D661)', () => {
  const RAPIDA = { ...FOLIOS, pollSeconds: 30 }
  const AMBAS = { 'x-online-orders-to-pay': '1', 'x-online-orders-card-alert': '1' }
  beforeEach(() => (listFolios as jest.Mock).mockResolvedValue(RAPIDA))

  it('con la cabecera y permiso orders:update (el que abre) se escribe lastCardAlertPollAt; sin ella o sin ese permiso, no', async () => {
    // Una cajera (orders:update) con la cabecera: late.
    const con = mock({ headers: AMBAS })
    await ctrl.toPay(con.req, con.res, con.next)
    expect(touchCardAlertPoll).toHaveBeenCalledTimes(1)
    expect(touchCardAlertPoll).toHaveBeenCalledWith('v1', true)
    // Sin la cabecera (una caja vieja, que no sabe avisar): no late, aunque sí late «por cobrar».
    ;(touchCardAlertPoll as jest.Mock).mockClear()
    const vieja = mock({ headers: { 'x-online-orders-to-pay': '1' } })
    await ctrl.toPay(vieja.req, vieja.res, vieja.next)
    expect(touchToPayPoll).toHaveBeenCalled()
    expect(touchCardAlertPoll).not.toHaveBeenCalled()
    // Con la cabecera pero sin orders:update (puede cobrar en caja, no abrir un pedido pagado en línea): no late la de tarjeta.
    prismaMock.staffVenue.findUnique.mockResolvedValue(enElNegocio('VIEWER') as any)
    prismaMock.venueRolePermission.findUnique.mockResolvedValue({ permissions: ['payments:create'], deniedPermissions: [] } as any)
    ;(touchToPayPoll as jest.Mock).mockClear()
    const sinAbrir = mock({ headers: AMBAS })
    await ctrl.toPay(sinAbrir.req, sinAbrir.res, sinAbrir.next)
    expect(touchToPayPoll).toHaveBeenCalledWith('v1')
    expect(touchCardAlertPoll).not.toHaveBeenCalled()
    // Suplantando (sólo lectura): tampoco.
    prismaMock.staffVenue.findUnique.mockResolvedValue(enElNegocio('CASHIER') as any)
    prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
    const suplanta = mock({ headers: AMBAS })
    suplanta.req.authContext.isImpersonating = true
    await ctrl.toPay(suplanta.req, suplanta.res, suplanta.next)
    expect(touchCardAlertPoll).not.toHaveBeenCalled()
  })

  it('Ruling 7: el latido dice si la respuesta fue RÁPIDA (pollSeconds <= 30); con la espera larga (600) es lento', async () => {
    const rapida = mock({ headers: AMBAS })
    await ctrl.toPay(rapida.req, rapida.res, rapida.next)
    ;(listFolios as jest.Mock).mockResolvedValue({ ...FOLIOS, pollSeconds: 600 })
    const lenta = mock({ headers: AMBAS })
    await ctrl.toPay(lenta.req, lenta.res, lenta.next)
    expect((touchCardAlertPoll as jest.Mock).mock.calls).toEqual([
      ['v1', true],
      ['v1', false],
    ])
    // Lo que la caja recibe es lo que se midió.
    expect(lenta.res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ pollSeconds: 600 }) })
  })

  it('Ruling 7: primero el latido de folios (crea la fila de ajustes), después el de la caja que avisa (sólo la actualiza); ninguno sin listar bien', async () => {
    const { req, res, next } = mock({ headers: AMBAS })
    await ctrl.toPay(req, res, next)
    const orden = (f: unknown) => (f as jest.Mock).mock.invocationCallOrder[0]
    expect(orden(listFolios)).toBeLessThan(orden(touchToPayPoll))
    expect(orden(touchToPayPoll)).toBeLessThan(orden(touchCardAlertPoll))
    ;(touchCardAlertPoll as jest.Mock).mockClear()
    ;(listFolios as jest.Mock).mockRejectedValue(new Error('db'))
    const rota = mock({ headers: AMBAS })
    await ctrl.toPay(rota.req, rota.res, rota.next)
    expect(rota.next).toHaveBeenCalledWith(expect.any(Error))
    expect(touchCardAlertPoll).not.toHaveBeenCalled()
  })

  it('el panel nunca late como caja que avisa, aunque mande la cabecera; un fallo del latido no le cuesta la lista a la caja', async () => {
    const panel = mock({ headers: AMBAS })
    await ctrl.toPayPanel(panel.req, panel.res, panel.next)
    expect(touchCardAlertPoll).not.toHaveBeenCalled()
    ;(touchCardAlertPoll as jest.Mock).mockRejectedValue(new Error('db'))
    const caja = mock({ headers: AMBAS })
    await ctrl.toPay(caja.req, caja.res, caja.next)
    expect(caja.next).not.toHaveBeenCalled()
    expect(caja.res.json).toHaveBeenCalledWith({ success: true, data: { ...RAPIDA, store: TIENDA_ABIERTA } })
  })

  // D661 · A (Ruling 41): la caja que avisa sólo se duerme (600 s) si el servidor anotó su respuesta lenta, que es lo que apaga la
  // marca rápida con la que la tienda ofrece la tarjeta. Si no se pudo anotar, sigue en 30 s hasta que se anote.
  const LENTA = { ...FOLIOS, pollSeconds: 600 }

  it('D661 · A (Ruling 41): respuesta LENTA y la escritura que apaga la marca rápida falla → la caja recibe la cadencia rápida (30 s); anotada bien, 600 como hoy', async () => {
    ;(listFolios as jest.Mock).mockResolvedValue(LENTA)
    ;(touchCardAlertPoll as jest.Mock).mockRejectedValueOnce(new Error('se cayó la base'))
    const falla = mock({ headers: AMBAS })
    await ctrl.toPay(falla.req, falla.res, falla.next)
    expect(touchCardAlertPoll).toHaveBeenCalledWith('v1', false)
    expect(falla.next).not.toHaveBeenCalled()
    expect(falla.res.json).toHaveBeenCalledWith({ success: true, data: { ...LENTA, pollSeconds: 30, store: TIENDA_ABIERTA } })

    const sana = mock({ headers: AMBAS })
    await ctrl.toPay(sana.req, sana.res, sana.next)
    expect(sana.res.json).toHaveBeenCalledWith({ success: true, data: { ...LENTA, store: TIENDA_ABIERTA } })
  })

  it('D661 · A (Ruling 41): respuesta RÁPIDA y la escritura falla → nada cambia (la marca queda vieja: la tarjeta se ofrece menos, nunca más)', async () => {
    ;(touchCardAlertPoll as jest.Mock).mockRejectedValueOnce(new Error('se cayó la base'))
    const caja = mock({ headers: AMBAS })
    await ctrl.toPay(caja.req, caja.res, caja.next)
    expect(touchCardAlertPoll).toHaveBeenCalledWith('v1', true)
    expect(caja.res.json).toHaveBeenCalledWith({ success: true, data: { ...RAPIDA, store: TIENDA_ABIERTA } })
  })

  it('D661 · A (Ruling 41): respuesta LENTA y no se pudo leer si la caja puede abrir pedidos (falla la base al revisar su permiso) → tampoco se duerme: 30 s', async () => {
    ;(listFolios as jest.Mock).mockResolvedValue(LENTA)
    prismaMock.venueRolePermission.findUnique.mockRejectedValue(new Error('se cayó la base'))
    const caja = mock({ headers: AMBAS })
    await ctrl.toPay(caja.req, caja.res, caja.next)
    expect(caja.next).not.toHaveBeenCalled()
    expect(caja.res.json).toHaveBeenCalledWith({ success: true, data: { ...LENTA, pollSeconds: 30, store: TIENDA_ABIERTA } })

    // Sin la cabecera (una caja vieja, que no avisa) o desde el panel, la misma falla no cambia su cadencia: no hay marca que cuidar.
    const vieja = mock({ headers: { 'x-online-orders-to-pay': '1' } })
    await ctrl.toPay(vieja.req, vieja.res, vieja.next)
    expect(vieja.res.json).toHaveBeenCalledWith({ success: true, data: { ...LENTA, store: TIENDA_ABIERTA } })
    const panel = mock({ headers: AMBAS })
    await ctrl.toPayPanel(panel.req, panel.res, panel.next)
    expect(panel.res.json).toHaveBeenCalledWith({ success: true, data: { ...LENTA, store: TIENDA_ABIERTA } })
  })

  it('D661 · A (Ruling 41): una caja que avisa pero NO puede abrir pedidos (sin orders:update, leído bien) no late y sigue con su cadencia', async () => {
    ;(listFolios as jest.Mock).mockResolvedValue(LENTA)
    prismaMock.staffVenue.findUnique.mockResolvedValue(enElNegocio('VIEWER') as any)
    const caja = mock({ headers: AMBAS })
    await ctrl.toPay(caja.req, caja.res, caja.next)
    expect(touchCardAlertPoll).not.toHaveBeenCalled()
    expect(caja.res.json).toHaveBeenCalledWith({ success: true, data: { ...LENTA, store: TIENDA_ABIERTA } })
  })
})
