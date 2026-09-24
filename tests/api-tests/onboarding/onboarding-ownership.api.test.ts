/*
  S7 — pertenencia en los endpoints del alta (spec 2026-09-17 § 7.7).

  🔴 EL DEFECTO QUE ESTO CIERRA, y es objetivo: hasta hoy
  `GET /onboarding/organizations/:organizationId/progress` NO pedía token y devolvía
  `v2SetupData` entero, que incluye la CLABE del negocio. Con un cuid de organización,
  cualquiera en internet la leía. Los demás endpoints V2 sí pedían token pero NINGUNO comprobaba
  que el token fuera de ESA organización.

  Estas pruebas arrancan el Express real: un test del middleware suelto pasa aunque nadie lo
  haya puesto en la ruta.
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

const ORG = 'clzzzzzzzzzzzzzzzzzzzzzzzz'
const BASE = `/api/v1/onboarding/organizations/${ORG}`

function token(role: string, sub = 'staff_ajeno') {
  return jwt.sign({ sub, orgId: 'otra_org', venueId: 'v1', role }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })
}

beforeEach(() => {
  jest.clearAllMocks()
  // Nadie es OWNER de esa organización: es el caso que se quiere probar.
  ;(prismaMock.staffOrganization.findFirst as jest.Mock).mockResolvedValue(null)
})

describe('GET progress — la fuga de la CLABE', () => {
  it('🔴 SIN TOKEN ya no responde 200: exige autenticación', async () => {
    const res = await request(app).get(`${BASE}/progress`)
    expect(res.status).toBe(401)
    // Y ni siquiera llega a leer el progreso, que es donde vive la CLABE.
    expect(prismaMock.onboardingProgress.findUnique).not.toHaveBeenCalled()
  })

  it('🔴 el OWNER de OTRA organización recibe 403, no los datos', async () => {
    const res = await request(app)
      .get(`${BASE}/progress`)
      .set('Authorization', `Bearer ${token('OWNER')}`)
    expect(res.status).toBe(403)
    expect(res.body.code ?? res.body.message).toBeTruthy()
    expect(prismaMock.onboardingProgress.findUnique).not.toHaveBeenCalled()
  })
})

describe('los demás endpoints del alta exigen ser dueño', () => {
  const casos: Array<[string, () => request.Test]> = [
    ['PUT step', () => request(app).put(`${BASE}/v2/step/2`).send({ businessName: 'X' })],
    ['POST accept-terms', () => request(app).post(`${BASE}/v2/accept-terms`).send({ termsVersion: '2026-09-17' })],
    ['POST complete', () => request(app).post(`${BASE}/v2/complete`).send({})],
    ['PUT launch-campaign', () => request(app).put(`${BASE}/v2/launch-campaign`).send({ code: 'POS22' })],
  ]

  it.each(casos)('%s → 403 para el OWNER de otra organización', async (_nombre, hacer) => {
    const res = await hacer().set('Authorization', `Bearer ${token('OWNER')}`)
    expect(res.status).toBe(403)
  })

  it.each(casos)('%s → 401 sin token', async (_nombre, hacer) => {
    expect((await hacer()).status).toBe(401)
  })
})

describe('SUPERADMIN pasa el guardia', () => {
  it('no recibe 403 (es quien resuelve altas atoradas)', async () => {
    ;(prismaMock.onboardingProgress.findUnique as jest.Mock).mockResolvedValue(null)
    const res = await request(app)
      .get(`${BASE}/progress`)
      .set('Authorization', `Bearer ${token('SUPERADMIN', 'sa')}`)
    expect(res.status).not.toBe(403)
  })
})
