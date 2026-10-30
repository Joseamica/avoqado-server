/**
 * 🔴 S3 «Efectivo sin red en el turno correcto» — la frontera de `cashDrawerSessionId` en las dos puertas de mobile (crear orden y
 * pagar). Es la caja que el POS (ANDROID/iOS) tenía abierta al cobrar; el servicio la convierte en el turno de la venta.
 *
 * Igual que `shiftIdDeLaVenta`: sólo cuenta en un REPLAY de la cola (`isOfflineReplay: true` literal) y su forma es texto de hasta 64;
 * otra cosa es un 400 visible.
 */
import type { NextFunction, Request, Response } from 'express'

import { createOrder, payCash } from '@/controllers/mobile/order.mobile.controller'
import * as orderMobileService from '@/services/mobile/order.mobile.service'

jest.mock('@/services/mobile/order.mobile.service', () => ({
  createOrderWithItems: jest.fn(),
  payCashOrder: jest.fn(),
}))

const createMock = orderMobileService.createOrderWithItems as jest.Mock
const payMock = orderMobileService.payCashOrder as jest.Mock

function buildRes() {
  const res = {} as Response & { statusCode?: number }
  res.status = jest.fn().mockImplementation((code: number) => {
    res.statusCode = code
    return res
  }) as unknown as Response['status']
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json']
  return res
}

const req = (body: Record<string, unknown>) =>
  ({
    params: { venueId: 'venue-1', orderId: 'order-1' },
    body: { staffId: 'staff-1', ...body },
    authContext: { userId: 'staff-1' },
    headers: {},
  }) as unknown as Request

async function crear(body: Record<string, unknown>) {
  const res = buildRes()
  await createOrder(req({ items: [{ productId: 'p1', quantity: 1 }], ...body }), res, jest.fn() as NextFunction)
  return { status: res.statusCode, enviado: createMock.mock.calls[0]?.[1] }
}

async function pagar(body: Record<string, unknown>) {
  const res = buildRes()
  await payCash(req({ amount: 5000, ...body }), res, jest.fn() as NextFunction)
  return { status: res.statusCode, enviado: payMock.mock.calls[0]?.[2] }
}

const CAJA = 'cmcajaa00000000000000000'

beforeEach(() => {
  jest.clearAllMocks()
  createMock.mockResolvedValue({ id: 'order-1' })
  payMock.mockResolvedValue({ paymentId: 'pay-1' })
})

describe.each([
  ['crear orden', crear, null],
  ['pagar', pagar, undefined],
] as const)('%s — cashDrawerSessionId', (_puerta, enviar, ausente) => {
  it('en un replay de la cola llega al servicio', async () => {
    const { status, enviado } = await enviar({ isOfflineReplay: true, cashDrawerSessionId: CAJA })
    expect(status).toBeLessThan(300)
    expect(enviado.cashDrawerSessionId).toBe(CAJA)
  })

  it('sin isOfflineReplay (o no literal) se ignora: como hoy', async () => {
    for (const isOfflineReplay of [undefined, false, 'true']) {
      jest.clearAllMocks()
      const { status, enviado } = await enviar({ isOfflineReplay, cashDrawerSessionId: CAJA })
      expect(status).toBeLessThan(300)
      expect(enviado.cashDrawerSessionId).toBe(ausente)
    }
  })

  it('vacío o null ⇒ ausente', async () => {
    for (const cashDrawerSessionId of ['', null]) {
      jest.clearAllMocks()
      const { enviado } = await enviar({ isOfflineReplay: true, cashDrawerSessionId })
      expect(enviado.cashDrawerSessionId).toBe(ausente)
    }
  })

  it('más de 64 caracteres o no texto ⇒ 400 y NO llama al servicio', async () => {
    for (const cashDrawerSessionId of ['x'.repeat(65), 42, { id: CAJA }]) {
      jest.clearAllMocks()
      const { status } = await enviar({ isOfflineReplay: true, cashDrawerSessionId })
      expect(status).toBe(400)
      expect(createMock).not.toHaveBeenCalled()
      expect(payMock).not.toHaveBeenCalled()
    }
  })

  it('con turno y caja a la vez, llegan los dos (el servicio decide)', async () => {
    const { enviado } = await enviar({ isOfflineReplay: true, cashDrawerSessionId: CAJA, shiftIdDeLaVenta: 'cmturnoa0000000000000000' })
    expect(enviado.cashDrawerSessionId).toBe(CAJA)
    expect(enviado.shiftIdDeLaVenta).toBe('cmturnoa0000000000000000')
  })
})
