import type { NextFunction, Request, Response } from 'express'
import { createOrder } from '@/controllers/mobile/order.mobile.controller'
import { createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'

jest.mock('@/services/mobile/order.mobile.service', () => ({ createOrderWithItems: jest.fn() }))
jest.mock('@/middlewares/permissionFlag.middleware', () => ({ tienePermisoEnVenue: jest.fn() }))

function req(item: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    params: { venueId: 'v1' },
    authContext: { userId: 'authenticated-manager' },
    body: { staffId: 'selected-seller', items: [{ productId: 'p1', quantity: 1, ...item }], ...extra },
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

describe('createOrder — cortesía autorizada por la sesión, no por el vendedor elegido', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(createOrderWithItems as jest.Mock).mockResolvedValue({ id: 'o1' })
    ;(tienePermisoEnVenue as jest.Mock).mockResolvedValue(true)
  })

  it('pasa los flags intactos y la autorización/actor calculados por el servidor', async () => {
    const item = { externalId: 'local-line', isCortesia: true, cortesiaReason: 'Invitación' }
    const request = req(item)
    const response = res()
    await createOrder(request, response, jest.fn() as NextFunction)
    expect(tienePermisoEnVenue).toHaveBeenCalledWith(request, 'orders:comp')
    expect(createOrderWithItems).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({
        staffId: 'selected-seller',
        performedBy: 'authenticated-manager',
        canCompItems: true,
        items: [{ productId: 'p1', quantity: 1, ...item }],
      }),
    )
    expect(response.statusCode).toBe(201)
  })

  it('sin permiso ni canCompItems falsificado en el body alcanza el servicio', async () => {
    ;(tienePermisoEnVenue as jest.Mock).mockResolvedValue(false)
    const response = res()
    const next = jest.fn()
    await createOrder(req({ isCortesia: true, cortesiaReason: 'Invitación' }, { canCompItems: true }), response, next)
    expect(createOrderWithItems).not.toHaveBeenCalled()
    expect(response.statusCode === 403 || (next.mock.calls[0]?.[0] as any)?.statusCode === 403).toBe(true)
  })

  it.each([
    { isCortesia: 'true', cortesiaReason: 'Invitación' },
    { isCortesia: 1, cortesiaReason: 'Invitación' },
    { isCortesia: true, cortesiaReason: '   ' },
    { isCortesia: true, cortesiaReason: 123 },
    { isCortesia: true, cortesiaReason: 'Invitación', discountId: 'd1' },
    { isCortesia: true, cortesiaReason: 'Invitación', promotionRef: { promotionId: 'p', promotionInstanceId: 'i', selections: [] } },
  ])('rechaza el contrato ambiguo o inválido antes del servicio (%j)', async item => {
    const response = res()
    const next = jest.fn()
    await createOrder(req(item), response, next)
    expect(createOrderWithItems).not.toHaveBeenCalled()
    expect(response.statusCode === 400 || (next.mock.calls[0]?.[0] as any)?.statusCode === 400).toBe(true)
  })

  it('una venta normal conserva el vendedor y no consulta permiso de cortesía', async () => {
    const response = res()
    await createOrder(req({}), response, jest.fn() as NextFunction)
    expect(response.statusCode).toBe(201)
    expect(tienePermisoEnVenue).not.toHaveBeenCalled()
    expect(createOrderWithItems).toHaveBeenCalledWith('v1', expect.objectContaining({ staffId: 'selected-seller' }))
  })

  it('cruce D2/S3: cortesía en replay conserva caja y turno originales junto al permiso de la sesión', async () => {
    const request = req(
      { externalId: 'local-line', isCortesia: true, cortesiaReason: 'Invitación' },
      { externalId: 'folio-original', isOfflineReplay: true, cashDrawerSessionId: 'caja-A', shiftIdDeLaVenta: 'turno-A' },
    )
    const response = res()
    const next = jest.fn()
    await createOrder(request, response, next)
    expect(next).not.toHaveBeenCalled()
    expect(response.statusCode).toBe(201)
    expect(createOrderWithItems).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({
        externalId: 'folio-original',
        isOfflineReplay: true,
        cashDrawerSessionId: 'caja-A',
        shiftIdDeLaVenta: 'turno-A',
        canCompItems: true,
        performedBy: 'authenticated-manager',
        staffId: 'selected-seller',
        items: [expect.objectContaining({ isCortesia: true, cortesiaReason: 'Invitación', externalId: 'local-line' })],
      }),
    )
  })

  it.each(['cashDrawerSessionId', 'shiftIdDeLaVenta'])('cruce D2/S3: cortesía no elude la forma de %s', async field => {
    const response = res()
    const next = jest.fn()
    await createOrder(
      req({ isCortesia: true, cortesiaReason: 'Invitación' }, { isOfflineReplay: true, [field]: { id: 'original' } }),
      response,
      next,
    )
    expect(createOrderWithItems).not.toHaveBeenCalled()
    expect(response.statusCode === 400 || (next.mock.calls[0]?.[0] as any)?.statusCode === 400).toBe(true)
  })

  it('cruce D2/S3: tener caja/turno originales no concede el permiso de cortesía', async () => {
    ;(tienePermisoEnVenue as jest.Mock).mockResolvedValue(false)
    const response = res()
    const next = jest.fn()
    await createOrder(
      req(
        { isCortesia: true, cortesiaReason: 'Invitación' },
        { isOfflineReplay: true, cashDrawerSessionId: 'caja-A', shiftIdDeLaVenta: 'turno-A', canCompItems: true },
      ),
      response,
      next,
    )
    expect(createOrderWithItems).not.toHaveBeenCalled()
    expect(response.statusCode === 403 || (next.mock.calls[0]?.[0] as any)?.statusCode === 403).toBe(true)
  })
})
