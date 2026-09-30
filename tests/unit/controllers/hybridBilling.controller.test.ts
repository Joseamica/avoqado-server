import express from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'
const quote = jest.fn(),
  accept = jest.fn(),
  provision = jest.fn(),
  recover = jest.fn(),
  cancel = jest.fn()
jest.mock('@/services/launchCampaigns/hybridPurchase.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridPurchase.service'),
  createHybridQuote: (...args: unknown[]) => quote(...args),
  acceptHybridQuote: (...args: unknown[]) => accept(...args),
  assertHybridSalesOpen: jest.fn(),
}))
jest.mock('@/services/launchCampaigns/hybridProvision.service', () => ({
  provisionHybridPurchase: (...args: unknown[]) => provision(...args),
}))
jest.mock('@/services/launchCampaigns/hybridLifecycle.service', () => ({
  reconcileHybridPurchase: (...args: unknown[]) => recover(...args),
  cancelHybridPurchase: (...args: unknown[]) => cancel(...args),
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) =>
    req.headers['x-test-permission'] === permission ? next() : res.status(403).json({ error: 'denied' }),
}))
import billingRouter from '@/routes/dashboard/hybridBilling.routes'
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.authContext = { userId: 'staff', venueId: 'jwt-old-venue' } as never
  next()
})
app.use('/venues/:venueId/hybrid-billing', billingRouter)
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
  res.status(error.statusCode ?? 500).json({ code: error.code, message: error.message }),
)
const base = '/venues/actual-venue/hybrid-billing'
const manage = 'billing:subscriptions:manage'
beforeEach(() => {
  quote
    .mockReset()
    .mockResolvedValue({ id: 'quote', quote: { total: '379.50' }, quoteHash: 'hash', quoteExpiresAt: new Date(), status: 'QUOTED' })
  accept.mockReset().mockResolvedValue({ id: 'purchase', status: 'ACCEPTED' })
  provision
    .mockReset()
    .mockResolvedValue({ purchaseId: 'purchase', status: 'PAYMENT_PENDING', paymentUrl: 'https://invoice.stripe.com/i/test' })
  recover.mockReset().mockResolvedValue({ status: 'ACTIVE' })
  cancel.mockReset().mockResolvedValue({ status: 'CANCELLED' })
})
describe('hybrid billing HTTP contract', () => {
  it('requires the existing manage permission for every money mutation', async () => {
    for (const suffix of ['/quotes', '/purchases/purchase/accept', '/purchases/purchase/resume', '/purchases/purchase/cancel'])
      await request(app)
        .post(base + suffix)
        .send({})
        .expect(403)
    expect(quote).not.toHaveBeenCalled()
    expect(accept).not.toHaveBeenCalled()
    expect(provision).not.toHaveBeenCalled()
  })
  it('quotes against the route venue and never accepts a body venue or price as authority', async () => {
    const body = { lines: [] }
    const result = await request(app)
      .post(base + '/quotes')
      .set('x-test-permission', manage)
      .send(body)
      .expect(201)
    expect(quote).toHaveBeenCalledWith('actual-venue', 'staff', body)
    expect(result.body.data.quote.total).toBe('379.50')
  })
  it('persists acceptance before creating the same recoverable payment', async () => {
    await request(app)
      .post(base + '/purchases/purchase/accept')
      .set('x-test-permission', manage)
      .send({ quoteHash: 'hash', clientKey: 'attempt' })
      .expect(202)
    expect(accept).toHaveBeenCalledWith('actual-venue', 'staff', 'purchase', expect.anything())
    expect(accept.mock.invocationCallOrder[0]).toBeLessThan(provision.mock.invocationCallOrder[0])
  })
  it('scopes status reads to the venue and omits internal provider bodies', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({
      id: 'purchase',
      status: 'PAYMENT_PENDING',
      quote: { total: '379.50' },
      quoteHash: 'hash',
      stripeCustomerId: 'private',
      lastIssue: null,
    })
    const result = await request(app)
      .get(base + '/purchases/purchase')
      .set('x-test-permission', 'billing:subscriptions:read')
      .expect(200)
    expect(prismaMock.hybridPurchase.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'purchase', venueId: 'actual-venue' } }),
    )
    expect(result.body.data).not.toHaveProperty('stripeCustomerId')
    expect(provision).not.toHaveBeenCalled()
  })
})
