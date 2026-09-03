/**
 * Gate de PLAN en las rutas de campañas de correo (`CUSTOMER_CAMPAIGNS`, tier PRO).
 *
 * 🔴 Por qué existe, y por qué no basta con el `<FeatureGate>` del dashboard: esconder no
 * es impedir. Sin este gate, un venue en plan GRATIS puede mandar campañas llamando la API
 * directamente — y aquí el coste no es sólo de producto: cada correo lo pagamos nosotros y
 * consume la reputación del subdominio de marketing, que es COMPARTIDO entre todos los
 * negocios. Un gratis quemándolo perjudica la entrega de todos los que sí pagan.
 *
 * Monta el sub-router REAL detrás del middleware REAL, con la forma EXACTA del montaje de
 * `dashboard.routes.ts`. Mismo molde que `reservationRoutes.featureGate.test.ts`.
 *
 * Incluye una comprobación a nivel de FUENTE de que el gate sigue cableado en el montaje:
 * un middleware puede caerse de una línea de `router.use` sin que ninguna prueba de
 * comportamiento lo note, porque cada una monta su propia app.
 */
import fs from 'fs'
import path from 'path'
import express from 'express'
import type { Server } from 'http'
import request from 'supertest'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    // staffVenue alimenta el bypass de SUPERADMIN dentro de checkFeatureAccess.
    staffVenue: { findFirst: jest.fn() },
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

// El permiso NO es el sujeto de este archivo (tiene el suyo) — passthrough, conservando el
// resolveRequestVenueId real que checkFeatureAccess importa del mismo módulo.
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}))

// El controlador tampoco: cualquier handler contesta 200 {ok}.
jest.mock(
  '@/controllers/dashboard/marketingCampaign.dashboard.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)

import prisma from '@/utils/prismaClient'
import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'
import marketingCampaignRoutes from '@/routes/dashboard/marketingCampaign.routes'

const staffVenueFindFirst = (prisma as any).staffVenue.findFirst as jest.Mock
const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const vfFindFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const vfFindMany = (prisma as any).venueFeature.findMany as jest.Mock

const VENUE_ID = 'clv1000000000000000000000'
const LISTA = `/api/v1/dashboard/venues/${VENUE_ID}/campaigns`

function createApp() {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    req.authContext = { userId: 'user_1', venueId: VENUE_ID, orgId: 'org_1', role: 'OWNER' }
    next()
  })
  // Forma EXACTA del montaje real: auth (arriba) → gate de plan → sub-router.
  app.use('/api/v1/dashboard/venues/:venueId/campaigns', checkFeatureAccess('CUSTOMER_CAMPAIGNS'), marketingCampaignRoutes)
  return app
}

let server: Server
beforeAll(() => {
  server = createApp().listen(0)
})
afterAll(done => {
  server.close(done)
})

beforeEach(() => {
  jest.clearAllMocks()
  staffVenueFindFirst.mockResolvedValue(null) // no es superadmin de plataforma
  vfFindFirst.mockResolvedValue(null) // sin concesión propia
  vfFindMany.mockResolvedValue([]) // sin plan de pago
})

describe('campañas — gate de plan (CUSTOMER_CAMPAIGNS)', () => {
  it('venue GRATIS activo → 403, y dice qué feature falta', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })

    const res = await request(server).get(LISTA)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('CUSTOMER_CAMPAIGNS')
    expect(res.body.subscriptionRequired).toBe(true)
  })

  it('venue PRO → 200: el tier lo desbloquea sin concesión propia', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
    vfFindMany.mockResolvedValue([{ active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }])

    const res = await request(server).get(LISTA)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('venue grandfathered (seatCapExempt) → 200', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: true, status: 'ACTIVE' })

    const res = await request(server).get(LISTA)

    expect(res.status).toBe(200)
  })

  it('venue demo → 200', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status: 'LIVE_DEMO' })

    const res = await request(server).get(LISTA)

    expect(res.status).toBe(200)
  })

  it('🔴 el gate cubre también PUBLICAR, que es lo que manda los correos', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })

    const res = await request(server)
      .post(`${LISTA}/clv2000000000000000000000/publish`)
      .send({ token: 'x' })

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('CUSTOMER_CAMPAIGNS')
  })
})

describe('el gate sigue CABLEADO en el montaje real', () => {
  it("dashboard.routes.ts monta /campaigns con checkFeatureAccess('CUSTOMER_CAMPAIGNS')", () => {
    const fuente = fs.readFileSync(path.join(__dirname, '../../../src/routes/dashboard.routes.ts'), 'utf8')
    const linea = fuente.split('\n').find(l => l.includes("router.use('/venues/:venueId/campaigns'"))

    expect(linea).toBeDefined()
    // Sin esto, el middleware puede caerse de la línea sin que ninguna prueba de
    // comportamiento lo note: cada una monta su propia app.
    expect(linea).toContain("checkFeatureAccess('CUSTOMER_CAMPAIGNS')")
  })
})
