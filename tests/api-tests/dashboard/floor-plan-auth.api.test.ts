/*
  Plano de mesas — capa HTTP: autenticación (401), aislamiento de venue (403), permiso tables:configure para publicar
  (por rol) y el orden de los porteros: el 403 del plan (TABLE_SERVICE) sale ANTES que el 400 de validación.
  Prisma va mockeado; no hace falta base.
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
import { DEFAULT_PERMISSIONS } from '../../../src/lib/permissions'

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

/**
 * El plan se concede por el camino de la concesión explícita (una fila VenueFeature activa de TABLE_SERVICE), igual
 * que la suite de lealtad. Sin fila y sin filas de plan base (`venueFeature.findMany` → []), el venue queda en Gratis.
 */
const TABLE_SERVICE_GRANT = {
  id: 'vf-plano',
  active: true,
  endDate: null,
  suspendedAt: null,
  stripeSubscriptionId: null,
  feature: { code: 'TABLE_SERVICE', name: 'Servicio de mesas' },
}
const sinPlan = () => {
  prismaMock.venueFeature.findFirst.mockResolvedValue(null)
  prismaMock.venueFeature.findMany.mockResolvedValue([])
}
const conPlan = () => prismaMock.venueFeature.findFirst.mockResolvedValue(TABLE_SERVICE_GRANT as any)
const publicarVacio = (role: string) =>
  api()
    .put(path)
    .set('Authorization', `Bearer ${makeToken(role)}`)
    .send({})

describe('Plano de mesas — plan antes que validación, y tables:configure por rol', () => {
  it('sin el plan (TABLE_SERVICE), un cuerpo inválido recibe el 403 del plan, no el 400 de validación', async () => {
    sinPlan()
    const res = await publicarVacio('MANAGER')
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ featureCode: 'TABLE_SERVICE', subscriptionRequired: true })
  })

  it('con el plan, el mismo cuerpo inválido llega a la validación (400 en español)', async () => {
    conPlan()
    const res = await publicarVacio('MANAGER')
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toMatch(/folio de guardado/i)
  })

  it.each(['MANAGER', 'ADMIN', 'OWNER'])('%s puede publicar (pasa tables:configure y llega a la validación)', async role => {
    conPlan()
    const res = await publicarVacio(role)
    expect(res.status).toBe(400)
  })

  it.each(['WAITER', 'CASHIER'])('%s NO puede publicar: 403 por tables:configure, aun con el plan', async role => {
    conPlan()
    const res = await publicarVacio(role)
    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('required', 'tables:configure')
  })

  it('defaults: MANAGER lo tiene escrito; ADMIN y OWNER lo reciben por tables:*; WAITER y CASHIER no', () => {
    expect(DEFAULT_PERMISSIONS.MANAGER).toContain('tables:configure')
    for (const role of ['ADMIN', 'OWNER'] as const) {
      expect(DEFAULT_PERMISSIONS[role]).toContain('tables:*')
      expect(DEFAULT_PERMISSIONS[role]).not.toContain('tables:configure')
    }
    for (const role of ['WAITER', 'CASHIER'] as const) {
      expect(DEFAULT_PERMISSIONS[role]).not.toContain('tables:configure')
      expect(DEFAULT_PERMISSIONS[role]).not.toContain('tables:*')
    }
  })
})
