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
// La ruta de cobro de prueba sólo se registra con este interruptor; se prende para poder probar su candado.
process.env.ENABLE_ONBOARDING_PAYMENT_PROVIDERS = 'true'

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
    // Superadmin DE VERDAD: la base lo confirma (Codex H6/ronda 3), no basta con que el token lo diga.
    ;(prismaMock.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'fila-sa' })
    ;(prismaMock.onboardingProgress.findUnique as jest.Mock).mockResolvedValue(null)
    const res = await request(app)
      .get(`${BASE}/progress`)
      .set('Authorization', `Bearer ${token('SUPERADMIN', 'sa')}`)
    expect(res.status).not.toBe(403)
  })
})

/*
  El asistente V1 (25-sep): cinco rutas NO pedían ni token (step/1, 4, 5, 6 y upload-menu-csv) y el resto
  pedía token pero no comprobaba la organización. Lo grave era `complete`: cualquier usuario con sesión
  llenaba los pasos de OTRA organización, la completaba y quedaba como OWNER de una sucursal nueva dentro
  de ella. Todas exigen ahora sesión Y ser dueño de ESA organización.
*/
describe('asistente V1: todas sus rutas exigen sesión y ser dueño de esa organización', () => {
  const casos: Array<[string, () => request.Test]> = [
    ['POST start', () => request(app).post(`${BASE}/start`).send({})],
    ['PUT step/1', () => request(app).put(`${BASE}/step/1`).send({ email: 'x@x.mx', firstName: 'X', lastName: 'Y' })],
    ['PUT step/2', () => request(app).put(`${BASE}/step/2`).send({ type: 'REAL' })],
    ['PUT step/3', () => request(app).put(`${BASE}/step/3`).send({ name: 'X' })],
    ['PUT step/4', () => request(app).put(`${BASE}/step/4`).send({ method: 'manual' })],
    ['POST upload-menu-csv', () => request(app).post(`${BASE}/upload-menu-csv`)],
    ['PUT step/5', () => request(app).put(`${BASE}/step/5`).send({ teamInvites: [] })],
    ['PUT step/6', () => request(app).put(`${BASE}/step/6`).send({ selectedFeatures: [] })],
    ['PUT step/7', () => request(app).put(`${BASE}/step/7`).send({ entityType: 'PERSONA_FISICA' })],
    ['PUT kyc/document', () => request(app).put(`${BASE}/kyc/document/ineUrl`)],
    ['PUT step/8', () => request(app).put(`${BASE}/step/8`).send({ clabe: '002010077777777771' })],
    ['POST complete', () => request(app).post(`${BASE}/complete`).send({})],
  ]

  it.each(casos)('🔴 %s → 401 sin token', async (_nombre, hacer) => {
    expect((await hacer()).status).toBe(401)
    expect(prismaMock.onboardingProgress.upsert).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.update).not.toHaveBeenCalled()
  })

  it.each(casos)('🔴 %s → 403 para el OWNER de otra organización', async (_nombre, hacer) => {
    const res = await hacer().set('Authorization', `Bearer ${token('OWNER')}`)
    expect(res.status).toBe(403)
    expect(prismaMock.onboardingProgress.upsert).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.update).not.toHaveBeenCalled()
    expect(prismaMock.venue.create).not.toHaveBeenCalled()
  })

  it.each(casos)('%s → el dueño de ESA organización pasa el candado (regresión)', async (_nombre, hacer) => {
    ;(prismaMock.staffOrganization.findFirst as jest.Mock).mockResolvedValue({ id: 'so-dueno' })
    const res = await hacer().set('Authorization', `Bearer ${token('OWNER', 'dueno')}`)
    expect([401, 403]).not.toContain(res.status)
  })
})

describe('cobro de prueba del alta: exige ser dueño del negocio', () => {
  const VENUE = 'clvvvvvvvvvvvvvvvvvvvvvvvv'
  const hacer = () => request(app).post(`/api/v1/onboarding/venues/${VENUE}/test-payment-link`).send({ amount: 10 })

  it('🔴 401 sin token', async () => {
    expect((await hacer()).status).toBe(401)
  })

  it('🔴 403 para el dueño de OTRA organización', async () => {
    ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG })
    const res = await hacer().set('Authorization', `Bearer ${token('OWNER')}`)
    expect(res.status).toBe(403)
  })
})
