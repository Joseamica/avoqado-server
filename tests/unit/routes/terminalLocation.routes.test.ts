/**
 * Route-level test for the supervisor terminal-locations endpoint (Task 4):
 *   GET /venues/:venueId/supervisor/terminals-locations
 *
 * Mirrors the pattern used in tests/unit/routes/simCustody.admin.routes.test.ts:
 * bare express app + supertest, authContext injected via a test header, all
 * middleware and the service mocked.
 */

import express from 'express'
import request from 'supertest'

// 1. Auth: inject authContext from a custom test header
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

// 2. verifyAccess → passthrough in unit tests (gating covered in integration)
jest.mock('@/middlewares/verifyAccess.middleware', () => ({
  verifyAccess: () => (_req: any, _res: any, next: any) => next(),
}))

// 3. Service
jest.mock('@/services/promoters/terminalLocation.service', () => ({
  getSupervisorTerminalLocations: jest.fn(),
}))

import { getSupervisorTerminalLocations } from '@/services/promoters/terminalLocation.service'
import terminalLocationRoutes from '@/routes/dashboard/terminalLocation.routes'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/venues/:venueId/supervisor', terminalLocationRoutes)
  return app
}

describe('GET /venues/:venueId/supervisor/terminals-locations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('devuelve data del service', async () => {
    ;(getSupervisorTerminalLocations as jest.Mock).mockResolvedValue({
      terminals: [{ terminalId: 't1' }],
      trackingEnabled: true,
    })

    const res = await request(makeApp())
      .get('/venues/v1/supervisor/terminals-locations')
      .set('x-test-auth-context', JSON.stringify({ userId: 'sup1', venueId: 'v1', role: 'MANAGER' }))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      success: true,
      data: { terminals: [{ terminalId: 't1' }], trackingEnabled: true },
    })
    expect(getSupervisorTerminalLocations).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'v1', requesterStaffId: 'sup1', requesterRole: 'MANAGER' }),
    )
  })

  it('propaga errores del service al error handler (next)', async () => {
    ;(getSupervisorTerminalLocations as jest.Mock).mockRejectedValue(new Error('boom'))

    const app = makeApp()
    // capture errors passed to next()
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(500).json({ success: false, error: err.message })
    })

    const res = await request(app)
      .get('/venues/v1/supervisor/terminals-locations')
      .set('x-test-auth-context', JSON.stringify({ userId: 'sup1', venueId: 'v1', role: 'ADMIN' }))

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ success: false, error: 'boom' })
  })
})
