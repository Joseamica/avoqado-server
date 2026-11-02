/**
 * 🔴 DINERO — la frontera de «se cobra el precio que vio el cliente».
 *
 * La cola sin red manda `isOfflineReplay: true` («la venta ya ocurrió»: nunca 409) y `createdAtLocal` (hora de la captura).
 * Sólo el `true` literal cuenta como cola: cualquier otra cosa es una venta en línea (la que sí puede recibir el 409, y se
 * corrige ANTES de cobrar). Los campos de línea (`displayedUnitPrice`, `catalogAt`) no se validan aquí: la basura la ignora
 * el servicio, nunca un 400.
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

const LINEA = { productId: 'p1', quantity: 1, externalId: 'e1', displayedUnitPrice: 4500, catalogAt: '2026-10-17T15:00:00.000Z' }

function buildReq(extra: Record<string, unknown>) {
  return {
    params: { venueId: 'venue-1' },
    body: { staffId: 'staff-1', items: [LINEA], ...extra },
    authContext: { userId: 'staff-1' },
  } as unknown as Request
}

async function enviado(extra: Record<string, unknown>) {
  const res = buildRes()
  await createOrder(buildReq(extra), res, jest.fn() as NextFunction)
  expect(res.statusCode).toBe(201)
  return createOrderWithItemsMock.mock.calls[0][1]
}

describe('createOrder — cola y hora de la venta para el precio que vio el cliente', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    createOrderWithItemsMock.mockResolvedValue({ id: 'order-1' } as any)
  })

  it('isOfflineReplay: true llega como true', async () => {
    expect((await enviado({ isOfflineReplay: true })).isOfflineReplay).toBe(true)
  })

  it('🔴 sólo el true literal cuenta: "true", 1 o ausente es una venta en línea', async () => {
    for (const valor of ['true', 1, undefined, null]) {
      createOrderWithItemsMock.mockClear()
      expect((await enviado({ isOfflineReplay: valor })).isOfflineReplay).toBe(false)
    }
  })

  it('createdAtLocal llega si es número o texto; si no, null', async () => {
    expect((await enviado({ createdAtLocal: 1_760_700_000_000 })).createdAtLocal).toBe(1_760_700_000_000)
    createOrderWithItemsMock.mockClear()
    expect((await enviado({ createdAtLocal: '1760700000000' })).createdAtLocal).toBe('1760700000000')
    for (const valor of [{ a: 1 }, [1], true, undefined, null]) {
      createOrderWithItemsMock.mockClear()
      expect((await enviado({ createdAtLocal: valor })).createdAtLocal).toBeNull()
    }
  })

  it('items[] llega intacto (precio mostrado, catálogo e identidad de línea), también con basura', async () => {
    expect((await enviado({})).items).toEqual([LINEA])
    createOrderWithItemsMock.mockClear()
    const basura = { ...LINEA, displayedUnitPrice: 'x', catalogAt: 42 }
    const res = buildRes()
    await createOrder(buildReq({ items: [basura], isOfflineReplay: true }), res, jest.fn() as NextFunction)
    expect(res.statusCode).toBe(201)
    expect(createOrderWithItemsMock.mock.calls[0][1].items).toEqual([basura])
  })

  // Task S3: los precios de extras que vio el cliente son un campo de LÍNEA más; el servicio los valida
  // (`precioDeExtraMostrado`: objeto de centavos enteros ≥ 0 por id de extra) y la basura se ignora, nunca un 400.
  it.each([
    ['válido', { 'mod-1': 1000, 'mod-2': 0 }],
    ['arreglo', [1000]],
    ['texto', 'x'],
    ['negativo', { 'mod-1': -1 }],
    ['null', null],
  ])('displayedModifierPrices %s llega intacto y la venta sigue (201)', async (_, valor) => {
    const linea = { ...LINEA, modifierIds: ['mod-1'], displayedModifierPrices: valor }
    const res = buildRes()
    await createOrder(buildReq({ items: [linea] }), res, jest.fn() as NextFunction)
    expect(res.statusCode).toBe(201)
    expect(createOrderWithItemsMock.mock.calls[0][1].items).toEqual([linea])
  })
})
