import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'

const sendCommandMock = jest.fn()
const getTerminalHealthMock = jest.fn()
const checkedVenues: Array<string | undefined> = []

jest.mock('@/services/tpv/tpv-health.service', () => ({
  tpvHealthService: {
    sendCommand: (...args: unknown[]) => sendCommandMock(...args),
    getTerminalHealth: (...args: unknown[]) => getTerminalHealthMock(...args),
  },
}))

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
  checkPermission: () => (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as any).authContext
    const effectiveVenueId = req.params.venueId || auth?.venueId
    checkedVenues.push(effectiveVenueId)
    if (auth?.role !== 'SUPERADMIN' && effectiveVenueId !== auth?.authorizedVenueId) {
      res.status(403).json({ message: 'No tienes permiso' })
      return
    }
    next()
  },
  resolveUserRoleForVenue: jest.fn(),
}))

import dashboardRoutes from '@/routes/dashboard.routes'

const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'
const TERMINAL_B = {
  id: 'terminal-b',
  venueId: VENUE_B,
  serialNumber: 'AVQD-B-001',
  lastHeartbeat: new Date('2026-08-31T17:00:00.000Z'),
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/dashboard', dashboardRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
  })
  return app
}

function authHeaders(overrides: Record<string, unknown> = {}) {
  return {
    'x-test-auth-context': JSON.stringify({
      userId: 'staff-a',
      venueId: VENUE_A,
      authorizedVenueId: VENUE_A,
      ...overrides,
    }),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  checkedVenues.length = 0
  prismaMock.terminal.findFirst.mockResolvedValue(TERMINAL_B)
  prismaMock.staff.findUnique.mockResolvedValue({ firstName: 'Ana', lastName: 'A' })
  prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 })
  sendCommandMock.mockResolvedValue(undefined)
  getTerminalHealthMock.mockResolvedValue({ status: 'ACTIVE' })
})

describe('TPV command routes bind authorization to the actual target venue', () => {
  it.each([
    ['canonical id', TERMINAL_B.id],
    ['case-insensitive serial', TERMINAL_B.serialNumber.toLowerCase()],
  ])('denies venue-A staff targeting venue B by %s before any command side effect', async (_label, target) => {
    const response = await request(makeApp()).post(`/api/v1/dashboard/tpv/${target}/command`).set(authHeaders()).send({ command: 'LOCK' })

    expect(response.status).toBe(403)
    expect(checkedVenues).toEqual([VENUE_B])
    // The command-dispatch boundary owns queue + history + socket broadcast.
    // If permission stops here, none of those downstream side effects can run.
    expect(sendCommandMock).not.toHaveBeenCalled()
    expect(prismaMock.terminal.updateMany).not.toHaveBeenCalled()
  })

  it('does not resolve a venue-B terminal through the explicit venue-A scoped route', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null)

    const response = await request(makeApp())
      .post(`/api/v1/dashboard/venues/${VENUE_A}/tpv/${TERMINAL_B.id}/command`)
      .set(authHeaders())
      .send({ command: 'RESTART' })

    expect(response.status).toBe(404)
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: VENUE_A }),
      }),
    )
    expect(sendCommandMock).not.toHaveBeenCalled()
  })

  it('uses the canonical id and bound venue for legitimate same-venue use', async () => {
    const terminalA = { ...TERMINAL_B, id: 'terminal-a', venueId: VENUE_A, serialNumber: 'AVQD-A-001' }
    prismaMock.terminal.findFirst.mockResolvedValue(terminalA)

    const response = await request(makeApp())
      .post('/api/v1/dashboard/tpv/avqd-a-001/command')
      .set(authHeaders())
      .send({ command: 'LOCK', payload: { reason: 'lost' } })

    expect(response.status).toBe(200)
    expect(sendCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: terminalA.id, venueId: VENUE_A }),
      expect.objectContaining({ type: 'LOCK', requestedBy: 'staff-a' }),
    )
    expect(prismaMock.terminal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: terminalA.id, venueId: VENUE_A } }))
  })

  it('preserves legitimate SUPERADMIN cross-venue commands in the bound target venue', async () => {
    const response = await request(makeApp())
      .post(`/api/v1/dashboard/tpv/${TERMINAL_B.id}/command`)
      .set(authHeaders({ role: 'SUPERADMIN' }))
      .send({ command: 'RESTART' })

    expect(response.status).toBe(200)
    expect(checkedVenues).toEqual([VENUE_B])
    expect(sendCommandMock).toHaveBeenCalledWith(expect.objectContaining({ id: TERMINAL_B.id, venueId: VENUE_B }), expect.any(Object))
  })
})
