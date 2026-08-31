import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'

const createDisplayModeRequestMock = jest.fn()
const cancelDisplayModeRequestMock = jest.fn()
const permissionChecks: string[] = []

jest.mock('@/services/display-mode-request.service', () => {
  const actual = jest.requireActual('@/services/display-mode-request.service')
  return {
    ...actual,
    createDisplayModeRequest: (...args: unknown[]) => createDisplayModeRequestMock(...args),
    cancelDisplayModeRequest: (...args: unknown[]) => cancelDisplayModeRequestMock(...args),
  }
})

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-auth-context']
    const value = Array.isArray(raw) ? raw[0] : raw
    if (!value) {
      res.status(401).json({ message: 'No autorizado' })
      return
    }
    ;(req as any).authContext = JSON.parse(value)
    next()
  },
}))

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (permission: string) => (req: Request, res: Response, next: NextFunction) => {
    permissionChecks.push(permission)
    if (req.headers['x-test-permission'] !== permission) {
      res.status(403).json({ message: 'No tienes permiso' })
      return
    }
    next()
  },
}))

import { DisplayModeRequestError } from '@/services/display-mode-request.service'
import dashboardRoutes from '@/routes/dashboard.routes'

const VENUE_ID = 'venue-1'
const TERMINAL_ID = 'terminal-1'
const REQUEST_ID = 'request-1'
const NOW = new Date()
const ENDPOINT = `/api/v1/dashboard/venues/${VENUE_ID}/terminals/${TERMINAL_ID}/display-mode-request`

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/dashboard', dashboardRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    })
  })
  return app
}

function authHeaders(permission = 'tpv:update'): Record<string, string> {
  return {
    'x-test-auth-context': JSON.stringify({ userId: 'staff-1', venueId: VENUE_ID }),
    'x-test-permission': permission,
  }
}

function capableTerminal(overrides: Record<string, unknown> = {}) {
  return {
    id: TERMINAL_ID,
    venueId: VENUE_ID,
    type: 'POS_ANDROID',
    status: 'ACTIVE',
    customerDisplayPresent: true,
    customerDisplayInvertible: true,
    displayModeProtocolVersion: 1,
    capabilitiesObservedAt: NOW,
    customerDisplayInverted: false,
    customerDisplayRequest: null,
    customerDisplayRequestVersion: 0,
    customerDisplayRequestExpiresAt: null,
    ...overrides,
  }
}

function pendingResult(overrides: Record<string, unknown> = {}) {
  return {
    mutated: true,
    version: 1,
    customerDisplayInverted: false,
    request: {
      requestId: REQUEST_ID,
      desiredInverted: true,
      status: 'PENDING',
      requestedAt: NOW.toISOString(),
      requestedBy: 'staff-1',
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    },
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  permissionChecks.length = 0
  prismaMock.terminal.findFirst.mockResolvedValue(capableTerminal())
  createDisplayModeRequestMock.mockResolvedValue(pendingResult())
  cancelDisplayModeRequestMock.mockResolvedValue(
    pendingResult({ request: { ...pendingResult().request, status: 'CANCELLED', resolvedAt: NOW.toISOString() } }),
  )
})

