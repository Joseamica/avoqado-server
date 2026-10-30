/**
 * 🔴 «Pagar después» como Toast (founder 26-oct): el alta de la cuenta del POS de ANDROID/iOS guarda si el cajero la mandó a
 * pagar después. El POS manda `paymentMethod: PAY_LATER` desde su botón «Pagar después» (ANDROID desde 2.0, iOS desde junio)
 * y su método (CARD, CASH…) en un cobro normal: si ese cobro falla, la cuenta NO es deuda del cliente. Sin método: null,
 * la regla de antes. Lectores: `shared/porCobrar.ts` (integración en tests/integration/customers/porCobrarComoToast).
 */

import type { NextFunction, Request, Response } from 'express'

import { createOrder } from '@/controllers/mobile/order.mobile.controller'
import * as orderMobileService from '@/services/mobile/order.mobile.service'
import { combinarPayLater, payLaterDesdeMetodoDePago } from '@/services/shared/porCobrar'

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

describe('createOrder — la marca «Pagar después» viaja al servicio', () => {
  const next = jest.fn() as NextFunction

  beforeEach(() => {
    jest.clearAllMocks()
    createOrderWithItemsMock.mockResolvedValue({ id: 'order-1' } as any)
  })

  it.each([
    ['PAY_LATER', true],
    ['CARD', false],
    ['CASH', false],
    [undefined, null],
  ])('paymentMethod %p → payLater %p', async (paymentMethod, payLater) => {
    const res = buildRes()
    await createOrder(buildReq(paymentMethod === undefined ? {} : { paymentMethod }), res, next)
    expect(res.statusCode).toBe(201)
    expect(createOrderWithItemsMock).toHaveBeenCalledWith('venue-1', expect.objectContaining({ payLater }))
  })
})

describe('payLaterDesdeMetodoDePago', () => {
  it('sólo PAY_LATER es fiado; cualquier otro método es cobro del momento; nada o basura es «no se sabe»', () => {
    expect(payLaterDesdeMetodoDePago('PAY_LATER')).toBe(true)
    expect(payLaterDesdeMetodoDePago(' pay_later ')).toBe(true)
    expect(payLaterDesdeMetodoDePago('CARD')).toBe(false)
    expect(payLaterDesdeMetodoDePago('')).toBeNull()
    expect(payLaterDesdeMetodoDePago(null)).toBeNull()
    expect(payLaterDesdeMetodoDePago(42)).toBeNull()
  })
})

describe('combinarPayLater (juntar dos cuentas)', () => {
  it('🔴 si una era fiado, lo que queda es fiado: la deuda no se esconde al juntar', () => {
    expect(combinarPayLater(false, true)).toBe(true)
    expect(combinarPayLater(true, null)).toBe(true)
  })
  it('«no se sabe» gana a «cobro del momento»; sólo dos cobros del momento dan cobro del momento', () => {
    expect(combinarPayLater(false, null)).toBeNull()
    expect(combinarPayLater(null, null)).toBeNull()
    expect(combinarPayLater(false, false)).toBe(false)
  })
})
