/**
 * Frontera de dinero del cobro móvil: qué montos y propinas se ACEPTAN.
 *
 * Los dos casos que fija este archivo salieron de defectos reales medidos el
 * 2026-08-09 contra el server local:
 *
 * 1. **Propina NEGATIVA aceptada.** `payCashOrder` suma `tip/100` al total sin
 *    clamp, así que un `tip: -500` devolvía 200 y dejaba la orden mutada
 *    (total 45 → 40) y PAGADA, con `paidAmount` que ya no cuadraba con la suma
 *    de sus pagos. Es un descuento disfrazado y, peor, una orden inconciliable:
 *    la consulta de integridad subió 947 → 948 con UNA sola orden. El descuento
 *    sí se clampaba; la propina no. `/fast` ya lo rechazaba por Zod
 *    (`tip: min(0)`), así que este endpoint era el único agujero.
 *
 * 2. **`amount === 0` DEBE seguir pasando.** Es lo que cierra una cuenta
 *    cortesiada al 100%: `compWholeOrder` deja los artículos en 0 pero no toca
 *    `paymentStatus`, y este endpoint es la única salida. Antes se rechazaba
 *    junto con los negativos y esas cuentas quedaban abiertas para siempre
 *    (medido: ORD-1785877370147, 5 días abierta en $0). Si alguien "endurece"
 *    la validación de monto sin leer esto, vuelve a romperlo — de ahí el test.
 *
 * Se prueba el CONTROLLER a propósito: es la frontera donde vive la validación,
 * y lo que se quiere garantizar es que el servicio ni siquiera se invoque
 * cuando el input es inválido.
 */

import type { NextFunction, Request, Response } from 'express'

import { payCash } from '@/controllers/mobile/order.mobile.controller'
import * as orderMobileService from '@/services/mobile/order.mobile.service'

jest.mock('@/services/mobile/order.mobile.service', () => ({
  payCashOrder: jest.fn(),
}))

const payCashOrderMock = orderMobileService.payCashOrder as jest.MockedFunction<typeof orderMobileService.payCashOrder>

const venueId = 'venue-123'
const orderId = 'order-123'
const staffId = 'staff-123'

function buildRes() {
  const res = {} as Response & { statusCode?: number; payload?: unknown }
  res.status = jest.fn().mockImplementation((code: number) => {
    res.statusCode = code
    return res
  }) as unknown as Response['status']
  res.json = jest.fn().mockImplementation((body: unknown) => {
    res.payload = body
    return res
  }) as unknown as Response['json']
  return res
}

function buildReq(body: Record<string, unknown>) {
  return {
    params: { venueId, orderId },
    body: { staffId, ...body },
    authContext: { userId: staffId },
  } as unknown as Request
}

describe('payCash — frontera de monto y propina', () => {
  const next = jest.fn() as NextFunction

  beforeEach(() => {
    jest.clearAllMocks()
    payCashOrderMock.mockResolvedValue({
      paymentId: 'pay-1',
      orderId,
      orderNumber: 'ORD-1',
      amount: 0,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
    } as Awaited<ReturnType<typeof orderMobileService.payCashOrder>>)
  })

  describe('propina negativa = descuento disfrazado', () => {
    it('rechaza tip negativo con 400 y NO llama al servicio', async () => {
      const res = buildRes()
      await payCash(buildReq({ amount: 4500, tip: -500 }), res, next)

      expect(res.statusCode).toBe(400)
      expect(payCashOrderMock).not.toHaveBeenCalled()
    })

    it.each([
      ['decimal negativo', -0.5],
      ['string', '-500'],
      ['infinito', Number.POSITIVE_INFINITY],
      ['NaN', Number.NaN],
    ])('rechaza tip %s', async (_label, tip) => {
      const res = buildRes()
      await payCash(buildReq({ amount: 4500, tip }), res, next)

      expect(res.statusCode).toBe(400)
      expect(payCashOrderMock).not.toHaveBeenCalled()
    })

    it('acepta una propina legítima', async () => {
      const res = buildRes()
      await payCash(buildReq({ amount: 4500, tip: 1500 }), res, next)

      expect(res.statusCode).not.toBe(400)
      expect(payCashOrderMock).toHaveBeenCalledWith(venueId, orderId, expect.objectContaining({ tip: 1500 }))
    })

    it('acepta que no venga tip (los clientes viejos no siempre lo mandan)', async () => {
      const res = buildRes()
      await payCash(buildReq({ amount: 4500 }), res, next)

      expect(res.statusCode).not.toBe(400)
      expect(payCashOrderMock).toHaveBeenCalledWith(venueId, orderId, expect.objectContaining({ tip: 0 }))
    })
  })

  describe('monto', () => {
    it('🔴 DEJA PASAR amount 0 — es lo que cierra una cuenta cortesiada al 100%', async () => {
      const res = buildRes()
      await payCash(buildReq({ amount: 0, tip: 0 }), res, next)

      // El controller sólo valida el TIPO; que el saldo sea de verdad 0 lo
      // verifica el servicio (rechaza con "Esta cuenta debe X" si hay deuda).
      expect(res.statusCode).not.toBe(400)
      expect(payCashOrderMock).toHaveBeenCalledWith(venueId, orderId, expect.objectContaining({ amount: 0 }))
    })

    it('rechaza monto negativo', async () => {
      const res = buildRes()
      await payCash(buildReq({ amount: -100, tip: 0 }), res, next)

      expect(res.statusCode).toBe(400)
      expect(payCashOrderMock).not.toHaveBeenCalled()
    })

    it('rechaza monto no numérico', async () => {
      const res = buildRes()
      await payCash(buildReq({ amount: 'abc', tip: 0 }), res, next)

      expect(res.statusCode).toBe(400)
      expect(payCashOrderMock).not.toHaveBeenCalled()
    })
  })

  /**
   * D5 (mesas40, 14-oct): NO hay tope de monto que responda 400. `/pay` registra cobros que YA OCURRIERON fuera de
   * Avoqado (tarjeta de una terminal ajena, transferencia): rechazarlos perdería ese dinero del registro. El tope vive
   * en el teclado del aparato; el server sólo grita en el log (`payCashOrder.sobrepago.test.ts`). Éste es el cuerpo
   * REAL que arma Android (`OrderRepository.recordCashPayment`).
   */
  describe('D5: el payload real de Android con un importe gigante sigue en 200', () => {
    const GIGANTE = 999_999_999_999
    const cuerpoAndroid = (extra: Record<string, unknown>) => ({
      venueId,
      amount: GIGANTE,
      tip: 0,
      status: 'COMPLETED',
      splitType: 'FULLPAYMENT',
      source: 'AVOQADO_ANDROID',
      idempotencyKey: 'k-android',
      ...extra,
    })

    it.each([
      ['efectivo', { method: 'CASH' }],
      ['tarjeta de una terminal externa', { method: 'CREDIT_CARD', externalSource: 'Terminal BBVA' }],
      ['transferencia', { method: 'BANK_TRANSFER' }],
    ])('%s ⇒ 200 y el servicio recibe el importe EXACTO', async (_label, extra) => {
      const res = buildRes()
      await payCash(buildReq(cuerpoAndroid(extra)), res, next)

      expect(res.statusCode).toBe(200)
      expect(payCashOrderMock).toHaveBeenCalledWith(
        venueId,
        orderId,
        expect.objectContaining({ amount: GIGANTE, idempotencyKey: 'k-android', ...extra }),
      )
    })

    it('el reintento idempotente (misma llave, mismo cuerpo) también ⇒ 200 las dos veces', async () => {
      const primero = buildRes()
      const reintento = buildRes()
      await payCash(buildReq(cuerpoAndroid({ method: 'CASH' })), primero, next)
      await payCash(buildReq(cuerpoAndroid({ method: 'CASH' })), reintento, next)

      expect([primero.statusCode, reintento.statusCode]).toEqual([200, 200])
      expect(payCashOrderMock).toHaveBeenCalledTimes(2)
      expect(next).not.toHaveBeenCalled()
    })
  })
})

