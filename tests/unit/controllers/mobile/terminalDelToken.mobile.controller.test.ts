/**
 * «Cobrar sin red» (S6) — la frontera de mobile para la terminal: el serial que atribuye la orden y el pago sale del TOKEN
 * (`authContext.terminalSerialNumber`), nunca del body; y el pago acepta la hora de captura (`createdAtLocal`, epoch ms) como ya
 * la aceptaba crear orden.
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

const req = (body: Record<string, unknown>, authContext: Record<string, unknown>) =>
  ({
    params: { venueId: 'venue-1', orderId: 'order-1' },
    body: { staffId: 'staff-1', ...body },
    authContext: { userId: 'staff-1', ...authContext },
    headers: {},
  }) as unknown as Request

async function crear(body: Record<string, unknown>, authContext: Record<string, unknown> = {}) {
  await createOrder(req({ items: [{ productId: 'p1', quantity: 1 }], ...body }, authContext), buildRes(), jest.fn() as NextFunction)
  return createMock.mock.calls[0]?.[1]
}

async function pagar(body: Record<string, unknown>, authContext: Record<string, unknown> = {}) {
  await payCash(req({ amount: 5000, ...body }, authContext), buildRes(), jest.fn() as NextFunction)
  return payMock.mock.calls[0]?.[2]
}

beforeEach(() => {
  jest.clearAllMocks()
  createMock.mockResolvedValue({ id: 'order-1' })
  payMock.mockResolvedValue({ paymentId: 'pay-1' })
})

describe.each([
  ['crear orden', crear],
  ['pagar', pagar],
] as const)('%s — serial de la terminal', (_puerta, enviar) => {
  it('sale del token', async () => {
    expect((await enviar({}, { terminalSerialNumber: 'AVQD-2841548417' })).terminalSerialNumber).toBe('AVQD-2841548417')
  })

  it('el del body se ignora (sin serial en el token ⇒ sin serial)', async () => {
    expect((await enviar({ terminalSerialNumber: 'AVQD-2841548417' })).terminalSerialNumber ?? null).toBeNull()
  })
})

describe('pagar — createdAtLocal', () => {
  it('número o texto de dígitos llegan al servicio; otra cosa ⇒ ausente', async () => {
    expect((await pagar({ isOfflineReplay: true, createdAtLocal: 1792560036937 })).createdAtLocal).toBe(1792560036937)
    jest.clearAllMocks()
    expect((await pagar({ isOfflineReplay: true, createdAtLocal: '1792560036937' })).createdAtLocal).toBe('1792560036937')
    jest.clearAllMocks()
    expect((await pagar({ isOfflineReplay: true, createdAtLocal: { t: 1 } })).createdAtLocal ?? null).toBeNull()
  })
})

describe('pagar — edadDeLaVentaMs', () => {
  it('un número llega al servicio (el servicio decide si es válido); texto u otra cosa ⇒ ausente', async () => {
    expect((await pagar({ isOfflineReplay: true, edadDeLaVentaMs: 120000 })).edadDeLaVentaMs).toBe(120000)
    for (const edadDeLaVentaMs of ['120000', { ms: 1 }, null]) {
      jest.clearAllMocks()
      expect((await pagar({ isOfflineReplay: true, edadDeLaVentaMs })).edadDeLaVentaMs).toBeUndefined()
    }
  })
})
