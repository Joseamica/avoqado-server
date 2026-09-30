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
    expect(result.body).toEqual({ success: true, data: previewHybridOffer(body) })
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

  it('keeps existing plan campaign creation incompatible with an unimplemented hybrid purchase', async () => {
    await request(app).post('/api/v1/superadmin/launch-campaigns').set('x-test-role', 'SUPERADMIN').send(body).expect(400)
    expect(prismaMock.launchCampaign.create).not.toHaveBeenCalled()
  })
})
