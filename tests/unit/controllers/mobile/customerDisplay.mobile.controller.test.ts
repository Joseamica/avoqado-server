// tests/unit/controllers/mobile/customerDisplay.mobile.controller.test.ts
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

const getMobileCustomerDisplayMock = jest.fn()
const acknowledgeCustomerDisplayMock = jest.fn()
jest.mock('@/services/customer-display/customerDisplayMobile.service', () => ({
  ...jest.requireActual('@/services/customer-display/customerDisplayMobile.service'),
  getMobileCustomerDisplay: (...a: unknown[]) => getMobileCustomerDisplayMock(...a),
  acknowledgeCustomerDisplay: (...a: unknown[]) => acknowledgeCustomerDisplayMock(...a),
}))
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-auth-context']
    if (!raw) return void res.status(401).json({ message: 'No autorizado' })
    ;(req as any).authContext = JSON.parse(String(raw))
    next()
  },
}))
jest.mock('@/middlewares/validateVenueAccess.middleware', () => ({
  validateVenueAccess: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireVenueMembership: (req: Request, res: Response, next: NextFunction) => {
    const allowed: string[] = (req as any).authContext?.allowedVenueIds ?? []
    if (!allowed.includes(req.params.venueId)) return void res.status(403).json({ message: 'No tienes acceso' })
    next()
  },
}))

import mobileRoutes from '@/routes/mobile.routes'
import { NotFoundError } from '@/errors/AppError'

const VENUE = 'venue-1'
const auth = (allowed = [VENUE]) => ({ 'x-test-auth-context': JSON.stringify({ userId: 's1', venueId: VENUE, allowedVenueIds: allowed }) })
const app = () => {
  const a = express()
  a.use(express.json())
  a.use('/api/v1/mobile', mobileRoutes)
  a.use((e: any, _q: Request, s: Response, _n: NextFunction) => s.status(e.statusCode ?? 500).json({ code: e.code, message: e.message }))
  return a
}
const ack = {
  installationId: 'inst-1',
  fingerprint: 'a'.repeat(32),
  seq: 1,
  storedAt: '2026-09-25T17:00:00.000Z',
  shownAt: null,
  surface: null,
  imagesReady: 0,
  imagesPending: 0,
  imagesFailed: 0,
  unsupportedSchema: false,
}

beforeEach(() => jest.clearAllMocks())

describe('GET /customer-display', () => {
  it('401 sin sesión, 403 fuera del negocio, 400 sin X-Device-ID — sin tocar el servicio', async () => {
    expect((await request(app()).get(`/api/v1/mobile/venues/${VENUE}/customer-display`)).status).toBe(401)
    expect(
      (
        await request(app())
          .get(`/api/v1/mobile/venues/${VENUE}/customer-display`)
          .set(auth(['otro']))
          .set('x-device-id', 'd')
      ).status,
    ).toBe(403)
    const sinCabecera = await request(app()).get(`/api/v1/mobile/venues/${VENUE}/customer-display`).set(auth())
    expect(sinCabecera.status).toBe(400)
    expect(sinCabecera.body.code).toBe('DEVICE_ID_REQUIRED')
    expect(getMobileCustomerDisplayMock).not.toHaveBeenCalled()
  })

  it('pasa el deviceUid NORMALIZADO y responde { data: { terminalId, ficha, imageOrigins } }', async () => {
    getMobileCustomerDisplayMock.mockResolvedValue({ terminalId: 't1', ficha: { fingerprint: 'f' }, imageOrigins: ['https://x'] })
    const r = await request(app()).get(`/api/v1/mobile/venues/${VENUE}/customer-display`).set(auth()).set('x-device-id', '  dev-1  ')
    expect(getMobileCustomerDisplayMock).toHaveBeenCalledWith(VENUE, 'dev-1')
    expect(r.body).toEqual({ data: { terminalId: 't1', ficha: { fingerprint: 'f' }, imageOrigins: ['https://x'] } })
  })

  it('sin binding: el 404 estable que la app entiende («usa la fábrica»)', async () => {
    getMobileCustomerDisplayMock.mockRejectedValue(new NotFoundError('Dispositivo POS Android no encontrado.', 'DEVICE_NOT_FOUND'))
    const r = await request(app()).get(`/api/v1/mobile/venues/${VENUE}/customer-display`).set(auth()).set('x-device-id', 'dev-1')
    expect(r.status).toBe(404)
    expect(r.body.code).toBe('DEVICE_NOT_FOUND')
  })
})

describe('PUT /customer-display/ack', () => {
  it('valida la forma ANTES del servicio', async () => {
    const r = await request(app())
      .put(`/api/v1/mobile/venues/${VENUE}/customer-display/ack`)
      .set(auth())
      .set('x-device-id', 'd')
      .send({ ...ack, seq: -1 })
    expect(r.status).toBe(400)
    expect(acknowledgeCustomerDisplayMock).not.toHaveBeenCalled()
  })

  it.each([
    [{ accepted: true, current: true }],
    [{ accepted: true, current: false, currentFingerprint: 'b'.repeat(32) }],
    [{ accepted: false, reason: 'STALE_SEQ' }],
    [{ accepted: false, reason: 'OTHER_INSTALLATION' }],
  ])('responde 200 con %j tal cual', async resultado => {
    acknowledgeCustomerDisplayMock.mockResolvedValue(resultado)
    const r = await request(app())
      .put(`/api/v1/mobile/venues/${VENUE}/customer-display/ack`)
      .set(auth())
      .set('x-device-id', 'dev-1')
      .send(ack)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ data: resultado })
    expect(acknowledgeCustomerDisplayMock).toHaveBeenCalledWith(VENUE, 'dev-1', ack)
  })

  // Por la ruta real: `validateRequest` reemplaza el cuerpo por el normalizado, así que el servicio recibe null, no undefined.
  it('shownAt y surface omitidos (encodeDefaults=false): 200 y llegan al servicio en null', async () => {
    acknowledgeCustomerDisplayMock.mockResolvedValue({ accepted: true, current: true })
    const sinVacios: Record<string, unknown> = { ...ack }
    delete sinVacios.shownAt
    delete sinVacios.surface
    const r = await request(app())
      .put(`/api/v1/mobile/venues/${VENUE}/customer-display/ack`)
      .set(auth())
      .set('x-device-id', 'dev-1')
      .send(sinVacios)
    expect(r.status).toBe(200)
    expect(acknowledgeCustomerDisplayMock).toHaveBeenCalledWith(VENUE, 'dev-1', { ...sinVacios, shownAt: null, surface: null })
  })

  // R1 por la ruta real (la integración llama al servicio directo y no pasa por la validación).
  it('la ventana de Windows llega al servicio con su superficie (R1)', async () => {
    acknowledgeCustomerDisplayMock.mockResolvedValue({ accepted: true, current: true })
    const deWindows = { ...ack, surface: 'window', shownAt: '2026-09-25T17:00:01.000Z' }
    const r = await request(app())
      .put(`/api/v1/mobile/venues/${VENUE}/customer-display/ack`)
      .set(auth())
      .set('x-device-id', 'dev-1')
      .send(deWindows)
    expect(r.status).toBe(200)
    expect(acknowledgeCustomerDisplayMock).toHaveBeenCalledWith(VENUE, 'dev-1', deWindows)
  })
})
