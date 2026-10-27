import type { NextFunction, Request, Response } from 'express'
import { createOrder } from '@/controllers/mobile/order.mobile.controller'
import { checkCortesiaPermissionIfPresent } from '@/middlewares/cortesiaPidePermiso.middleware'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { createOrderWithItems } from '@/services/mobile/order.mobile.service'

let mockPermissionResult: 'granted' | 'denied' | 'error' = 'granted'

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: jest.fn(() => (_req: Request, res: Response, next: NextFunction) => {
    if (mockPermissionResult === 'denied') return res.status(403).json({ required: 'orders:comp' })
    if (mockPermissionResult === 'error') return next(new Error('permission-check-failed'))
    return next()
  }),
}))
jest.mock('@/middlewares/permissionFlag.middleware', () => ({ tienePermisoEnVenue: jest.fn() }))
jest.mock('@/services/mobile/order.mobile.service', () => ({ createOrderWithItems: jest.fn() }))

function request(): Request {
  return {
    params: { venueId: 'venue-original' },
    authContext: { userId: 'authenticated-cashier', overrideAuthorizedBy: 'manager-from-another-permission' },
    headers: { 'x-permission-override': 'single-use-token' },
    body: {
      staffId: 'selected-seller',
      items: [{ productId: 'product-1', quantity: 1, isCortesia: true, cortesiaReason: 'Invitación' }],
    },
  } as unknown as Request
}

function response() {
  const res: any = { statusCode: null }
  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn(() => res)
  return res as Response & { statusCode: number | null }
}

async function runController(req: Request) {
  const res = response()
  const next = jest.fn()
  await createOrder(req, res, next)
  return { res, next }
}

async function authorize(req: Request) {
  const res = response()
  const next = jest.fn()
  await checkCortesiaPermissionIfPresent(req, res, next)
  return { res, next }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPermissionResult = 'granted'
  ;(tienePermisoEnVenue as jest.Mock).mockResolvedValue(false)
  ;(createOrderWithItems as jest.Mock).mockResolvedValue({ id: 'order-1' })
})

describe('cortesía: acreditación del permiso en el mismo request', () => {
  it('reutiliza sólo el check exitoso de orders:comp; mantiene actor autenticado y no consume otro PIN', async () => {
    const req = request()
    const permission = await authorize(req)
    expect(permission.next).toHaveBeenCalledWith()
    const { res, next } = await runController(req)
    expect(res.statusCode).toBe(201)
    expect(next).not.toHaveBeenCalled()
    expect(checkPermission).toHaveBeenCalledTimes(1)
    expect(checkPermission).toHaveBeenCalledWith('orders:comp')
    expect(tienePermisoEnVenue).not.toHaveBeenCalled()
    expect(createOrderWithItems).toHaveBeenCalledWith(
      'venue-original',
      expect.objectContaining({ canCompItems: true, performedBy: 'authenticated-cashier', staffId: 'selected-seller' }),
    )
  })

  it.each(['denied', 'error'] as const)('un check %s no acredita permiso aunque alguien invoque el controller después', async outcome => {
    mockPermissionResult = outcome
    const req = request()
    await authorize(req)
    const { next } = await runController(req)
    expect((next.mock.calls[0]?.[0] as any)?.statusCode).toBe(403)
    expect(createOrderWithItems).not.toHaveBeenCalled()
  })

  it.each(['venueId', 'userId'] as const)('la acreditación no sirve si cambia %s después del check', async field => {
    const req = request()
    await authorize(req)
    if (field === 'venueId') req.params.venueId = 'another-venue'
    else req.authContext!.userId = 'another-cashier'
    const { next } = await runController(req)
    expect((next.mock.calls[0]?.[0] as any)?.statusCode).toBe(403)
    expect(createOrderWithItems).not.toHaveBeenCalled()
  })

  it('copiar las propiedades del request autorizado no transfiere la acreditación', async () => {
    const original = request()
    await authorize(original)
    const { next } = await runController({ ...original } as Request)
    expect((next.mock.calls[0]?.[0] as any)?.statusCode).toBe(403)
    expect(createOrderWithItems).not.toHaveBeenCalled()
  })

  it('body, header, override genérico y una propiedad inventada no acreditan orders:comp', async () => {
    const req = request()
    req.body.canCompItems = true
    req.body.cortesiaAutorizada = { venueId: req.params.venueId, permission: 'orders:comp' }
    ;(req as any).cortesiaAutorizada = req.body.cortesiaAutorizada
    const { next } = await runController(req)
    expect((next.mock.calls[0]?.[0] as any)?.statusCode).toBe(403)
    expect(createOrderWithItems).not.toHaveBeenCalled()
  })

  it('un check sin cortesía no autoriza una cortesía añadida después', async () => {
    const req = request()
    req.body.items[0].isCortesia = false
    await authorize(req)
    req.body.items[0].isCortesia = true
    const { next } = await runController(req)
    expect((next.mock.calls[0]?.[0] as any)?.statusCode).toBe(403)
    expect(checkPermission).not.toHaveBeenCalled()
    expect(createOrderWithItems).not.toHaveBeenCalled()
  })

  it('sin middleware conserva la autorización directa de la sesión', async () => {
    ;(tienePermisoEnVenue as jest.Mock).mockResolvedValue(true)
    const { res } = await runController(request())
    expect(res.statusCode).toBe(201)
    expect(tienePermisoEnVenue).toHaveBeenCalledWith(expect.anything(), 'orders:comp')
    expect(createOrderWithItems).toHaveBeenCalledTimes(1)
  })
})
