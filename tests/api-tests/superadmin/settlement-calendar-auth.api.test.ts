/*
  tests/api-tests/superadmin/settlement-calendar-auth.api.test.ts

  Verifies the HTTP layer of the cross-venue settlement calendar: that the route
  is ACTUALLY wired into the superadmin router (a unit test of the service/controller
  passes even when nobody mounted the route), that it requires authentication (401),
  and that it is SUPERADMIN-only (403 for every other role).

  Middleware order (superadmin router, src/routes/superadmin.routes.ts):
    authenticateTokenMiddleware -> authorizeRole([SUPERADMIN]) -> controller

  Prisma is mocked via the api-tests setup, so no DB is needed.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))

import request from 'supertest'
import jwt from 'jsonwebtoken'
import { prismaMock } from '@tests/__helpers__/setup'

const app = require('../../../src/app').default

const PATH = '/api/v1/superadmin/settlement-calendar'

function makeToken(role: string) {
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: 'venue_test', role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue([])
  ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([])
})

describe('GET /superadmin/settlement-calendar — HTTP layer', () => {
  it('401 sin token', async () => {
    const res = await request(app).get(PATH)
    expect(res.status).toBe(401)
  })

  it.each(['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'VIEWER'])('403 para %s (es SUPERADMIN-only)', async role => {
    const res = await request(app)
      .get(PATH)
      .set('Authorization', `Bearer ${makeToken(role)}`)
    expect(res.status).toBe(403)
  })

  // La prueba de que la ruta está montada: sin el `router.use('/settlement-calendar', ...)`
  // esto devolvería 404 aunque el service y el controller estén perfectos.
  it('200 para SUPERADMIN y devuelve la forma del calendario', async () => {
    const res = await request(app)
      .get(`${PATH}?month=2026-07`)
      .set('Authorization', `Bearer ${makeToken('SUPERADMIN')}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toMatchObject({
      from: '2026-07-01',
      to: '2026-07-31',
      days: [],
      venueCount: 0,
      unprojected: { count: 0, gross: 0 },
    })
  })

  it('un ?month basura no truena: cae al mes actual', async () => {
    const res = await request(app)
      .get(`${PATH}?month=no-es-un-mes`)
      .set('Authorization', `Bearer ${makeToken('SUPERADMIN')}`)

    expect(res.status).toBe(200)
    expect(res.body.data.from).toMatch(/^\d{4}-\d{2}-01$/)
  })

  it('acepta un rango explícito from/to', async () => {
    const res = await request(app)
      .get(`${PATH}?from=2026-07-06&to=2026-07-12`)
      .set('Authorization', `Bearer ${makeToken('SUPERADMIN')}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ from: '2026-07-06', to: '2026-07-12' })
  })

  // El efectivo nunca liquida: si un día se cuela al query, el calendario mentiría.
  it('nunca pide pagos en efectivo a la DB', async () => {
    await request(app)
      .get(`${PATH}?month=2026-07`)
      .set('Authorization', `Bearer ${makeToken('SUPERADMIN')}`)

    const where = (prismaMock.payment.findMany as jest.Mock).mock.calls[0][0].where
    expect(where.method).toEqual({ not: 'CASH' })
  })
})
