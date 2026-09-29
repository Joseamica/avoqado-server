/**
 * 🔴 DINERO — el premio de cartilla sólo se canjea si la caja sabe DESCONTARLO.
 *
 * Hasta Android 2.19.1 / iOS 1.12.0 la caja mandaba `stampRewardId` pero seguía
 * cobrando el precio completo: el servidor quemaba el premio, bajaba la cuenta y el
 * cliente pagaba de más (en iOS con cualquier método, en Android con tarjeta). Esas
 * versiones siguen instaladas durante días.
 *
 * Por eso la caja nueva declara `stampRewardAware: true` —"yo resto el premio de lo que
 * cobro"— y SÓLO entonces el servidor lo canjea. A una caja vieja el premio se le
 * ignora: cobra completo, pero el premio NO se quema y el cliente lo conserva.
 */

import type { NextFunction, Request, Response } from 'express'

import { createOrder } from '@/controllers/mobile/order.mobile.controller'
import * as orderMobileService from '@/services/mobile/order.mobile.service'

jest.mock('@/services/mobile/order.mobile.service', () => ({
  createOrderWithItems: jest.fn(),
}))

const createOrderWithItemsMock = orderMobileService.createOrderWithItems as jest.MockedFunction<
  typeof orderMobileService.createOrderWithItems
>

function buildRes() {
  const res = {} as Response & { statusCode?: number }
  res.status = jest.fn().mockImplementation((code: number) => {
    res.statusCode = code
    return res
  }) as unknown as Response['status']
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json']
  return res
}

function buildReq(extra: Record<string, unknown>) {
  return {
    params: { venueId: 'venue-1' },
    body: { staffId: 'staff-1', items: [{ productId: 'p1', quantity: 1 }], customerId: 'c1', ...extra },
    authContext: { userId: 'staff-1' },
  } as unknown as Request
}

describe('createOrder — el premio de cartilla sólo se canjea para una caja que lo descuenta', () => {
  const next = jest.fn() as NextFunction

  beforeEach(() => {
    jest.clearAllMocks()
    createOrderWithItemsMock.mockResolvedValue({ id: 'order-1' } as any)
  })

  it('una caja que declara stampRewardAware manda el premio al servicio', async () => {
    const res = buildRes()

    await createOrder(buildReq({ stampRewardId: 'rw1', stampRewardAware: true }), res, next)

    expect(res.statusCode).toBe(201)
    expect(createOrderWithItemsMock).toHaveBeenCalledWith('venue-1', expect.objectContaining({ stampRewardId: 'rw1' }))
  })

  it('🔴 una caja VIEJA (sin stampRewardAware) no quema el premio: la venta se crea sin él', async () => {
    const res = buildRes()

    await createOrder(buildReq({ stampRewardId: 'rw1' }), res, next)

    expect(res.statusCode).toBe(201)
    expect(createOrderWithItemsMock).toHaveBeenCalledWith('venue-1', expect.objectContaining({ stampRewardId: null }))
  })

  it('🔴 sólo el booleano true cuenta: un "true" de texto no abre el canje', async () => {
    const res = buildRes()

    await createOrder(buildReq({ stampRewardId: 'rw1', stampRewardAware: 'true' }), res, next)

    expect(createOrderWithItemsMock).toHaveBeenCalledWith('venue-1', expect.objectContaining({ stampRewardId: null }))
  })

  it('lo que la caja descontó al cobrar viaja al servicio (para dejar rastro si no coincide)', async () => {
    const res = buildRes()

    await createOrder(buildReq({ stampRewardId: 'rw1', stampRewardAware: true, stampRewardExpectedDiscount: 3000 }), res, next)

    expect(createOrderWithItemsMock).toHaveBeenCalledWith(
      'venue-1',
      expect.objectContaining({ stampRewardId: 'rw1', stampRewardExpectedDiscount: 3000 }),
    )
  })

  it('sin premio, todo queda como siempre', async () => {
    const res = buildRes()

    await createOrder(buildReq({ stampRewardAware: true }), res, next)

    expect(res.statusCode).toBe(201)
    expect(createOrderWithItemsMock).toHaveBeenCalledWith('venue-1', expect.objectContaining({ stampRewardId: null }))
  })
})
