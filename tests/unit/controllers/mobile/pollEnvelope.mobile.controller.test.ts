import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

const collectPollFingerprintsMock = jest.fn()
const peekEffectiveFingerprintMock = jest.fn()
jest.mock('@/services/customer-display/posPollFingerprints', () => ({
  ...jest.requireActual('@/services/customer-display/posPollFingerprints'),
  collectPollFingerprints: (...a: unknown[]) => collectPollFingerprintsMock(...a),
}))
jest.mock('@/services/customer-display/customerDisplayDesign.service', () => ({
  ...jest.requireActual('@/services/customer-display/customerDisplayDesign.service'),
  peekEffectiveFingerprint: (...a: unknown[]) => peekEffectiveFingerprintMock(...a),
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
import { POLL_TERMINAL_SELECT } from '@/services/customer-display/posPollFingerprints'

const VENUE = 'venue-1'
const URL = `/api/v1/mobile/venues/${VENUE}/display-mode-request`
const headers = {
  'x-test-auth-context': JSON.stringify({ userId: 's1', venueId: VENUE, allowedVenueIds: [VENUE] }),
  'x-device-id': 'dev-1',
}
const app = () => {
  const a = express()
  a.use(express.json())
  a.use('/api/v1/mobile', mobileRoutes)
  a.use((e: any, _q: Request, s: Response, _n: NextFunction) => s.status(e.statusCode ?? 500).json({ code: e.code, message: e.message }))
  return a
}
const fila = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  status: 'ACTIVE',
  customerDisplayRequest: null,
  customerDisplayRequestExpiresAt: null,
  customerDisplayDesignVersion: 1,
  customerDisplayInstallationId: 'inst-1',
  config: null,
  configOverrides: null,
  type: 'POS_ANDROID',
  defaultWorkspace: 'STANDARD_POS',
  fulfillmentAreaId: null,
  canIssueAreaTickets: false,
  canCheckoutAreaTickets: false,
  canDeliverAreaTickets: false,
  customerDisplayInverted: false,
  ...over,
})

beforeEach(() => {
  collectPollFingerprintsMock.mockReset().mockResolvedValue({ customerDisplay: 'c'.repeat(32), settings: 's'.repeat(32) })
  prismaMock.terminal.findFirst.mockReset().mockResolvedValue(fila() as any)
})

it('una sola lectura de la terminal, con el binding exacto y el select ampliado', async () => {
  await request(app()).get(URL).set(headers)
  expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(1)
  expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith({
    where: { venueId: VENUE, deviceUid: 'dev-1', type: 'POS_ANDROID' },
    select: POLL_TERMINAL_SELECT,
  })
})

it('el sobre SIEMPRE: huellas, lo que entiende el servidor y si pide un reporte', async () => {
  const r = await request(app()).get(URL).set(headers)
  expect(r.status).toBe(200)
  expect(r.body).toEqual({
    data: {
      terminalId: 't1',
      request: null,
      fingerprints: { customerDisplay: 'c'.repeat(32), settings: 's'.repeat(32) },
      capabilities: { customerDisplayDesign: 2 },
      capabilityReport: { requested: false },
    },
  })
})

it('🔴 PENDIENTE 1 DE F0-A: sin binding en la base, 404 — y NINGUNA caché se consulta', async () => {
  prismaMock.terminal.findFirst.mockResolvedValue(null)
  peekEffectiveFingerprintMock.mockReturnValue('ficha-de-una-terminal-que-se-mudó')
  const r = await request(app()).get(URL).set(headers)
  expect(r.status).toBe(404)
  expect(r.body.code).toBe('DEVICE_NOT_FOUND')
  expect(collectPollFingerprintsMock).not.toHaveBeenCalled()
  expect(peekEffectiveFingerprintMock).not.toHaveBeenCalled()
})

it('las huellas se piden con el id que devolvió la BASE, y con la solicitud como bandera', async () => {
  const pendiente = {
    requestId: 'r1',
    desiredInverted: true,
    status: 'PENDING',
    requestedAt: new Date().toISOString(),
    requestedBy: 's',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  prismaMock.terminal.findFirst.mockResolvedValueOnce(fila({ customerDisplayRequest: pendiente }) as any)
  await request(app()).get(URL).set(headers)
  expect(collectPollFingerprintsMock).toHaveBeenLastCalledWith({
    venueId: VENUE,
    terminal: expect.objectContaining({ id: 't1' }),
    hasRequest: true,
  })
  await request(app()).get(URL).set(headers) // la fila de siempre, sin solicitud
  expect(collectPollFingerprintsMock).toHaveBeenLastCalledWith({
    venueId: VENUE,
    terminal: expect.objectContaining({ id: 't1' }),
    hasRequest: false,
  })
})

it('🔴 PENDIENTE 2: una terminal recién mudada (sin versión ni instalación) pide el reporte', async () => {
  prismaMock.terminal.findFirst.mockResolvedValue(fila({ customerDisplayDesignVersion: null, customerDisplayInstallationId: null }) as any)
  const r = await request(app()).get(URL).set(headers)
  expect(r.body.data.capabilityReport).toEqual({ requested: true })
})

it('si las huellas revientan, el poll NO: la solicitud se entrega y las huellas salen vacías', async () => {
  collectPollFingerprintsMock.mockRejectedValue(new Error('inesperado'))
  const r = await request(app()).get(URL).set(headers)
  expect(r.status).toBe(200)
  expect(r.body.data.fingerprints).toEqual({})
})

it('el sobre cabe de sobra en el tope de 64 KB del cliente Android', async () => {
  const r = await request(app()).get(URL).set(headers)
  expect(Buffer.byteLength(JSON.stringify(r.body))).toBeLessThan(2_048)
})
