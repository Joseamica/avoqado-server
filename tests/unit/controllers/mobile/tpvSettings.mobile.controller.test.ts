/**
 * Mobile TPV Settings controller — plan-tier info on the venue-settings payload.
 *
 * Context (2026-06): POS apps (iOS + Android) call GET /api/v1/mobile/venues/:venueId/settings
 * at venue-select and need the venue's plan tier to gate UI by plan. The dashboard plan
 * endpoint requires `billing:subscriptions:read`, which POS staff don't have, so the plan
 * info ships here as an ADDITIVE, OPTIONAL `plan` field:
 *
 *   plan: { tier: 'FREE'|'PRO'|'PREMIUM'|'ENTERPRISE', grandfathered: boolean, exempt: boolean }
 *
 * Guarantees under test:
 *   1. tier derives from the active base plan (PLAN_PRO → 'PRO'; none → 'FREE').
 *   2. grandfathered (Venue.seatCapExempt) implies exempt:true (apps skip ALL gating).
 *   3. RESILIENCE: a plan-lookup failure must NEVER break venue-select — the settings
 *      payload is returned WITHOUT the plan field (apps fail open) and the error is logged.
 *   4. Existing fields (terminals/settings/activeTerminalId) are never removed (old apps).
 */

import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { getTpvSettings } from '@/services/dashboard/tpv.dashboard.service'

const acknowledgeDisplayModeRequestMock = jest.fn()
const updateLocalDisplayModeMock = jest.fn()

jest.mock('@/services/dashboard/tpv.dashboard.service', () => ({
  getTpvSettings: jest.fn(),
}))

