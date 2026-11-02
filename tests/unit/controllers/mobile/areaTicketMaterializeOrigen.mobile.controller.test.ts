/**
 * QA en iPhone (28-oct-2026, vales en iOS): todas las versiones publicadas de iOS mandan `source: "IOS"` al cobrar un vale
 * (`materialize-order`), y «IOS» no es un `OrderSource`: `prisma.order.create` tronaba y la caja veía 500 «No se pudo crear la
 * orden». En iOS no se podía cobrar ningún vale. El SERVIDOR acepta ese alias viejo como AVOQADO_IOS (las apps ya instaladas
 * cobran sin actualizarse) y contesta 400 claro ante un origen desconocido en vez de 500.
 */
import type { NextFunction, Request, Response } from 'express'

const materializeMock = jest.fn()
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  __esModule: true,
  materializeAreaTicketCheckout: (...a: unknown[]) => materializeMock(...a),
}))
jest.mock('@/middlewares/permissionFlag.middleware', () => ({
  __esModule: true,
  tienePermisoEnVenue: jest.fn().mockResolvedValue(false),
}))

import { materialize } from '@/controllers/mobile/areaTicketV7.mobile.controller'

const VENUE = 'cvenue000000000000000000a'
const SESION = 'csesion00000000000000000a'

function req(body: Record<string, unknown>): Request {
  return {
    params: { venueId: VENUE, sessionId: SESION },
    headers: { 'x-device-id': 'avq-device-1' },
    body: { idempotencyKey: 'llave-1', normalItems: [], ...body },
    authContext: { userId: 'cstaff000000000000000000a' },
  } as unknown as Request
}

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r as Response & { status: jest.Mock; json: jest.Mock }
}

async function cobrar(body: Record<string, unknown>) {
  const r = res()
  const next = jest.fn() as NextFunction & jest.Mock
  await materialize(req(body), r, next)
  return { r, next }
}

describe('materialize-order: origen de la orden del cobro de vales', () => {
  beforeEach(() => {
    materializeMock.mockReset().mockResolvedValue({ id: 'checkout-1' })
  })

  it('«IOS» (todas las versiones de iOS ya publicadas) se cobra como AVOQADO_IOS', async () => {
    const { r, next } = await cobrar({ source: 'IOS' })

    expect(next).not.toHaveBeenCalled()
    expect(materializeMock).toHaveBeenCalledTimes(1)
    expect(materializeMock.mock.calls[0][2].source).toBe('AVOQADO_IOS')
    expect(r.status).toHaveBeenCalledWith(200)
  })

  it('un origen desconocido es 400 con su razón, no 500, y no llega a crear la orden', async () => {
    const { r, next } = await cobrar({ source: 'PALM_PILOT' })

    expect(materializeMock).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(400)
    expect(r.json.mock.calls[0][0].error.code).toBe('INVALID_ORDER_SOURCE')
  })

  it.each(['AVOQADO_IOS', 'AVOQADO_ANDROID', 'TPV', 'POS'])('regresión: «%s» pasa tal cual', async source => {
    await cobrar({ source })

    expect(materializeMock.mock.calls[0][2].source).toBe(source)
  })

  it('regresión: sin origen se queda el de siempre del servicio (no se inventa uno)', async () => {
    await cobrar({})

    expect(materializeMock.mock.calls[0][2].source).toBeUndefined()
  })
})
