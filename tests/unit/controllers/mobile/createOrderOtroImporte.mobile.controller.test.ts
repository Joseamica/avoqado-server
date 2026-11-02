/**
 * Frontera del renglón «Otro importe» (sin productId): su precio no puede ser negativo.
 *
 * Un «Otro importe» de −$300 junto a una falda de $500 bajaba la venta a $200 con
 * sólo el permiso de crear pedidos, sin el de descuentos. La ruta de la terminal
 * ya lo exige (`tpv.schema.ts`, `unitPrice: z.number().nonnegative()`); aquí se
 * alinea el POS móvil. $0 sí se acepta: es un renglón válido (cortesía).
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

const venueId = 'venue-123'
const staffId = 'staff-123'

function buildRes() {
  const res = {} as Response & { statusCode?: number; payload?: any }
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

function buildReq(items: unknown[]) {
  return {
    params: { venueId },
    body: { staffId, items },
    authContext: { userId: staffId },
  } as unknown as Request
}

describe('createOrder — «Otro importe» con precio negativo', () => {
  const next = jest.fn() as NextFunction

  beforeEach(() => {
    jest.clearAllMocks()
    createOrderWithItemsMock.mockResolvedValue({ id: 'order-1' } as any)
  })

  it('rechaza con 400 un «Otro importe» negativo, sin invocar al servicio', async () => {
    const res = buildRes()

    await createOrder(
      buildReq([
        { productId: 'falda', quantity: 1 },
        { name: 'Otro importe', unitPrice: -30000, quantity: 1 },
      ]),
      res,
      next,
    )

    expect(res.statusCode).toBe(400)
    expect(res.payload.message).toMatch(/negativ/i)
    expect(createOrderWithItemsMock).not.toHaveBeenCalled()
  })

  it.each([0, 15000])('acepta un «Otro importe» de %d centavos', async unitPrice => {
    const res = buildRes()

    await createOrder(buildReq([{ name: 'Otro importe', unitPrice, quantity: 1 }]), res, next)

    expect(res.statusCode).toBe(201)
    expect(createOrderWithItemsMock).toHaveBeenCalled()
  })
})