jest.mock('@/services/display-mode-request.service', () => {
  const actual = jest.requireActual('@/services/display-mode-request.service')
  return {
    ...actual,
    acknowledgeDisplayModeRequest: (...args: unknown[]) => acknowledgeDisplayModeRequestMock(...args),
    updateLocalDisplayMode: (...args: unknown[]) => updateLocalDisplayModeMock(...args),
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

jest.mock('@/middlewares/validateVenueAccess.middleware', () => ({
  validateVenueAccess: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireVenueMembership: (req: Request, res: Response, next: NextFunction) => {
    const allowedVenueIds: string[] = (req as any).authContext?.allowedVenueIds ?? []
    if (!allowedVenueIds.includes(req.params.venueId)) {
      res.status(403).json({ message: 'No tienes acceso a este establecimiento' })
      return
    }
    next()
  },
}))

import { getVenueTpvSettings, getDisplayModeRequest, updateDisplayMode } from '@/controllers/mobile/tpvSettings.mobile.controller'
import { DisplayModeRequestError } from '@/services/display-mode-request.service'
import mobileRoutes from '@/routes/mobile.routes'

const venueId = 'venue-123'
const mockedGetTpvSettings = getTpvSettings as jest.MockedFunction<typeof getTpvSettings>

function makeRes(): Response & { __json: any } {
  const res: any = {}
  res.__json = undefined
  res.status = jest.fn(() => res)
  res.json = jest.fn((body: any) => {
    res.__json = body
    return res
  })
  return res
}

function makeReq(deviceUid?: string): Request {
  return {
    params: { venueId },
    headers: deviceUid ? { 'x-device-id': deviceUid } : {},
  } as unknown as Request
}

/** Active PLAN_PRO VenueFeature row as returned by getVenueBaseTier's findMany select. */
const activeProRow = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }

describe('getVenueTpvSettings (mobile) — plan-tier info', () => {
  beforeEach(() => {
    // No terminals → settings null, no per-terminal settings lookup. Keeps the focus on `plan`.
    prismaMock.terminal.findMany.mockResolvedValue([])
    mockedGetTpvSettings.mockResolvedValue({} as Awaited<ReturnType<typeof getTpvSettings>>)
  })

  it('includes plan.tier "PRO" for a venue with an active PLAN_PRO base plan', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([activeProRow])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await getVenueTpvSettings(makeReq(), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.__json.success).toBe(true)
    expect(res.__json.data.plan).toEqual({ tier: 'PRO', grandfathered: false, exempt: false })
    // Existing contract fields are untouched (additive change only)
    expect(res.__json.data.terminals).toEqual([])
    expect(res.__json.data.settings).toBeNull()
    expect(res.__json.data.activeTerminalId).toBeNull()
  })

  it('reports grandfathered:true → exempt:true (and tier FREE when no base plan)', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([]) // no active base plan
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: true, status: 'ACTIVE' })

    const res = makeRes()
    await getVenueTpvSettings(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__json.data.plan).toEqual({ tier: 'FREE', grandfathered: true, exempt: true })
  })

  it('reports exempt:true for demo-status venues (TRIAL) even when not grandfathered', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'TRIAL' })

    const res = makeRes()
    await getVenueTpvSettings(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__json.data.plan).toEqual({ tier: 'FREE', grandfathered: false, exempt: true })
  })

  it('still returns the settings payload WITHOUT plan when the plan lookup throws (fail open)', async () => {
    prismaMock.venueFeature.findMany.mockRejectedValue(new Error('db exploded'))
    prismaMock.venue.findUnique.mockRejectedValue(new Error('db exploded'))

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await getVenueTpvSettings(makeReq(), res, next)

    // Venue-select on the POS must survive: 200 payload, no error propagation
    expect(next).not.toHaveBeenCalled()
    expect(res.__json.success).toBe(true)
    expect(res.__json.data).not.toHaveProperty('plan')
    expect(res.__json.data.terminals).toEqual([])
    expect(res.__json.data.settings).toBeNull()
    expect(res.__json.data.activeTerminalId).toBeNull()
    // ...and the failure is observable in logs
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('plan info'), expect.objectContaining({ venueId }))
  })

  it('returns the workspace for the requesting device instead of the first active terminal', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
    prismaMock.terminal.findMany.mockResolvedValue([
      {
        id: 'terminal-area',
        name: 'Cremería',
        status: 'ACTIVE',
        deviceUid: 'device-area',
        defaultWorkspace: 'AREA_OPERATIONS',
        canIssueAreaTickets: true,
        canCheckoutAreaTickets: false,
        canDeliverAreaTickets: true,
        fulfillmentAreaId: 'area-cremeria',
        config: {},
        configOverrides: {},
      },
      {
        id: 'terminal-checkout',
        name: 'Caja',
        status: 'ACTIVE',
        deviceUid: 'device-checkout',
        defaultWorkspace: 'AREA_OPERATIONS',
        canIssueAreaTickets: false,
        canCheckoutAreaTickets: true,
        canDeliverAreaTickets: false,
        fulfillmentAreaId: null,
        config: {},
        configOverrides: {},
      },
    ] as any)

    const res = makeRes()
    await getVenueTpvSettings(makeReq('device-checkout'), res, jest.fn() as NextFunction)

    expect(mockedGetTpvSettings).toHaveBeenCalledWith('terminal-checkout')
    expect(res.__json.data.activeTerminalId).toBe('terminal-checkout')
    expect(res.__json.data.deviceTerminal).toEqual({
      id: 'terminal-checkout',
      defaultWorkspace: 'AREA_OPERATIONS',
      canIssueAreaTickets: false,
      canCheckoutAreaTickets: true,
      canDeliverAreaTickets: false,
      fulfillmentAreaId: null,
    })
    expect(res.__json.data.terminals[0]).not.toHaveProperty('deviceUid')
    expect(res.__json.data.terminals[0]).not.toHaveProperty('defaultWorkspace')
    expect(res.__json.data.terminals[0]).not.toHaveProperty('canIssueAreaTickets')
  })

  it('returns an INACTIVE POS workspace when its exact device id is making the request', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
    prismaMock.terminal.findMany.mockResolvedValue([
      {
        id: 'terminal-default',
        name: 'Caja activa',
        status: 'ACTIVE',
        deviceUid: 'device-default',
        defaultWorkspace: 'STANDARD_POS',
        canIssueAreaTickets: false,
        canCheckoutAreaTickets: true,
        canDeliverAreaTickets: false,
        fulfillmentAreaId: null,
        config: {},
        configOverrides: {},
      },
      {
        id: 'terminal-cremeria',
        name: 'Samsung Cremería',
        status: 'INACTIVE',
        deviceUid: 'device-cremeria',
        defaultWorkspace: 'AREA_OPERATIONS',
        canIssueAreaTickets: true,
        canCheckoutAreaTickets: false,
        canDeliverAreaTickets: true,
        fulfillmentAreaId: 'area-cremeria',
        config: {},
        configOverrides: {},
      },
    ] as any)

    const res = makeRes()
    await getVenueTpvSettings(makeReq('device-cremeria'), res, jest.fn() as NextFunction)

    expect(mockedGetTpvSettings).toHaveBeenCalledWith('terminal-cremeria')
    expect(res.__json.data.activeTerminalId).toBe('terminal-cremeria')
    expect(res.__json.data.deviceTerminal).toEqual({
      id: 'terminal-cremeria',
      defaultWorkspace: 'AREA_OPERATIONS',
      canIssueAreaTickets: true,
      canCheckoutAreaTickets: false,
      canDeliverAreaTickets: true,
      fulfillmentAreaId: 'area-cremeria',
    })
  })

  it('keeps the legacy first-active behavior when the client sends no device id', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
    prismaMock.terminal.findMany.mockResolvedValue([
      {
        id: 'terminal-legacy',
        name: 'Legacy',
        status: 'ACTIVE',
        deviceUid: 'some-device',
        defaultWorkspace: 'STANDARD_POS',
        canIssueAreaTickets: false,
        canCheckoutAreaTickets: false,
        canDeliverAreaTickets: false,
        fulfillmentAreaId: null,
        config: {},
        configOverrides: {},
      },
    ] as any)

    const res = makeRes()
    await getVenueTpvSettings(makeReq(), res, jest.fn() as NextFunction)

    expect(mockedGetTpvSettings).toHaveBeenCalledWith('terminal-legacy')
    expect(res.__json.data.activeTerminalId).toBe('terminal-legacy')
    expect(res.__json.data.deviceTerminal).toBeNull()
  })
})

