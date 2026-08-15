/**
 * Frontera de la venta rápida con promociones: qué items ACEPTA el controller.
 *
 * Se prueba el CONTROLLER a propósito (mismo criterio que
 * payCash.tip.mobile.controller.test.ts): la validación de items vive aquí, y
 * una línea de promoción no trae ni productId ni (name + unitPrice), así que
 * sin la excepción explícita el 400 mataba la feature antes de llegar al motor
 * — el combo nunca se aplicaba y el POS sólo veía "Cada item requiere
 * productId o (name + unitPrice)".
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

const promotionRef = { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [{ groupId: 'g1', optionId: 'o1' }] }

describe('createOrder — frontera de las líneas de promoción', () => {
  const next = jest.fn() as NextFunction

  beforeEach(() => {
    jest.clearAllMocks()
    createOrderWithItemsMock.mockResolvedValue({ id: 'order-1' } as any)
  })

  it('acepta una línea de promoción (sin productId, sin precio, sin quantity) y la pasa INTACTA al servicio', async () => {
    const res = buildRes()

    await createOrder(buildReq([{ productId: 'p1', quantity: 1 }, { promotionRef }]), res, next)

    expect(res.statusCode).toBe(201)
    expect(createOrderWithItemsMock).toHaveBeenCalledWith(
      venueId,
      expect.objectContaining({ items: [{ productId: 'p1', quantity: 1 }, { promotionRef }] }),
    )
  })

  it('acepta una venta de PURAS promociones', async () => {
    const res = buildRes()

    await createOrder(buildReq([{ promotionRef }]), res, next)

    expect(res.statusCode).toBe(201)
    expect(createOrderWithItemsMock).toHaveBeenCalled()
  })

  it('rechaza en español un promotionRef a medias, sin invocar al servicio', async () => {
    // Un ref sin instanceId entraría al motor con ids undefined y reventaría
    // como 500 DESPUÉS de crear la orden. Se corta en la frontera.
    const res = buildRes()

    await createOrder(buildReq([{ promotionRef: { promotionId: 'promo-1', selections: [] } }]), res, next)

    expect(res.statusCode).toBe(400)
    expect(res.payload.message).toContain('promotionRef requiere')
    expect(createOrderWithItemsMock).not.toHaveBeenCalled()
  })

  it('rechaza un promotionRef con selections que no es arreglo', async () => {
    const res = buildRes()

    await createOrder(buildReq([{ promotionRef: { ...promotionRef, selections: 'g1:o1' } }]), res, next)

    expect(res.statusCode).toBe(400)
    expect(createOrderWithItemsMock).not.toHaveBeenCalled()
  })

  // ── REGRESIÓN: la validación de siempre no se aflojó ──

  it('sigue rechazando un item normal sin productId ni (name + unitPrice)', async () => {
    const res = buildRes()

    await createOrder(buildReq([{ quantity: 1 }]), res, next)

    expect(res.statusCode).toBe(400)
    expect(res.payload.message).toContain('productId o (name + unitPrice)')
    expect(createOrderWithItemsMock).not.toHaveBeenCalled()
  })

  it('sigue rechazando quantity < 1 en un item normal', async () => {
    const res = buildRes()

    await createOrder(buildReq([{ productId: 'p1', quantity: 0 }]), res, next)

    expect(res.statusCode).toBe(400)
    expect(createOrderWithItemsMock).not.toHaveBeenCalled()
  })
})
