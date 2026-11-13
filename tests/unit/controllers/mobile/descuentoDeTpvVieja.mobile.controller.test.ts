/**
 * D2 · B (coordinador, 12-nov): `POST /mobile/orders` marca la venta de una TPV que trunca el % de catálogo (builds 123–126, sin
 * `X-Device-Platform`) para que el servicio registre lo que esa terminal ya cobró. Sin encabezado o con un POS, sin marca.
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

const req = (headers: Record<string, string>, terminalSerialNumber: string | null = 'AVQD-1') =>
  ({
    params: { venueId: 'venue-1' },
    headers,
    body: {
      staffId: 'staff-1',
      source: 'TPV',
      isOfflineReplay: true,
      total: 1922,
      items: [{ name: 'Otro importe', unitPrice: 2135, quantity: 1 }],
    },
    authContext: { userId: 'staff-1', ...(terminalSerialNumber ? { terminalSerialNumber } : {}) },
  }) as unknown as Request

describe('createOrder — la marca de la TPV que trunca el descuento', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    createOrderWithItemsMock.mockResolvedValue({ id: 'order-1' } as any)
  })
  it.each([
    ['TPV 2.16.0', { 'x-app-version-code': '125' }, true],
    ['TPV 2.16.1', { 'x-app-version-code': '126' }, true],
    ['TPV 2.16.2', { 'x-app-version-code': '127' }, false],
    ['sin encabezado', {}, false],
    ['versión ilegible', { 'x-app-version-code': 'v2' }, false],
    ['ANDROID con build 125', { 'x-app-version-code': '125', 'x-device-platform': 'ANDROID' }, false],
  ])('%s ⇒ %s', async (_caso, headers, marca) => {
    await createOrder(req(headers), buildRes(), jest.fn() as NextFunction)
    expect(createOrderWithItemsMock).toHaveBeenCalledWith(
      'venue-1',
      expect.objectContaining({ ventaDeTerminal: { truncaPorVersion: marca, totalCents: 1922 } }),
    )
  })
  it('🔴 Codex r2 #1: sin el token de una terminal (una sesión del POS), nada de la excepción aunque mande encabezado y cuerpo de TPV', async () => {
    await createOrder(req({ 'x-app-version-code': '125' }, null), buildRes(), jest.fn() as NextFunction)
    expect(createOrderWithItemsMock.mock.calls[0][1]).not.toHaveProperty('ventaDeTerminal')
  })
})
