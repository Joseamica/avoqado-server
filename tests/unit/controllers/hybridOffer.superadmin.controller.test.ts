import express from 'express'
import request from 'supertest'
import { StaffRole } from '@prisma/client'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (req.headers['x-test-role']) req.authContext = { userId: 'preview-fixture', role: req.headers['x-test-role'] } as never
    next()
  },
}))
jest.mock('@/services/access/rolVigente', () => ({ rolVigente: jest.fn() }))

import superadminRouter from '@/routes/superadmin.routes'
import { rolVigente } from '@/services/access/rolVigente'
import { previewHybridOffer } from '@/services/launchCampaigns/hybridOffer.service'
import { prismaMock } from '@tests/__helpers__/setup'

const app = express()
app.use(express.json())
app.use('/api/v1/superadmin', superadminRouter)
app.use(
  (
    error: { statusCode?: number; code?: string; message: string },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(error.statusCode ?? 500).json({ code: error.code, message: error.message })
  },
)
const path = '/api/v1/superadmin/launch-campaigns/hybrid-preview'
const body = {
  offer: {
    schemaVersion: 1,
    kind: 'CHOICE_BUNDLE',
    eligibleFeatureCodes: ['CFDI', 'RESERVATIONS'],
    choiceCount: 1,
    terms: {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: 149.9,
      taxIncluded: true,
      promotionCycles: null,
      renewal: { kind: 'SAME_PRICE' },
    },
  },
  selectedFeatureCodes: ['CFDI'],
}

beforeEach(() => {
  jest.mocked(rolVigente).mockResolvedValue(StaffRole.SUPERADMIN)
})

describe('Superadmin hybrid-offer preview HTTP contract', () => {
  it('uses the shared preview and performs no business mutations', async () => {
    const result = await request(app).post(path).set('x-test-role', 'SUPERADMIN').send(body).expect(200)
    // Plus the overlap warning, empty for a bundle (spec §4.4).
    expect(result.body).toEqual({ success: true, data: { ...previewHybridOffer(body), overlaps: [] } })
    expect(prismaMock.launchCampaign.create).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.create).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('requires authentication', async () => {
    await request(app).post(path).send(body).expect(401)
  })

  it.each([StaffRole.OWNER, StaffRole.ADMIN, StaffRole.VIEWER])(
    'denies %s using the current database role, even with a stale SUPERADMIN token',
    async role => {
      jest.mocked(rolVigente).mockResolvedValue(role)
      await request(app).post(path).set('x-test-role', 'SUPERADMIN').send(body).expect(403)
    },
  )

  it('returns a Spanish 400 for malformed definitions', async () => {
    const result = await request(app)
      .post(path)
      .set('x-test-role', 'SUPERADMIN')
      .send({ offer: { ...body.offer, choiceCount: 0 } })
      .expect(400)
    expect(result.body.code).toBe('HYBRID_OFFER_INVALID')
    expect(result.body.message).toContain('cantidad mínima')
  })

  it('rejects definitions changed since the previous preview', async () => {
    const definitionHash = previewHybridOffer(body).definitionHash
    const result = await request(app)
      .post(path)
      .set('x-test-role', 'SUPERADMIN')
      .send({ ...body, offer: { ...body.offer, choiceCount: 2 }, expectedDefinitionHash: definitionHash })
      .expect(409)
    expect(result.body.code).toBe('HYBRID_OFFER_STALE')
  })

  // Codex round 2, spec §4.4: the editor's «Revisar oferta» says which ACTIVE promotions of the same product meet its
  // window. The window travels in the query string, so an older server ignores it instead of refusing the body.
  describe('overlap warning for a single-product offer', () => {
    const single = {
      offer: { schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI'], terms: body.offer.terms },
      selectedFeatureCodes: [],
    }
    const window = { campaignId: 'campaign-1', startsAt: '2026-11-01T06:00:00.000Z', endsAt: '2026-12-01T06:00:00.000Z' }

    it('lists the other ACTIVE promotion of the product with its price, excluding the campaign under review', async () => {
      prismaMock.$queryRaw.mockReset().mockResolvedValueOnce([
        {
          productKey: 'FEATURE:CFDI',
          id: 'campaign-9',
          name: 'Otoño · Facturación',
          definition: { ...single.offer, terms: { ...single.offer.terms, price: 129 } },
        },
      ])
      const result = await request(app).post(path).query(window).set('x-test-role', 'SUPERADMIN').send(single).expect(200)
      expect(result.body.data).toMatchObject({
        ...previewHybridOffer(single),
        overlaps: [{ campaignId: 'campaign-9', name: 'Otoño · Facturación', price: 129 }],
      })
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
      // The campaign under review is excluded in SQL: its id is one of the bound values.
      expect(JSON.stringify(jest.mocked(prismaMock.$queryRaw).mock.calls[0])).toContain('"campaign-1"')
    })

    it('a bundle, or a review without a window, reads nothing and warns of nothing', async () => {
      prismaMock.$queryRaw.mockReset()
      const bundle = await request(app).post(path).query(window).set('x-test-role', 'SUPERADMIN').send(body).expect(200)
      expect(bundle.body.data.overlaps).toEqual([])
      const noWindow = await request(app).post(path).set('x-test-role', 'SUPERADMIN').send(single).expect(200)
      expect(noWindow.body.data.overlaps).toEqual([])
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    })
  })

  it('keeps existing plan campaign creation incompatible with an unimplemented hybrid purchase', async () => {
    await request(app).post('/api/v1/superadmin/launch-campaigns').set('x-test-role', 'SUPERADMIN').send(body).expect(400)
    expect(prismaMock.launchCampaign.create).not.toHaveBeenCalled()
  })
})
