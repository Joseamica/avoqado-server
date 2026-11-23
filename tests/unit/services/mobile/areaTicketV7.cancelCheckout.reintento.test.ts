/**
 * S5b (red por traba, R65 b): `cancelAreaTicketCheckout` tras un 40P01. La orden que se canceló en el intento ABORTADO se deshizo con él:
 * el aviso de «orden cancelada» sale sólo del intento que hizo commit.
 */
import { prismaMock } from '@tests/__helpers__/setup'

const mockAvisar = jest.fn()
jest.mock('@/services/shared/orderCancelGuard', () => ({
  ...jest.requireActual('@/services/shared/orderCancelGuard'),
  assertOrderCancellableUnderLock: jest.fn().mockResolvedValue(undefined),
  devolverCanjesDeVentaAnuladaEnTx: jest.fn().mockResolvedValue(undefined),
  avisarOrdenCancelada: (...a: unknown[]) => mockAvisar(...a),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
// hz:e82938e1:D40: el retiro de comandas y sus candados (los prueba su propia suite y la integración).
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  retirarComandasDeVentaAnulada: jest.fn(async () => ({ kdsOrderIds: [], kdsOrderItemIds: [] })),
  cuentasDeSusComandas: jest.fn(async () => ['order-1', 'cuenta-ligada']),
  tomarCandadoDeComandas: jest.fn(async () => undefined),
  apartarActorDeLaAnulacion: jest.fn(async (_tx: unknown, _venueId: string, staffId?: string | null) => staffId ?? undefined),
}))

import { cancelAreaTicketCheckout } from '@/services/mobile/areaTicketV7.mobile.service'
import { assertOrderCancellableUnderLock } from '@/services/shared/orderCancelGuard'
import {
  apartarActorDeLaAnulacion,
  retirarComandasDeVentaAnulada,
  tomarCandadoDeComandas,
} from '@/services/kds/kitchenTicketAuthoring.service'

const sesion = (over: Record<string, unknown> = {}) => ({
  id: 'ses-1',
  venueId: 'v1',
  status: 'OPEN',
  terminalId: 'term-1',
  orderId: 'order-1',
  order: null,
  cancelIdempotencyKey: null,
  activePaymentAttemptId: null,
  version: 1,
  tickets: [],
  paymentAttempts: [],
  terminal: { id: 'term-1' },
  ...over,
})

describe('cancelAreaTicketCheckout — la marca de cocina (hz:e82938e1:D39)', () => {
  // Como `cancelOrderInTransaction` (D38): si la anulación dejaba la marca de «por mandar a cocina» (la de una ronda) y el dinero ya
  // capturado la reabría antes del barrido (cada minuto), el barrido armaba la comanda de una cancelada reabierta (regla S1: no vuelve).
  it('🔴 D39: cancelar la venta de vales limpia la marca en la misma escritura que anula su orden', async () => {
    ;(prismaMock as any).terminal.findFirst.mockResolvedValue({ id: 'term-1', canCheckoutAreaTickets: true })
    ;(prismaMock as any).areaTicketCheckoutSession.findFirst.mockResolvedValue(sesion())
    ;(prismaMock as any).staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.$queryRaw.mockResolvedValue([] as any)
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)
    ;(prismaMock as any).areaTicketCheckoutSession.findUniqueOrThrow.mockResolvedValue(sesion({ status: 'CANCELLED' }))
    ;(prismaMock as any).areaTicket.updateMany.mockResolvedValue({ count: 0 })
    ;(prismaMock as any).areaTicketCheckoutSession.update.mockResolvedValue({})

    await cancelAreaTicketCheckout('v1', 'ses-1', { idempotencyKey: 'k1', deviceUid: 'dev-1', staffId: null } as any)

    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', venueId: 'v1', paymentStatus: 'PENDING' },
      data: { status: 'CANCELLED', kitchenPendingAt: null, version: { increment: 1 } },
    })
  })
})

