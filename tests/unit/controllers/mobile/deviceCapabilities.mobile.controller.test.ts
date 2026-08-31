import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'

const ensureDeviceTerminalMock = jest.fn()
const registerDeviceSeenMock = jest.fn()

jest.mock('@/services/mobile/deviceRegistry.service', () => ({
  __esModule: true,
  ensureDeviceTerminal: (...args: unknown[]) => ensureDeviceTerminalMock(...args),
  registerDeviceSeen: (...args: unknown[]) => registerDeviceSeenMock(...args),
}))

// Este archivo prueba la puerta HTTP real. La autenticación se sustituye sólo para
// poder expresar sesiones/scope sin acoplar el test al rollout de JWT revocables.
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-auth-context']
    const value = Array.isArray(raw) ? raw[0] : raw
    if (!value) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    ;(req as any).authContext = JSON.parse(value)
    next()
  },
}))

jest.mock('@/middlewares/validateVenueAccess.middleware', () => ({
  validateVenueAccess: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireVenueMembership: (req: Request, res: Response, next: NextFunction) => {
    const allowedVenueIds: string[] = (req as any).authContext?.allowedVenueIds ?? []
    if (!allowedVenueIds.includes(req.params.venueId)) {
      res.status(403).json({ success: false, message: 'No tienes acceso a este establecimiento' })
      return
    }
    next()
  },
}))

import { __resetDeviceSeenCache, registerDeviceMiddleware } from '@/middlewares/registerDevice.middleware'
import mobileRoutes from '@/routes/mobile.routes'

const VENUE = 'venue-1'
const STAFF = 'staff-1'
const DEVICE_UID = 'avq-device-7f3c9a21'
const ENDPOINT = `/api/v1/mobile/venues/${VENUE}/device-capabilities`

const validBody = {
  customerDisplay: { present: true, invertible: false },
  displayModeProtocolVersion: 1,
}

function authHeader(allowedVenueIds: string[] = [VENUE]): Record<string, string> {
  return {
    'x-test-auth-context': JSON.stringify({ userId: STAFF, venueId: VENUE, allowedVenueIds }),
  }
}

function deviceHeaders(): Record<string, string> {
  return {
    'x-device-id': `  ${DEVICE_UID}  `,
    'x-device-platform': 'android',
    'x-device-manufacturer': 'SUNMI',
    'x-device-model': 'T3_PRO',
    'x-device-form-factor': 'countertop_pos',
    'x-device-os-version': '13',
    'x-app-version': '2.8.0',
    'x-device-serial': 'SUNMI-123',
  }
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/mobile', mobileRoutes)
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.statusCode ?? 500).json({
      success: false,
      code: err.code,
      message: err.message,
    })
  })
  return app
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetDeviceSeenCache()
  ensureDeviceTerminalMock.mockResolvedValue({ terminalId: 'terminal-1', created: false, name: 'Sunmi T3 Pro' })
  registerDeviceSeenMock.mockResolvedValue({ terminalId: 'terminal-1', created: false, name: 'Sunmi T3 Pro' })
  prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 })
})