/**
 * 🔴 Ronda 2 de S1/S2 (17/18-oct-2026): lo que el controller le dice al servicio sobre QUIÉN manda el reenvío.
 *   · R2-1: Android ≤ 2.23 y su app de Windows (mismo código, `x-app-version` «2.23.0-escritorio») tienen el defecto H1: su cola manda
 *     el TOTAL de la cuenta en vez de la parte del split. Para esa cola el servicio se porta como antes de S1/S2.
 *   · R2-6: si la propiedad de mesa dejó pasar dinero ya capturado sobre una mesa ajena, el controller lo entrega al servicio.
 */
describe('payCash — la cola con H1 y la mesa ajena', () => {
  const next = jest.fn() as NextFunction
  const reqCon = (headers: Record<string, string>, body: Record<string, unknown> = { amount: 10000, isOfflineReplay: true }) =>
    ({ params: { venueId, orderId }, body: { staffId, ...body }, headers, authContext: { userId: staffId } }) as unknown as Request
  const marcaH1 = () => (payCashOrderMock.mock.calls[0][2] as any).colaConDefectoH1

  beforeEach(() => {
    jest.clearAllMocks()
    payCashOrderMock.mockResolvedValue({ paymentId: 'pay-1' } as Awaited<ReturnType<typeof orderMobileService.payCashOrder>>)
  })

  it.each([
    ['Android 2.23.0', true, 'ANDROID', '2.23.0'],
    ['Android 2.22.2', true, 'android', '2.22.2'],
    ['Windows 2.23.0-escritorio', true, 'ANDROID', '2.23.0-escritorio'],
    ['Android sin versión legible', true, 'ANDROID', 'desconocida'],
    ['Android 2.24.0 (ya trae el arreglo de H1)', false, 'ANDROID', '2.24.0'],
    ['Windows 2.25.0-escritorio', false, 'ANDROID', '2.25.0-escritorio'],
    ['iOS', false, 'IOS', '1.15.0'],
  ])('%s ⇒ colaConDefectoH1 = %s', async (_caso, esperado, plataforma, version) => {
    await payCash(reqCon({ 'x-device-platform': plataforma, 'x-app-version': version }), buildRes(), next)
    expect(marcaH1()).toBe(esperado)
  })

  it('Android sin la cabecera de versión ⇒ se trata como ≤ 2.23', async () => {
    await payCash(reqCon({ 'x-device-platform': 'ANDROID' }), buildRes(), next)
    expect(marcaH1()).toBe(true)
  })

  it('un cobro EN VIVO de Android 2.23 no es la cola: sin la marca', async () => {
    await payCash(reqCon({ 'x-device-platform': 'ANDROID', 'x-app-version': '2.23.0' }, { amount: 10000 }), buildRes(), next)
    expect(marcaH1()).toBe(false)
  })

  it('R2-6: la mesa ajena que dejó pasar la propiedad de mesa llega al servicio', async () => {
    const res = buildRes() as Response & { locals: Record<string, unknown> }
    res.locals = { mesaAjena: { ownerId: 'staff-beto', ownerName: 'Beto Bravo' } }
    await payCash(reqCon({ 'x-device-platform': 'IOS' }), res, next)
    expect(payCashOrderMock).toHaveBeenCalledWith(
      venueId,
      orderId,
      expect.objectContaining({ mesaAjena: { ownerId: 'staff-beto', ownerName: 'Beto Bravo' } }),
    )
  })
})
