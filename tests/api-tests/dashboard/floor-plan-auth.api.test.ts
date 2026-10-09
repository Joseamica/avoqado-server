/*
  Plano de mesas — capa HTTP: autenticación (401), aislamiento de venue (403) y permiso tables:configure
  para publicar (403 con WAITER). Prisma va mockeado; no hace falta base.
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

import jwt from 'jsonwebtoken'
import { api, startApiServer } from '@tests/__helpers__/apiServer'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'

const app = require('../../../src/app').default
startApiServer(() => app)

const venueId = 'clvenueplano0000000000001'
const otherVenueId = 'clvenueplano0000000000002'
const path = `/api/v1/dashboard/venues/${venueId}/floor-plan`

function makeToken(role: string, tokenVenueId: string = venueId) {
  mirrorTokenRoleOnStaffVenue(role, tokenVenueId)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: tokenVenueId, role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

beforeEach(() => {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
})

describe('Plano de mesas — autenticación y permisos', () => {
  it.each(['get', 'put'] as const)('%s → 401 sin token', async method => {
    expect((await api()[method](path)).status).toBe(401)
  })

  it.each(['get', 'put'] as const)('%s → 403 con un token de otro venue', async method => {
    const auth = `Bearer ${makeToken('OWNER', otherVenueId)}`
    const res = await api()[method](path).set('Authorization', auth)
    expect(res.status).toBe(403)
  })

  it('PUT → 403 con WAITER (no tiene tables:configure)', async () => {
    const res = await api()
      .put(path)
      .set('Authorization', `Bearer ${makeToken('WAITER')}`)
      .send({})
    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('required', 'tables:configure')
  })
})