describe('cancelAreaTicketCheckout — la red por traba (40P01)', () => {
  it('[repetirNoDuplica:cancelAreaTicketCheckout] el aviso de «orden cancelada» no sale si sólo el intento ABORTADO la canceló', async () => {
    ;(prismaMock as any).terminal.findFirst.mockResolvedValue({ id: 'term-1', canCheckoutAreaTickets: true })
    ;(prismaMock as any).areaTicketCheckoutSession.findFirst.mockResolvedValue(sesion())
    ;(prismaMock as any).staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.$queryRaw.mockResolvedValue([] as any)
    // Intento 1: la orden se cancela (count 1). Intento 2: otro camino ya la había cancelado (count 0) y la sesión ya está CANCELLED.
    prismaMock.order.updateMany.mockResolvedValueOnce({ count: 1 } as any).mockResolvedValue({ count: 0 } as any)
    ;(prismaMock as any).areaTicketCheckoutSession.findUniqueOrThrow.mockResolvedValue(sesion({ status: 'CANCELLED' }))
    ;(prismaMock as any).areaTicket.updateMany.mockResolvedValue({ count: 0 })
    ;(prismaMock as any).areaTicketCheckoutSession.update.mockResolvedValue({})
    let llamada = 0
    prismaMock.$transaction.mockImplementation((async (cb: any) => {
      const r = await cb(prismaMock)
      if (++llamada === 1) {
        ;(prismaMock as any).areaTicketCheckoutSession.findFirst.mockResolvedValue(sesion({ status: 'CANCELLED' }))
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
      }
      return r
    }) as any)

    try {
      await cancelAreaTicketCheckout('v1', 'ses-1', { idempotencyKey: 'k1', deviceUid: 'dev-1', staffId: null } as any)

      expect(llamada).toBe(2)
      expect(mockAvisar).not.toHaveBeenCalled()
    } finally {
      prismaMock.$transaction.mockImplementation(((cb: any) => cb(prismaMock)) as any)
    }
  })
})

