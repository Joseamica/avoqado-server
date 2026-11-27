/*
  Planes editables B4, Task 1: GET /api/v1/public/plan-offer, por la app real (supertest sobre `src/app`, base `prismaMock`).
  - 200 con la forma pública y `Cache-Control: public, max-age=30`;
  - 503 PLAN_NOT_CONFIGURED con la vigente dañada;
  - su tope de lecturas es propio: 601 peticiones a /plan-offer no le dan 429 a /price-list.
*/
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({})))
jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))
const mockBoard = jest.fn()
jest.mock('../../../src/services/launchCampaigns/hybridListPrice.service', () => ({
  ...jest.requireActual('../../../src/services/launchCampaigns/hybridListPrice.service'),
  listPriceBoard: (...a: unknown[]) => mockBoard(...a),
}))

import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'

const app = require('../../../src/app').default
const pointer = prismaMock.planOfferPointer.findUnique as jest.Mock

beforeEach(() => {
  pointer.mockReset().mockResolvedValue(null)
  mockBoard.mockReset().mockResolvedValue([])
})

describe('GET /api/v1/public/plan-offer', () => {
  it('200 con la forma pública y Cache-Control de 30 s', async () => {
    pointer.mockResolvedValue(
      punteroA('ver_v2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2'), nombres: { PRO: 'Plus' }, netos: { 'PRO:monthly': 79900 } })),
    )
    const res = await request(app).get('/api/v1/public/plan-offer').set('CF-Connecting-IP', '10.8.0.1')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=30')
    expect(res.body.success).toBe(true)
    expect(res.body.data.offerVersion).toBe(2)
    expect(res.body.data.PRO).toMatchObject({ displayName: 'Plus', monthly: { netCents: 79900, grossCents: 92684 } })
    expect(JSON.stringify(res.body)).not.toContain('stripePriceId')
  })

  it('sin versiones: el respaldo con offerVersion null', async () => {
    const res = await request(app).get('/api/v1/public/plan-offer').set('CF-Connecting-IP', '10.8.0.2')
    expect(res.status).toBe(200)
    expect(res.body.data.offerVersion).toBeNull()
    expect(res.body.data.PRO.monthly.netCents).toBe(99900)
  })

  it('503 PLAN_NOT_CONFIGURED con la vigente dañada', async () => {
    pointer.mockResolvedValue(punteroA('ver_v1', 1, { schemaVersion: 1 }))
    const res = await request(app).get('/api/v1/public/plan-offer').set('CF-Connecting-IP', '10.8.0.3')
    expect(res.status).toBe(503)
    expect(JSON.stringify(res.body)).toContain('PLAN_NOT_CONFIGURED')
  })

  it('601 peticiones a /plan-offer en un minuto no le dan 429 a /price-list', async () => {
    const ip = '10.8.0.4'
    let ultimo = 0
    for (let i = 0; i < 601; i++) {
      ultimo = (await request(app).get('/api/v1/public/plan-offer').set('CF-Connecting-IP', ip)).status
    }
    expect(ultimo).toBe(429)
    const lista = await request(app).get('/api/v1/public/price-list').set('CF-Connecting-IP', ip)
    expect(lista.status).not.toBe(429)
  })
})
