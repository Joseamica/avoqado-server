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
const board = jest.fn(),
  save = jest.fn(),
  retry = jest.fn(),
  listStatus = jest.fn(),
  gapSummary = jest.fn(),
  gapVenues = jest.fn(),
  preview = jest.fn(),
  create = jest.fn(),
  groups = jest.fn(),
  group = jest.fn(),
  groupStatus = jest.fn(),
  recalculate = jest.fn()
jest.mock('@/services/launchCampaigns/hybridListPrice.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridListPrice.service'),
  listPriceBoard: (...args: unknown[]) => board(...args),
  saveListPrice: (...args: unknown[]) => save(...args),
  retryListPrice: (...args: unknown[]) => retry(...args),
  setListPriceStatus: (...args: unknown[]) => listStatus(...args),
}))
jest.mock('@/services/launchCampaigns/hybridPriceGap.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridPriceGap.service'),
  priceGapSummary: (...args: unknown[]) => gapSummary(...args),
  priceGapVenues: (...args: unknown[]) => gapVenues(...args),
}))
jest.mock('@/services/launchCampaigns/hybridPromotionGroup.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridPromotionGroup.service'),
  previewPercentPromotion: (...args: unknown[]) => preview(...args),
  createPercentPromotion: (...args: unknown[]) => create(...args),
  listPromotionGroups: (...args: unknown[]) => groups(...args),
  getPromotionGroup: (...args: unknown[]) => group(...args),
  setPromotionGroupStatus: (...args: unknown[]) => groupStatus(...args),
  recalculatePromotionGroup: (...args: unknown[]) => recalculate(...args),
}))

import superadminRouter from '@/routes/superadmin.routes'
import { rolVigente } from '@/services/access/rolVigente'
import { ConflictError } from '@/errors/AppError'

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
const base = '/api/v1/superadmin/hybrid-pricing'
const as = (call: request.Test) => call.set('x-test-role', 'SUPERADMIN')
const row = { productKey: 'FEATURE:CFDI', price: 199, revision: 4 }

beforeEach(() => {
  jest.mocked(rolVigente).mockResolvedValue(StaffRole.SUPERADMIN)
  for (const fn of [board, save, retry, listStatus, gapSummary, gapVenues, preview, create, groups, group, groupStatus, recalculate])
    fn.mockReset().mockResolvedValue(row)
})