// hz:e82938e1:D40: cancelar la venta de vales anulaba su orden pero NO retiraba sus comandas (el DELETE, `cancelOrderInTransaction` y
// «Regresar saldo y cancelar» sí). Los renglones de vale no van a cocina, pero un producto suelto agregado desde el POS sí: su comanda
// pendiente seguía en la pantalla de cocina. Los candados de comandas van ANTES que la sesión (el orden del armado: comandas → venta).
describe('cancelAreaTicketCheckout — retira las comandas (hz:e82938e1:D40)', () => {
  const preparar = (over: Record<string, unknown> = {}) => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation((async (cb: any) => cb(prismaMock)) as any)
    ;(prismaMock as any).terminal.findFirst.mockResolvedValue({ id: 'term-1', canCheckoutAreaTickets: true })
    ;(prismaMock as any).areaTicketCheckoutSession.findFirst.mockResolvedValue(sesion(over))
    ;(prismaMock as any).staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.$queryRaw.mockResolvedValue([] as any)
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)
    ;(prismaMock as any).areaTicketCheckoutSession.findUniqueOrThrow.mockResolvedValue(sesion({ ...over, status: 'CANCELLED' }))
    ;(prismaMock as any).areaTicket.updateMany.mockResolvedValue({ count: 0 })
    ;(prismaMock as any).areaTicketCheckoutSession.update.mockResolvedValue({})
  }
  const ordenDe = (fn: unknown, i = 0) => (fn as jest.Mock).mock.invocationCallOrder[i]

  it('🔴 cancelar la venta de vales retira sus comandas: candados de comandas antes que la sesión, retiro antes del candado de la orden', async () => {
    preparar()
    await cancelAreaTicketCheckout('v1', 'ses-1', { idempotencyKey: 'k1', deviceUid: 'dev-1', staffId: null } as any)

    expect((tomarCandadoDeComandas as jest.Mock).mock.calls.map(c => c[1])).toEqual(['cuenta-ligada', 'order-1'])
    const candadoDeSesion = prismaMock.$queryRaw.mock.calls.findIndex((c: unknown[]) =>
      String((c[0] as any).join('?')).includes('"AreaTicketCheckoutSession"'),
    )
    expect(candadoDeSesion).toBeGreaterThanOrEqual(0)
    // TODOS los candados de comandas (no sólo el primero) van antes que el de la sesión.
    expect(ordenDe(tomarCandadoDeComandas, 1)).toBeLessThan(prismaMock.$queryRaw.mock.invocationCallOrder[candadoDeSesion])
    expect(retirarComandasDeVentaAnulada).toHaveBeenCalledWith(
      prismaMock,
      'v1',
      'order-1',
      expect.objectContaining({ reason: expect.any(String) }),
    )
    expect(ordenDe(retirarComandasDeVentaAnulada)).toBeLessThan(ordenDe(assertOrderCancellableUnderLock))
  })

  it('Codex d40-r1 #1: la orden se lee DENTRO del intento: si se materializó después de la primera lectura, igual se toman sus candados antes que la sesión', async () => {
    preparar()
    // La lectura de fuera (loadCheckout) todavía no ve la orden; la de dentro de la transacción ya sí.
    ;(prismaMock as any).areaTicketCheckoutSession.findFirst.mockResolvedValueOnce(sesion({ orderId: null }))
    await cancelAreaTicketCheckout('v1', 'ses-1', { idempotencyKey: 'k1', deviceUid: 'dev-1', staffId: null } as any)

    const candadoDeSesion = prismaMock.$queryRaw.mock.calls.findIndex((c: unknown[]) =>
      String((c[0] as any).join('?')).includes('"AreaTicketCheckoutSession"'),
    )
    expect((tomarCandadoDeComandas as jest.Mock).mock.calls.map(c => c[1])).toEqual(['cuenta-ligada', 'order-1'])
    expect(ordenDe(tomarCandadoDeComandas, 1)).toBeLessThan(prismaMock.$queryRaw.mock.invocationCallOrder[candadoDeSesion])
    expect(retirarComandasDeVentaAnulada).toHaveBeenCalledWith(prismaMock, 'v1', 'order-1', expect.anything())
  })

  it('Codex d40-r2: el primer intento vio la sesión sin orden y cayó en 40P01 al retirar; el segundo ya la lee y toma sus candados primero', async () => {
    preparar()
    // loadCheckout (fuera) y la lectura del primer intento todavía no ven la orden; la relectura bajo candado ya sí.
    ;(prismaMock as any).areaTicketCheckoutSession.findFirst
      .mockResolvedValueOnce(sesion({ orderId: null }))
      .mockResolvedValueOnce(sesion({ orderId: null }))
    // En el primer intento el retiro pide el candado de comandas a media transacción y Postgres lo elige como víctima.
    ;(retirarComandasDeVentaAnulada as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }))

    await cancelAreaTicketCheckout('v1', 'ses-1', { idempotencyKey: 'k1', deviceUid: 'dev-1', staffId: null } as any)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(retirarComandasDeVentaAnulada).toHaveBeenCalledTimes(2)
    // Sólo el segundo intento tomó los candados de comandas, y antes de su retiro.
    expect((tomarCandadoDeComandas as jest.Mock).mock.calls.map(c => c[1])).toEqual(['cuenta-ligada', 'order-1'])
    expect(ordenDe(tomarCandadoDeComandas, 0)).toBeGreaterThan(ordenDe(retirarComandasDeVentaAnulada, 0))
    expect(ordenDe(tomarCandadoDeComandas, 1)).toBeLessThan(ordenDe(retirarComandasDeVentaAnulada, 1))
    // Codex d40-r3: y antes del candado de la sesión del SEGUNDO intento.
    const candadosDeSesion = prismaMock.$queryRaw.mock.calls.flatMap((c: unknown[], i: number) =>
      String((c[0] as any).join('?')).includes('"AreaTicketCheckoutSession"') ? [prismaMock.$queryRaw.mock.invocationCallOrder[i]] : [],
    )
    expect(candadosDeSesion).toHaveLength(2)
    expect(ordenDe(tomarCandadoDeComandas, 1)).toBeLessThan(candadosDeSesion[1])
    expect(prismaMock.order.updateMany).toHaveBeenCalledTimes(1)
  })

  it('Codex d40-r4 #1: el cajero se aparta ANTES que los candados de cocina; si ya no existe, el retiro va sin actor', async () => {
    preparar()
    ;(prismaMock as any).staffVenue.findFirst.mockResolvedValue({ staffId: 'cajero', staff: { id: 'cajero' } })
    ;(apartarActorDeLaAnulacion as jest.Mock).mockResolvedValueOnce(undefined)
    await cancelAreaTicketCheckout('v1', 'ses-1', { idempotencyKey: 'k1', deviceUid: 'dev-1', staffId: 'cajero' } as any)
    expect((apartarActorDeLaAnulacion as jest.Mock).mock.calls[0].slice(0, 2)).toEqual([prismaMock, 'v1'])
    expect(ordenDe(apartarActorDeLaAnulacion)).toBeLessThan(ordenDe(tomarCandadoDeComandas))
    expect(retirarComandasDeVentaAnulada).toHaveBeenCalledWith(prismaMock, 'v1', 'order-1', expect.objectContaining({ staffId: undefined }))
  })

  it('regresión: una sesión sin orden todavía (OPEN) no toca la cocina', async () => {
    preparar({ orderId: null })
    await cancelAreaTicketCheckout('v1', 'ses-1', { idempotencyKey: 'k1', deviceUid: 'dev-1', staffId: null } as any)
    expect(tomarCandadoDeComandas).not.toHaveBeenCalled()
    expect(retirarComandasDeVentaAnulada).not.toHaveBeenCalled()
  })

  it('Codex d40-r6: una sesión vacía (sin venta) no aparta al cajero ni espera a la sucursal, como antes de D40', async () => {
    preparar({ orderId: null })
    ;(prismaMock as any).staffVenue.findFirst.mockResolvedValue({ staffId: 'cajero', staff: { id: 'cajero' } })
    await cancelAreaTicketCheckout('v1', 'ses-1', { idempotencyKey: 'k1', deviceUid: 'dev-1', staffId: 'cajero' } as any)
    expect(apartarActorDeLaAnulacion).not.toHaveBeenCalled()
  })

  it('Codex d40-r3 #2: cancelar otra vez una venta ya cancelada (otra llave) no espera a la cocina ni retira nada', async () => {
    preparar({ status: 'CANCELLED', cancelIdempotencyKey: 'otra' })
    ;(prismaMock as any).staffVenue.findFirst.mockResolvedValue({ staffId: 'cajero', staff: { id: 'cajero' } })
    await cancelAreaTicketCheckout('v1', 'ses-1', { idempotencyKey: 'k1', deviceUid: 'dev-1', staffId: 'cajero' } as any)
    expect(apartarActorDeLaAnulacion).not.toHaveBeenCalled()
    expect(tomarCandadoDeComandas).not.toHaveBeenCalled()
    expect(retirarComandasDeVentaAnulada).not.toHaveBeenCalled()
  })

  it('regresión: repetir la MISMA cancelación (misma llave) no vuelve a retirar nada', async () => {
    preparar({ status: 'CANCELLED', cancelIdempotencyKey: 'k1' })
    await cancelAreaTicketCheckout('v1', 'ses-1', { idempotencyKey: 'k1', deviceUid: 'dev-1', staffId: null } as any)
    expect(retirarComandasDeVentaAnulada).not.toHaveBeenCalled()
  })
})