describe('PUT /mobile/venues/:venueId/device-capabilities', () => {
  it('responde 401 sin una sesión autenticada', async () => {
    const response = await request(makeApp()).put(ENDPOINT).set(deviceHeaders()).send(validBody)

    expect(response.status).toBe(401)
    expect(ensureDeviceTerminalMock).not.toHaveBeenCalled()
  })

  it('responde 400 si faltan los headers normalizados de identidad', async () => {
    const response = await request(makeApp()).put(ENDPOINT).set(authHeader()).send(validBody)

    expect(response.status).toBe(400)
    expect(ensureDeviceTerminalMock).not.toHaveBeenCalled()
  })

  it('responde 403 si el venue queda fuera del scope del staff autenticado', async () => {
    const response = await request(makeApp())
      .put(ENDPOINT)
      .set(authHeader(['venue-elsewhere']))
      .set(deviceHeaders())
      .send(validBody)

    expect(response.status).toBe(403)
    expect(ensureDeviceTerminalMock).not.toHaveBeenCalled()
  })

  it('acepta sólo el protocolo literal 1', async () => {
    const response = await request(makeApp())
      .put(ENDPOINT)
      .set(authHeader())
      .set(deviceHeaders())
      .send({ ...validBody, displayModeProtocolVersion: 2 })

    expect(response.status).toBe(400)
    expect(ensureDeviceTerminalMock).not.toHaveBeenCalled()
  })

  it('rechaza invertible=true cuando no existe pantalla de cliente', async () => {
    const response = await request(makeApp())
      .put(ENDPOINT)
      .set(authHeader())
      .set(deviceHeaders())
      .send({ ...validBody, customerDisplay: { present: false, invertible: true } })

    expect(response.status).toBe(400)
    expect(ensureDeviceTerminalMock).not.toHaveBeenCalled()
  })

  it('no permite que el cliente se autoconceda comandos remotos', async () => {
    const response = await request(makeApp())
      .put(ENDPOINT)
      .set(authHeader())
      .set(deviceHeaders())
      .send({ ...validBody, supportedRemoteCommands: ['RESTART'] })

    expect(response.status).toBe(400)
    expect(ensureDeviceTerminalMock).not.toHaveBeenCalled()
  })

  it('responde 200 sólo después de verificar el binding exacto de terminal, venue y deviceUid', async () => {
    const response = await request(makeApp()).put(ENDPOINT).set(authHeader()).set(deviceHeaders()).send(validBody)

    expect(response.status).toBe(200)
    expect(ensureDeviceTerminalMock).toHaveBeenCalledWith({
      venueId: VENUE,
      staffId: STAFF,
      identity: {
        deviceUid: DEVICE_UID,
        platform: 'ANDROID',
        manufacturer: 'SUNMI',
        modelIdentifier: 'T3_PRO',
        formFactor: 'COUNTERTOP_POS',
        osVersion: '13',
        appVersion: '2.8.0',
        serialNumber: 'SUNMI-123',
      },
    })
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
    const update = prismaMock.terminal.updateMany.mock.calls[0][0]
    expect(update.where).toEqual({ id: 'terminal-1', venueId: VENUE, deviceUid: DEVICE_UID, type: 'POS_ANDROID' })
    expect(update.data).toEqual({
      customerDisplayPresent: true,
      customerDisplayInvertible: false,
      displayModeProtocolVersion: 1,
      capabilitiesObservedAt: expect.any(Date),
      lastHeartbeat: expect.any(Date),
    })
    expect(update.data.lastHeartbeat).toBe(update.data.capabilitiesObservedAt)
    expect(response.body).toEqual({
      data: { terminalId: 'terminal-1', observedAt: update.data.capabilitiesObservedAt.toISOString() },
    })
    expect(registerDeviceSeenMock).not.toHaveBeenCalled()
  })

  it('rechaza atómicamente cuando el binding exacto dejó de existir antes de escribir', async () => {
    prismaMock.terminal.updateMany.mockResolvedValue({ count: 0 })

    const response = await request(makeApp()).put(ENDPOINT).set(authHeader()).set(deviceHeaders()).send(validBody)

    expect(response.status).toBe(403)
    expect(prismaMock.terminal.updateMany).toHaveBeenCalledWith({
      where: { id: 'terminal-1', venueId: VENUE, deviceUid: DEVICE_UID, type: 'POS_ANDROID' },
      data: expect.objectContaining({
        customerDisplayPresent: true,
        customerDisplayInvertible: false,
        displayModeProtocolVersion: 1,
      }),
    })
  })

  it('responde 503 retryable con código estable cuando el registro explícito no obtiene fila', async () => {
    ensureDeviceTerminalMock.mockResolvedValue(null)

    const response = await request(makeApp()).put(ENDPOINT).set(authHeader()).set(deviceHeaders()).send(validBody)

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ code: 'DEVICE_REGISTRY_UNAVAILABLE' })
    expect(prismaMock.terminal.updateMany).not.toHaveBeenCalled()
    // El finish hook reconoce que este PUT ya intentó el registro y no lo duplica.
    expect(registerDeviceSeenMock).not.toHaveBeenCalled()
  })
})

describe('aislamiento del error explícito respecto al middleware ordinario', () => {
  it('un fallo de registro pasivo no bloquea una ruta normal de login/pago', async () => {
    registerDeviceSeenMock.mockRejectedValue(new Error('base temporalmente caída'))
    const app = express()
    app.use(registerDeviceMiddleware)
    app.get('/ordinary', (req, res) => {
      ;(req as any).authContext = { venueId: VENUE, userId: STAFF }
      res.status(200).json({ ok: true })
    })

    const response = await request(app).get('/ordinary').set(deviceHeaders())
    await new Promise(resolve => setImmediate(resolve))

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
    expect(registerDeviceSeenMock).toHaveBeenCalledTimes(1)
  })
})
