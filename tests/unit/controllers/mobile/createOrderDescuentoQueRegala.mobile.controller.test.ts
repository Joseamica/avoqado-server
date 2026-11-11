import type { NextFunction, Request, Response } from 'express'
import { createOrder } from '@/controllers/mobile/order.mobile.controller'
import { createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { membresiaDeQuienLlama } from '@/services/tpv/discount.tpv.service'
import { RegaloSinPermisoError } from '@/errors/AppError'

jest.mock('@/services/mobile/order.mobile.service', () => ({ createOrderWithItems: jest.fn() }))
jest.mock('@/middlewares/permissionFlag.middleware', () => ({ tienePermisoEnVenue: jest.fn() }))
jest.mock('@/services/tpv/discount.tpv.service', () => ({ membresiaDeQuienLlama: jest.fn() }))
// `checkPermission` (el 403 canónico con `overridable`, PIN incluido) se prueba de punta a punta en la integración HTTP.
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: () => (_req: Request, res: Response) => res.status(403).json({ required: 'orders:comp', overridable: true }),
}))

/**
 * hz:e0b12f00:D2: en `POST /mobile/.../orders`, el descuento de cuenta libre transporta la autoridad de la SESIÓN (nunca del vendedor
 * elegido) y la marca de la app; si el servicio dice que regala sin permiso, el controlador contesta el 403 canónico de `orders:comp`.
 */
function req(extra: Record<string, unknown> = {}) {
  return {
    params: { venueId: 'v1' },
    authContext: { userId: 'quien-cobra', venueId: 'v1' },
    body: { staffId: 'vendedor', items: [{ productId: 'p1', quantity: 1 }], discount: 10000, ...extra },
  } as unknown as Request
}

function res() {
  const value: any = { statusCode: null, body: null }
  value.status = jest.fn((code: number) => {
    value.statusCode = code
    return value
  })
  value.json = jest.fn((body: unknown) => {
    value.body = body
    return value
  })
  return value as Response & { statusCode: number; body: any }
}

describe('createOrder — el «Descuento de la cuenta» que regala (D2)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(createOrderWithItems as jest.Mock).mockResolvedValue({ id: 'o1' })
    ;(membresiaDeQuienLlama as jest.Mock).mockResolvedValue('sv-quien-cobra')
  })

  it('con orders:comp: autoriza la membresía de QUIEN COBRA, no la del vendedor elegido', async () => {
    ;(tienePermisoEnVenue as jest.Mock).mockResolvedValue(true)
    const response = res()
    await createOrder(req({ cortesiaDeCuentaConPin: true }), response, jest.fn() as NextFunction)
    expect(membresiaDeQuienLlama).toHaveBeenCalledWith('v1', 'quien-cobra')
    expect(createOrderWithItems).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({
        canCompItems: true,
        performedBy: 'quien-cobra',
        regaloAutorizadoPor: 'sv-quien-cobra',
        cortesiaDeCuentaConPin: true,
      }),
    )
    expect(response.statusCode).toBe(201)
  })

  it('sin permiso: llega sin autoridad ni autorizador, y la marca sólo si es el `true` literal', async () => {
    ;(tienePermisoEnVenue as jest.Mock).mockResolvedValue(false)
    await createOrder(req({ cortesiaDeCuentaConPin: 'true', canCompItems: true, regaloAutorizadoPor: 'falso' }), res(), jest.fn())
    expect(membresiaDeQuienLlama).not.toHaveBeenCalled()
    const input = (createOrderWithItems as jest.Mock).mock.calls[0][1]
    expect(input).toMatchObject({ canCompItems: false, performedBy: 'quien-cobra', cortesiaDeCuentaConPin: false })
    expect(input.regaloAutorizadoPor).toBeUndefined()
  })

  it('🔴 el servicio dice que regala sin permiso: 403 canónico de orders:comp (con el PIN), sin 201', async () => {
    ;(tienePermisoEnVenue as jest.Mock).mockResolvedValue(false)
    ;(createOrderWithItems as jest.Mock).mockRejectedValue(new RegaloSinPermisoError())
    const response = res()
    const next = jest.fn()
    await createOrder(req({ cortesiaDeCuentaConPin: true }), response, next)
    expect(next).not.toHaveBeenCalled()
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual({ required: 'orders:comp', overridable: true })
  })

  it('una venta sin descuento de cuenta no paga ninguna consulta por esta regla', async () => {
    await createOrder(req({ discount: 0 }), res(), jest.fn())
    expect(tienePermisoEnVenue).not.toHaveBeenCalled()
    expect(membresiaDeQuienLlama).not.toHaveBeenCalled()
  })

  it('un cupón en línea no es descuento libre: no resuelve autorizador de regalo', async () => {
    ;(tienePermisoEnVenue as jest.Mock).mockResolvedValue(true)
    await createOrder(req({ couponCode: 'DESC10' }), res(), jest.fn())
    expect(membresiaDeQuienLlama).not.toHaveBeenCalled()
  })
})