describe('typed dashboard display-mode routes', () => {
  it('keeps authentication and tpv:update as separate route gates', async () => {
    const unauthenticated = await request(makeApp()).post(ENDPOINT).send({ desiredInverted: true })
    expect(unauthenticated.status).toBe(401)
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()

    const forbidden = await request(makeApp())
      .post(ENDPOINT)
      .set({ 'x-test-auth-context': authHeaders()['x-test-auth-context'] })
      .send({ desiredInverted: true })
    expect(forbidden.status).toBe(403)
    expect(permissionChecks).toContain('tpv:update')
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
  })

  it('rejects unknown POST keys before capability or state-machine work', async () => {
    const response = await request(makeApp()).post(ENDPOINT).set(authHeaders()).send({ desiredInverted: true, terminalId: 'forged' })

    expect(response.status).toBe(400)
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
    expect(createDisplayModeRequestMock).not.toHaveBeenCalled()
  })

  it('scopes the terminal to the venue and returns 404 instead of exposing another tenant', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null)

    const response = await request(makeApp()).post(ENDPOINT).set(authHeaders()).send({ desiredInverted: true })

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'DEVICE_NOT_FOUND' })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith({
      where: { id: TERMINAL_ID, venueId: VENUE_ID },
      select: expect.objectContaining({ id: true, type: true, customerDisplayPresent: true }),
    })
  })

  it.each([
    ['TPV_ANDROID', true, true, 1],
    ['POS_ANDROID', false, true, 1],
    ['POS_ANDROID', true, false, 1],
    ['POS_ANDROID', true, true, 2],
  ])('returns DEVICE_ACTION_UNSUPPORTED for unsupported hardware/protocol %#', async (type, present, invertible, protocol) => {
    prismaMock.terminal.findFirst.mockResolvedValue(
      capableTerminal({
        type,
        customerDisplayPresent: present,
        customerDisplayInvertible: invertible,
        displayModeProtocolVersion: protocol,
      }),
    )

    const response = await request(makeApp()).post(ENDPOINT).set(authHeaders()).send({ desiredInverted: true })

    expect(response.status).toBe(422)
    expect(response.body).toMatchObject({ code: 'DEVICE_ACTION_UNSUPPORTED' })
    expect(createDisplayModeRequestMock).not.toHaveBeenCalled()
  })

  it.each([
    { capabilitiesObservedAt: null },
    { capabilitiesObservedAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60_000) },
    { customerDisplayPresent: null },
    { customerDisplayInvertible: null },
    { displayModeProtocolVersion: null },
  ])('returns DEVICE_CAPABILITY_UNKNOWN for missing or stale capability facts %#', async overrides => {
    prismaMock.terminal.findFirst.mockResolvedValue(capableTerminal(overrides))

    const response = await request(makeApp()).post(ENDPOINT).set(authHeaders()).send({ desiredInverted: true })

    expect(response.status).toBe(422)
    expect(response.body).toMatchObject({ code: 'DEVICE_CAPABILITY_UNKNOWN' })
    expect(createDisplayModeRequestMock).not.toHaveBeenCalled()
  })

  it('creates a PENDING intent with protocol v1, returns 202, and does not write physical state directly', async () => {
    const response = await request(makeApp()).post(ENDPOINT).set(authHeaders()).send({ desiredInverted: true })

    expect(response.status).toBe(202)
    expect(response.body).toEqual({ data: pendingResult() })
    expect(createDisplayModeRequestMock).toHaveBeenCalledWith({
      venueId: VENUE_ID,
      terminalId: TERMINAL_ID,
      desiredInverted: true,
      requestedBy: 'staff-1',
    })
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
    expect(prismaMock.terminal.updateMany).not.toHaveBeenCalled()
  })

  it('maps Task 4 create conflicts to a stable 409 instead of a silent success', async () => {
    createDisplayModeRequestMock.mockRejectedValue(new DisplayModeRequestError('DISPLAY_MODE_CONFLICT', 'Otro cambio ganó la carrera.'))

    const response = await request(makeApp()).post(ENDPOINT).set(authHeaders()).send({ desiredInverted: true })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'DISPLAY_MODE_CONFLICT' })
  })

  it('cancels only the current request and returns the resolved aggregate', async () => {
    const response = await request(makeApp()).delete(`${ENDPOINT}/${REQUEST_ID}`).set(authHeaders())

    expect(response.status).toBe(200)
    expect(cancelDisplayModeRequestMock).toHaveBeenCalledWith({
      venueId: VENUE_ID,
      terminalId: TERMINAL_ID,
      requestId: REQUEST_ID,
      cancelledBy: 'staff-1',
    })
    expect(response.body.data.request).toMatchObject({ requestId: REQUEST_ID, status: 'CANCELLED' })
  })

  it('rejects unknown DELETE body keys before cancellation service work', async () => {
    const response = await request(makeApp()).delete(`${ENDPOINT}/${REQUEST_ID}`).set(authHeaders()).send({ desiredInverted: true })

    expect(response.status).toBe(400)
    expect(cancelDisplayModeRequestMock).not.toHaveBeenCalled()
  })

  it('maps a superseded cancellation to its stable Task 4 conflict code', async () => {
    cancelDisplayModeRequestMock.mockRejectedValue(
      new DisplayModeRequestError('DEVICE_REQUEST_SUPERSEDED', 'La solicitud ya no es la vigente.'),
    )

    const response = await request(makeApp()).delete(`${ENDPOINT}/${REQUEST_ID}`).set(authHeaders())

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'DEVICE_REQUEST_SUPERSEDED' })
  })

  it('returns CANCEL_TOO_LATE with confirmed physical state when cancellation cannot roll hardware back', async () => {
    cancelDisplayModeRequestMock.mockResolvedValue(
      pendingResult({
        mutated: false,
        customerDisplayInverted: true,
        disposition: 'TOO_LATE',
        resultCode: 'CANCEL_TOO_LATE',
        request: { ...pendingResult().request, status: 'APPLIED', resolvedAt: NOW.toISOString() },
      }),
    )

    const response = await request(makeApp()).delete(`${ENDPOINT}/${REQUEST_ID}`).set(authHeaders())

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({
      code: 'CANCEL_TOO_LATE',
      details: { customerDisplayInverted: true },
    })
  })
})
