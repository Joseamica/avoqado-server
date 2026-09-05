/**
 * `POST /cash-drawer/open` — el controlador pasa la llave y la hora del aparato tal cual llegan, y
 * contesta el CÓDIGO honesto: 201 si la caja se creó con esta apertura, 200 si era un reintento y
 * la caja YA estaba. Es la MISMA regla de `idempotentStatus` que ya rige en `pay-in`/`pay-out`:
 * los dos clientes tratan cualquier 2xx como éxito, así que el 200 no rompe a nadie y le deja al
 * operador, en el log, la señal de «esto se registró una vez, no dos».
 *
 * Se prueba el CONTROLLER a propósito: es la frontera donde vive el código de estado, y la
 * validación de `startingAmount` que ya existía tiene que seguir cortando antes del servicio.
 */

import type { NextFunction, Request, Response } from 'express'

import { openSession } from '@/controllers/mobile/cash-drawer.mobile.controller'
import * as cashDrawerService from '@/services/mobile/cash-drawer.mobile.service'

jest.mock('@/services/mobile/cash-drawer.mobile.service', () => ({
  openSession: jest.fn(),
}))

const openSessionMock = cashDrawerService.openSession as jest.MockedFunction<typeof cashDrawerService.openSession>

const venueId = 'venue-123'
const staffId = 'staff-123'
const LLAVE = '5c3d1d2e-0b6a-4a1e-9f0e-6a1f6d3d9a11'
const ABRIO_A_LAS = '2026-09-05T16:22:00.000Z'

function buildRes() {
  const res = {} as Response & { statusCode?: number; payload?: unknown }
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

function buildReq(body: Record<string, unknown>) {
  return {
    params: { venueId },
    body,
    authContext: { userId: staffId },
    puedeVerEsperado: true,
  } as unknown as Request
}

const sesion = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cds-1',
    status: 'OPEN',
    shiftId: 'shift-1',
    cajaCreada: true,
    shiftCreado: true,
    localId: LLAVE,
    reintento: false,
    ...over,
  }) as unknown as Awaited<ReturnType<typeof cashDrawerService.openSession>>

describe('openSession (controller) — llave, hora y código de estado', () => {
  const next = jest.fn() as NextFunction

  beforeEach(() => {
    jest.clearAllMocks()
    openSessionMock.mockResolvedValue(sesion())
  })

  it('pasa localId y openedAt del cuerpo al servicio, y contesta 201 en una apertura nueva', async () => {
    const res = buildRes()
    await openSession(buildReq({ startingAmount: 500, deviceName: 'samsung SM-X133', localId: LLAVE, openedAt: ABRIO_A_LAS }), res, next)

    expect(openSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId,
        staffId,
        startingAmount: 500,
        deviceName: 'samsung SM-X133',
        localId: LLAVE,
        openedAt: ABRIO_A_LAS,
      }),
      true,
    )
    expect(res.statusCode).toBe(201)
    expect(res.payload).toEqual({ success: true, data: expect.objectContaining({ id: 'cds-1', localId: LLAVE, reintento: false }) })
    expect(next).not.toHaveBeenCalled()
  })

  it('🔴 un reintento contesta 200, no 201: la caja YA estaba (misma regla que pay-in/pay-out)', async () => {
    openSessionMock.mockResolvedValue(sesion({ reintento: true, shiftCreado: false }))
    const res = buildRes()

    await openSession(buildReq({ startingAmount: 500, localId: LLAVE }), res, next)

    expect(res.statusCode).toBe(200)
    expect(res.payload).toEqual({ success: true, data: expect.objectContaining({ id: 'cds-1', reintento: true }) })
  })

  it('REGRESIÓN — sin llave ni hora el servicio las recibe como undefined y el 201 es el de siempre', async () => {
    openSessionMock.mockResolvedValue(sesion({ localId: null }))
    const res = buildRes()

    await openSession(buildReq({ startingAmount: 500, deviceName: 'iPad' }), res, next)

    const [params] = openSessionMock.mock.calls[0]
    expect(params.localId).toBeUndefined()
    expect(params.openedAt).toBeUndefined()
    expect(res.statusCode).toBe(201)
  })

  it('REGRESIÓN — startingAmount ausente ⇒ 400 sin llamar al servicio', async () => {
    const res = buildRes()

    await openSession(buildReq({ localId: LLAVE, openedAt: ABRIO_A_LAS }), res, next)

    expect(res.statusCode).toBe(400)
    expect(openSessionMock).not.toHaveBeenCalled()
  })

  it('un error del servicio va a next(), no se traga', async () => {
    const boom = new Error('boom')
    openSessionMock.mockRejectedValue(boom)
    const res = buildRes()

    await openSession(buildReq({ startingAmount: 500 }), res, next)

    expect(next).toHaveBeenCalledWith(boom)
  })
})
