/**
 * D652 (founder, 13-nov: «1, por cobrar»): la TPV 2.14.0–2.16.1 sube su «Cobrar» sin red con cupón como `orderDiscountId: ""`
 * (`DiscountMappers.kt:68` deja el id vacío; `PedidoParaMobile.kt:52` lo manda tal cual). Sólo su cola —token de TERMINAL e
 * `isOfflineReplay: true`— lo toma como «sin descuento identificado»; una sesión del POS o una venta en línea siguen con el 400.
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

/** El cuerpo que arma `armarPedidoParaMobile` (v2.16.1) para $100 con un cupón del 10 %: cobró $90. */
const cuerpoDeLaTpv = (extra: Record<string, unknown> = {}) => ({
  staffId: 'staff-1',
  orderType: 'TAKEOUT',
  source: 'TPV',
  externalId: 'llave-1',
  subtotal: 10000,
  tip: 0,
  total: 9000,
  discount: 0,
  orderDiscountId: '',
  isOfflineReplay: true,
  createdAtLocal: 1762990000000,
  items: [{ externalId: 'llave-1:0', name: 'Otro importe', unitPrice: 10000, quantity: 1, modifierIds: [] }],
  ...extra,
})

const req = (body: Record<string, unknown>, terminalSerialNumber: string | null = 'AVQD-1') =>
  ({
    params: { venueId: 'venue-1' },
    headers: { 'x-app-version-code': '126' },
    body,
    authContext: { userId: 'staff-1', venueId: 'venue-1', ...(terminalSerialNumber ? { terminalSerialNumber } : {}) },
  }) as unknown as Request

describe('createOrder — D652: el cupón sin id de la TPV vieja', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    createOrderWithItemsMock.mockResolvedValue({ id: 'order-1' } as any)
  })

  it('🔴 cola de la terminal: entra sin descuento identificado y el servicio sabe cuánto cobró la terminal', async () => {
    const res = buildRes()
    await createOrder(req(cuerpoDeLaTpv()), res, jest.fn() as NextFunction)
    expect(res.statusCode).toBe(201)
    const input = createOrderWithItemsMock.mock.calls[0][1]
    expect(input.orderDiscountId).toBeNull()
    expect(input.discount).toBe(0)
    expect(input.cuponSinIdentificar).toEqual({ totalCents: 9000 })
  })

  it('🔴 una TPV ya actualizada reintenta el mismo cuerpo (build ≥ 127): también entra', async () => {
    const r = req(cuerpoDeLaTpv())
    r.headers['x-app-version-code'] = '131'
    await createOrder(r, buildRes(), jest.fn() as NextFunction)
    expect(createOrderWithItemsMock.mock.calls[0][1].cuponSinIdentificar).toEqual({ totalCents: 9000 })
  })

  it.each([
    ['una sesión del POS (sin serial de terminal)', cuerpoDeLaTpv(), null],
    ['una venta en línea de la terminal (sin isOfflineReplay)', cuerpoDeLaTpv({ isOfflineReplay: undefined }), 'AVQD-1'],
    ['isOfflineReplay que no es el true literal', cuerpoDeLaTpv({ isOfflineReplay: 'true' }), 'AVQD-1'],
    // Codex r1 #1: con un cupón que cubrió todo, la terminal paga $0 y ese cobro no cabe en una cuenta que debe: sigue como hoy.
    ['🔴 una venta en $0 (el cupón cubrió todo)', cuerpoDeLaTpv({ total: 0 }), 'AVQD-1'],
    ['un total que no es un entero de centavos', cuerpoDeLaTpv({ total: '90' }), 'AVQD-1'],
  ])('%s con `orderDiscountId: ""` ⇒ el 400 de hoy', async (_caso, body, serial) => {
    const res = buildRes()
    await createOrder(req(body, serial), res, jest.fn() as NextFunction)
    expect(res.statusCode).toBe(400)
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'orderDiscountId debe ser el id de un descuento' })
    expect(createOrderWithItemsMock).not.toHaveBeenCalled()
  })

  it('regresión: un id de catálogo real de la cola viaja tal cual y sin la marca', async () => {
    await createOrder(req(cuerpoDeLaTpv({ orderDiscountId: 'cmdescuento0000000000001' })), buildRes(), jest.fn() as NextFunction)
    const input = createOrderWithItemsMock.mock.calls[0][1]
    expect(input.orderDiscountId).toBe('cmdescuento0000000000001')
    expect(input).not.toHaveProperty('cuponSinIdentificar')
  })

  it('regresión: sin orderDiscountId, sin la marca', async () => {
    await createOrder(req(cuerpoDeLaTpv({ orderDiscountId: undefined })), buildRes(), jest.fn() as NextFunction)
    expect(createOrderWithItemsMock.mock.calls[0][1]).not.toHaveProperty('cuponSinIdentificar')
  })
})
