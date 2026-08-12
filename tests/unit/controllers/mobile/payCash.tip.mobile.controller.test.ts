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
})
