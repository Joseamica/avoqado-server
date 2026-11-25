/**
 * Planes editables B1, Task 3: por la ruta real del SUPERADMIN, con el servicio real y el `prismaMock`, «Reintentar» el precio
 * pendiente de una lista de plan se niega cuando la oferta ya tiene versión (el precio de un plan sólo cambia publicando).
 */
import express from 'express'
import request from 'supertest'
import { StaffRole } from '@prisma/client'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (req.headers['x-test-role']) req.authContext = { userId: 'superadmin-1', role: req.headers['x-test-role'] } as never
    next()
  },
}))
jest.mock('@/services/access/rolVigente', () => ({ rolVigente: jest.fn() }))
const mockEnsure = jest.fn()
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({ ensureHybridPublicationPrices: (...a: unknown[]) => mockEnsure(...a) }))

import superadminRouter from '@/routes/superadmin.routes'
import { rolVigente } from '@/services/access/rolVigente'
import { prismaMock } from '@tests/__helpers__/setup'
import { punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const app = express()
app.use(express.json())
app.use('/api/v1/superadmin', superadminRouter)
app.use(
  (
    error: { statusCode?: number; code?: string; message: string; details?: unknown },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => res.status(error.statusCode ?? 500).json({ code: error.code, message: error.message, details: error.details }),
)

beforeEach(() => {
  jest.mocked(rolVigente).mockResolvedValue(StaffRole.SUPERADMIN)
  mockEnsure.mockReset()
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(punteroA('cv1', 1, versionUno()))
  prismaMock.hybridCampaign.findFirst.mockReset().mockResolvedValue({ id: 'list_pro', revision: 4, pendingPublicationId: 'pub_pend' })
})

it('POST /api/v1/superadmin/hybrid-pricing/lists/PLAN%3APRO/retry con versión → 409 PLAN_OFFER_OWNS_PLAN_LISTS', async () => {
  const res = await request(app)
    .post('/api/v1/superadmin/hybrid-pricing/lists/PLAN%3APRO/retry')
    .set('x-test-role', 'SUPERADMIN')
    .send({ expectedRevision: 4 })
    .expect(409)

  expect(res.body).toMatchObject({ code: 'PLAN_OFFER_OWNS_PLAN_LISTS', message: expect.stringContaining('Planes') })
  expect(mockEnsure).not.toHaveBeenCalled()
  expect(prismaMock.hybridCampaign.findFirst).not.toHaveBeenCalled()
})