describe('mobile display-mode delivery and compatible ACK', () => {
  const terminalId = 'terminal-display-1'
  const deviceUid = 'device-display-1'
  const requestedAt = new Date(Date.now() - 60_000).toISOString()
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  const pendingRequest = {
    requestId: 'request-display-1',
    desiredInverted: true,
    status: 'PENDING',
    requestedAt,
    requestedBy: 'staff-1',
    expiresAt,
  }

  function routeAuthHeaders(allowedVenueIds: string[] = [venueId]): Record<string, string> {
    return {
      'x-test-auth-context': JSON.stringify({ userId: 'staff-1', venueId, allowedVenueIds }),
      'x-device-id': `  ${deviceUid}  `,
    }
  }

  function makeRouteApp() {
    const app = express()
    app.use(express.json())
    app.use('/api/v1/mobile', mobileRoutes)
    app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
      res.status(error.statusCode ?? 500).json({
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      })
    })
    return app
  }

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.terminal.findFirst.mockResolvedValue({
      id: terminalId,
      customerDisplayRequest: pendingRequest,
      customerDisplayRequestExpiresAt: new Date(expiresAt),
    })
    updateLocalDisplayModeMock.mockResolvedValue({
      mutated: true,
      version: 0,
      request: null,
      customerDisplayInverted: true,
      previousCustomerDisplayInverted: false,
    })
    acknowledgeDisplayModeRequestMock.mockResolvedValue({
      mutated: true,
      version: 1,
      request: { ...pendingRequest, status: 'APPLIED', resolvedAt: new Date().toISOString() },
      customerDisplayInverted: true,
    })
  })

  it('GET binds only by normalized X-Device-ID + venue + POS_ANDROID and returns the server terminal id', async () => {
    const response = await request(makeRouteApp()).get(`/api/v1/mobile/venues/${venueId}/display-mode-request`).set(routeAuthHeaders())

    expect(response.status).toBe(200)
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith({
      where: { venueId, deviceUid, type: 'POS_ANDROID' },
      select: {
        id: true,
        customerDisplayRequest: true,
        customerDisplayRequestExpiresAt: true,
      },
    })
    expect(response.body).toEqual({
      data: {
        terminalId,
        request: {
          requestId: pendingRequest.requestId,
          desiredInverted: true,
          requestedAt,
          expiresAt,
        },
      },
    })
  })

  it.each([
    { customerDisplayRequest: null, customerDisplayRequestExpiresAt: null },
    {
      customerDisplayRequest: { ...pendingRequest, status: 'APPLIED' },
      customerDisplayRequestExpiresAt: new Date(expiresAt),
    },
    {
      customerDisplayRequest: { ...pendingRequest, expiresAt: new Date(Date.now() - 1_000).toISOString() },
      customerDisplayRequestExpiresAt: new Date(Date.now() - 1_000),
    },
  ])('GET returns request:null without mutating non-deliverable state %#', async stored => {
    prismaMock.terminal.findFirst.mockResolvedValue({ id: terminalId, ...stored })

    const response = await request(makeRouteApp()).get(`/api/v1/mobile/venues/${venueId}/display-mode-request`).set(routeAuthHeaders())

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: { terminalId, request: null } })
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
    expect(prismaMock.terminal.updateMany).not.toHaveBeenCalled()
  })

  it('GET rejects missing device identity and another venue before reading requests', async () => {
    const missingDevice = await request(makeRouteApp())
      .get(`/api/v1/mobile/venues/${venueId}/display-mode-request`)
      .set({ 'x-test-auth-context': routeAuthHeaders()['x-test-auth-context'] })
    expect(missingDevice.status).toBe(400)
    expect(missingDevice.body).toMatchObject({ code: 'DEVICE_ID_REQUIRED' })

    const wrongVenue = await request(makeRouteApp())
      .get(`/api/v1/mobile/venues/${venueId}/display-mode-request`)
      .set(routeAuthHeaders(['venue-elsewhere']))
    expect(wrongVenue.status).toBe(403)
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
  })

  it('GET returns a stable 404 when no POS Android matches the exact device binding', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null)

    const response = await request(makeRouteApp()).get(`/api/v1/mobile/venues/${venueId}/display-mode-request`).set(routeAuthHeaders())

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'DEVICE_NOT_FOUND' })
  })

  it('preserves the legacy PATCH body/status/response and performs the exact technical binding inside the service', async () => {
    const response = await request(makeRouteApp())
      .patch(`/api/v1/mobile/venues/${venueId}/terminals/${terminalId}/display-mode`)
      .set(routeAuthHeaders())
      .send({ customerDisplayInverted: true })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ success: true, data: { id: terminalId, customerDisplayInverted: true } })
    expect(updateLocalDisplayModeMock).toHaveBeenCalledWith({
      venueId,
      terminalId,
      confirmedInverted: true,
      binding: { deviceUid, type: 'POS_ANDROID' },
    })
    expect(acknowledgeDisplayModeRequestMock).not.toHaveBeenCalled()
  })

  it('accepts an APPLIED v1 ACK without capability gating and uses server-bound route identity', async () => {
    const response = await request(makeRouteApp())
      .patch(`/api/v1/mobile/venues/${venueId}/terminals/${terminalId}/display-mode`)
      .set(routeAuthHeaders())
      .send({ customerDisplayInverted: true, requestId: pendingRequest.requestId, outcome: 'APPLIED' })

    expect(response.status).toBe(200)
    expect(acknowledgeDisplayModeRequestMock).toHaveBeenCalledWith({
      venueId,
      terminalId,
      requestId: pendingRequest.requestId,
      outcome: 'APPLIED',
      confirmedInverted: true,
      binding: { deviceUid, type: 'POS_ANDROID' },
    })
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
  })

  it('accepts coherent REJECTED/LOCAL_OVERRIDE and rejects malformed or extra ACK fields', async () => {
    const accepted = await request(makeRouteApp())
      .patch(`/api/v1/mobile/venues/${venueId}/terminals/${terminalId}/display-mode`)
      .set(routeAuthHeaders())
      .send({
        customerDisplayInverted: false,
        requestId: pendingRequest.requestId,
        outcome: 'REJECTED',
        resultCode: 'LOCAL_OVERRIDE',
      })
    expect(accepted.status).toBe(200)
    expect(acknowledgeDisplayModeRequestMock).toHaveBeenCalledWith({
      venueId,
      terminalId,
      requestId: pendingRequest.requestId,
      outcome: 'REJECTED',
      resultCode: 'LOCAL_OVERRIDE',
      confirmedInverted: false,
      binding: { deviceUid, type: 'POS_ANDROID' },
    })

    const missingResult = await request(makeRouteApp())
      .patch(`/api/v1/mobile/venues/${venueId}/terminals/${terminalId}/display-mode`)
      .set(routeAuthHeaders())
      .send({ customerDisplayInverted: false, requestId: pendingRequest.requestId, outcome: 'REJECTED' })
    expect(missingResult.status).toBe(400)

    const extra = await request(makeRouteApp())
      .patch(`/api/v1/mobile/venues/${venueId}/terminals/${terminalId}/display-mode`)
      .set(routeAuthHeaders())
      .send({ customerDisplayInverted: true, unexpected: true })
    expect(extra.status).toBe(400)
  })

  it('maps a binding loss to stable 403 and a superseded ACK to stable 409', async () => {
    updateLocalDisplayModeMock.mockRejectedValueOnce(
      Object.assign(new Error('El dispositivo no corresponde a esta terminal.'), {
        statusCode: 403,
        code: 'DEVICE_BINDING_MISMATCH',
      }),
    )
    const mismatch = await request(makeRouteApp())
      .patch(`/api/v1/mobile/venues/${venueId}/terminals/${terminalId}/display-mode`)
      .set(routeAuthHeaders())
      .send({ customerDisplayInverted: true })
    expect(mismatch.status).toBe(403)
    expect(mismatch.body).toMatchObject({ code: 'DEVICE_BINDING_MISMATCH' })

    acknowledgeDisplayModeRequestMock.mockRejectedValueOnce(
      new DisplayModeRequestError('DEVICE_REQUEST_SUPERSEDED', 'La solicitud cambió; el valor físico sí fue registrado.'),
    )
    const superseded = await request(makeRouteApp())
      .patch(`/api/v1/mobile/venues/${venueId}/terminals/${terminalId}/display-mode`)
      .set(routeAuthHeaders())
      .send({ customerDisplayInverted: true, requestId: pendingRequest.requestId, outcome: 'APPLIED' })
    expect(superseded.status).toBe(409)
    expect(superseded.body).toMatchObject({ code: 'DEVICE_REQUEST_SUPERSEDED' })
  })
})