describe('superadmin «Precios» HTTP contract', () => {
  it('saves a list price with numbers from the body and the authenticated superadmin', async () => {
    const result = await as(request(app).put(`${base}/lists/FEATURE%3ACFDI`))
      .send({ price: 199, expectedRevision: 3 })
      .expect(200)
    expect(save).toHaveBeenCalledWith({ productKey: 'FEATURE:CFDI', price: 199, expectedRevision: 3 }, 'superadmin-1')
    expect(result.body).toEqual({ success: true, data: row })
  })

  it('accepts the first price of a function, which has no revision yet', async () => {
    await as(request(app).put(`${base}/lists/FEATURE:CFDI`))
      .send({ price: 249.5, expectedRevision: null })
      .expect(200)
    expect(save).toHaveBeenCalledWith({ productKey: 'FEATURE:CFDI', price: 249.5, expectedRevision: null }, 'superadmin-1')
  })

  it.each([
    ['a price sent as text', { price: '199', expectedRevision: 3 }],
    ['a missing revision', { price: 199 }],
    ['an unknown field', { price: 199, expectedRevision: 3, status: 'ACTIVE' }],
  ])('rejects %s with a Spanish 400 and saves nothing', async (_label, body) => {
    const result = await as(request(app).put(`${base}/lists/FEATURE%3ACFDI`))
      .send(body)
      .expect(400)
    expect(result.body.code).toBe('HYBRID_PRICING_INVALID')
    expect(save).not.toHaveBeenCalled()
  })

  it.each(['FEATURE%3Acfdi', 'PLAN%3AFREE', 'OTHER%3ACFDI', 'FEATURE%3ACFDI%25', '%E0%A4%A'])(
    'rejects the product key %s before calling any service',
    async key => {
      const result = await as(request(app).put(`${base}/lists/${key}`)).send({ price: 199, expectedRevision: 3 })
      expect(result.status).toBe(400)
      expect(save).not.toHaveBeenCalled()
    },
  )

  it('passes the promotions a list would break back with their code and details', async () => {
    const violations = [{ campaignId: 'c1', campaignName: 'CFDI 20 %', price: 479.2, renewalPrice: 599, listPrice: 450, revision: 2 }]
    save.mockRejectedValue(new ConflictError('Rompe promociones.', 'HYBRID_LIST_BREAKS_PROMOTIONS', violations))
    const result = await as(request(app).put(`${base}/lists/FEATURE%3ACFDI`))
      .send({ price: 450, expectedRevision: 3 })
      .expect(409)
    expect(result.body).toMatchObject({ code: 'HYBRID_LIST_BREAKS_PROMOTIONS', details: violations })
  })

  it('reads the board, retries a pending price and changes a list status', async () => {
    await as(request(app).get(base)).expect(200)
    expect(board).toHaveBeenCalledWith()
    await as(request(app).post(`${base}/lists/FEATURE%3ACFDI/retry`)).expect(200)
    expect(retry).toHaveBeenCalledWith('FEATURE:CFDI', 'superadmin-1')
    await as(request(app).post(`${base}/lists/FEATURE%3ACFDI/status`))
      .send({ status: 'PAUSED', expectedRevision: 5 })
      .expect(200)
    expect(listStatus).toHaveBeenCalledWith({ productKey: 'FEATURE:CFDI', status: 'PAUSED', expectedRevision: 5 }, 'superadmin-1')
    await as(request(app).post(`${base}/lists/FEATURE%3ACFDI/status`))
      .send({ status: 'ENDED', expectedRevision: 5 })
      .expect(400)
    expect(listStatus).toHaveBeenCalledTimes(1)
  })

  it('reads the gap summary and pages «Ver quiénes» within the server caps', async () => {
    await as(request(app).get(`${base}/gaps`)).expect(200)
    expect(gapSummary).toHaveBeenCalledWith()
    await as(request(app).get(`${base}/gaps/FEATURE%3ACFDI`)).expect(200)
    expect(gapVenues).toHaveBeenLastCalledWith('FEATURE:CFDI', 1, 50)
    await as(request(app).get(`${base}/gaps/FEATURE%3ACFDI?page=2&pageSize=10`)).expect(200)
    expect(gapVenues).toHaveBeenLastCalledWith('FEATURE:CFDI', 2, 10)
    for (const query of ['page=0', 'page=10001', 'page=Infinity', 'pageSize=101', 'pageSize=0', 'sort=gap'])
      await as(request(app).get(`${base}/gaps/FEATURE%3ACFDI?${query}`)).expect(400)
    expect(gapVenues).toHaveBeenCalledTimes(2)
  })

  it('serves the «% de descuento» groups: list, preview, create, detail, status and recalculate', async () => {
    await as(request(app).get(`${base}/percent?page=2&pageSize=10&status=PAUSED`)).expect(200)
    expect(groups).toHaveBeenCalledWith({ page: '2', pageSize: '10', status: 'PAUSED' })
    const body = { name: 'Septiembre', percentOff: 20 }
    await as(request(app).post(`${base}/percent/preview`))
      .send(body)
      .expect(200)
    expect(preview).toHaveBeenCalledWith(body)
    await as(request(app).post(`${base}/percent`))
      .send(body)
      .expect(201)
    expect(create).toHaveBeenCalledWith(body, 'superadmin-1')
    await as(request(app).get(`${base}/percent/group-1`)).expect(200)
    expect(group).toHaveBeenCalledWith('group-1')
    await as(request(app).post(`${base}/percent/group-1/status`))
      .send({ status: 'PAUSED', expectedRevision: 2 })
      .expect(200)
    expect(groupStatus).toHaveBeenCalledWith('group-1', { status: 'PAUSED', expectedRevision: 2 }, 'superadmin-1')
    await as(request(app).post(`${base}/percent/group-1/recalculate`))
      .send({ expectedRevision: 3 })
      .expect(200)
    expect(recalculate).toHaveBeenCalledWith('group-1', 3, 'superadmin-1')
    await as(request(app).post(`${base}/percent/group-1/recalculate`))
      .send({ expectedRevision: '3' })
      .expect(400)
    expect(recalculate).toHaveBeenCalledTimes(1)
  })

  it('inherits the SUPERADMIN guard: no token is 401, a current non-superadmin role is 403', async () => {
    await request(app).get(base).expect(401)
    jest.mocked(rolVigente).mockResolvedValue(StaffRole.OWNER)
    await as(request(app).put(`${base}/lists/FEATURE%3ACFDI`))
      .send({ price: 199, expectedRevision: 3 })
      .expect(403)
    expect(board).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  // Regression: the campaign editor next door keeps its routes.
  it('still serves the configurable-campaign routes', async () => {
    const result = await as(request(app).get('/api/v1/superadmin/hybrid-campaigns/catalog')).expect(200)
    expect(result.body.success).toBe(true)
  })
})
