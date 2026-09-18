/*
  S4 — la capa HTTP de las campañas de lanzamiento (spec 2026-09-17 § 3.4, § 9.1).

  🔴 Por qué hace falta ADEMÁS de las pruebas del servicio: una prueba unitaria del servicio y
  del controlador pasa perfectamente aunque NADIE haya montado la subruta, y aunque el guardia
  de SUPERADMIN no esté puesto. Esto arranca el Express real y ejercita
  authenticateTokenMiddleware → authorizeRole([SUPERADMIN]) → controlador.
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

const PATH = '/api/v1/superadmin/launch-campaigns'

function token(role: string) {
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: 'venue_test', role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock.launchCampaign.count as jest.Mock).mockResolvedValue(0)
  ;(prismaMock.launchCampaign.findMany as jest.Mock).mockResolvedValue([])
})

describe('GET /superadmin/launch-campaigns — capa HTTP', () => {
  it('401 sin token', async () => {
    expect((await request(app).get(PATH)).status).toBe(401)
  })

  it.each(['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'VIEWER'])('🔴 403 para %s: es SOLO de Avoqado', async role => {
    const res = await request(app).get(PATH).set('Authorization', `Bearer ${token(role)}`)
    expect(res.status).toBe(403)
    // Y no llega a consultar nada: el guardia corta antes del controlador.
    expect(prismaMock.launchCampaign.findMany).not.toHaveBeenCalled()
  })

  it('200 para SUPERADMIN — y esto es lo que prueba que la subruta está MONTADA', async () => {
    const res = await request(app).get(PATH).set('Authorization', `Bearer ${token('SUPERADMIN')}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, data: [], meta: { total: 0, page: 1, pageSize: 25 } })
  })

  it('un `pageSize` por encima del tope se rechaza con un 400 legible', async () => {
    const res = await request(app).get(`${PATH}?pageSize=5000`).set('Authorization', `Bearer ${token('SUPERADMIN')}`)
    expect(res.status).toBe(400)
    expect(String(res.body.message)).toMatch(/cupo|pageSize|Revisa|:/i)
  })
})

describe('POST /superadmin/launch-campaigns — validación', () => {
  it('🔴 403 para un OWNER, aunque el cuerpo sea válido', async () => {
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${token('OWNER')}`)
      .send({ code: 'POS22', name: 'POS $22', landingSlug: 'pos-22', planTier: 'PRO', advertisedPriceCents: 2200, discountMonths: 3 })
    expect(res.status).toBe(403)
    expect(prismaMock.launchCampaign.create).not.toHaveBeenCalled()
  })

  it('un cuerpo inválido da 400 LEGIBLE, no un 500 con el JSON crudo de Zod', async () => {
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${token('SUPERADMIN')}`)
      .send({ code: 'no', name: 'x', landingSlug: 'MAYUSCULAS', planTier: 'GRATIS', advertisedPriceCents: 10, discountMonths: 99 })
    expect(res.status).toBe(400)
    expect(typeof res.body.message).toBe('string')
    expect(res.body.message).not.toContain('too_small')
    expect(prismaMock.launchCampaign.create).not.toHaveBeenCalled()
  })

  it('🔴 un precio por debajo del mínimo de Stripe se rechaza ANTES de tocar la base', async () => {
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${token('SUPERADMIN')}`)
      .send({
        code: 'POS5',
        name: 'Cinco pesos',
        landingSlug: 'pos-5',
        planTier: 'PRO',
        advertisedPriceCents: 500,
        discountMonths: 3,
        redemptionCap: 10,
        validFrom: '2026-09-01T00:00:00Z',
        validUntil: '2026-12-01T00:00:00Z',
      })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/\$10\.00|Stripe/)
    expect(prismaMock.launchCampaign.create).not.toHaveBeenCalled()
  })
})
