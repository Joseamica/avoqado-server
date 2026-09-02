import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

const createAuthenticatedQuote = jest.fn()
const bridgeAuthenticatedQuote = jest.fn()
const acceptQuote = jest.fn()
const createCheckout = jest.fn()
const getBillingOverview = jest.fn()
const listBillingReceipts = jest.fn()
const authenticateRequest = jest.fn((req: Request, _res: Response, next: NextFunction) => {
  req.authContext = {
    userId: 'staff-1',
    orgId: 'org-1',
    venueId: 'venue-1',
    role: 'OWNER',
  }
  next()
})
const authorizeRequest = jest.fn((_req: Request, next: NextFunction) => next())
const requestedPermissions: string[] = []
const mockEnv = { COMMERCIAL_V2_CHECKOUT_MODE: 'OFF' as 'OFF' | 'SHADOW' | 'ALLOWLIST' | 'ACTIVE' }

jest.mock('@/config/env', () => ({ env: mockEnv }))

jest.mock('@/services/commercial/commercialDirectVenueQuote.service', () => ({
  commercialDirectVenueQuoteService: { create: (...args: unknown[]) => createAuthenticatedQuote(...args) },
}))
jest.mock('@/services/commercial/commercialQuotePreviewBridge.service', () => ({
  commercialQuotePreviewBridgeService: { bridge: (...args: unknown[]) => bridgeAuthenticatedQuote(...args) },
}))
jest.mock('@/services/commercial/commercialQuoteAcceptance.service', () => ({
  commercialQuoteAcceptanceService: { accept: (...args: unknown[]) => acceptQuote(...args) },
}))
jest.mock('@/services/commercial/commercialStripeCheckoutFacade.service', () => ({
  commercialStripeCheckoutService: { createCheckout: (...args: unknown[]) => createCheckout(...args) },
}))
jest.mock('@/services/commercial/billing/commercialBillingDashboardRead.service', () => ({
  getCommercialBillingDashboardOverview: (...args: unknown[]) => getBillingOverview(...args),
  listCommercialBillingDashboardReceipts: (...args: unknown[]) => listBillingReceipts(...args),
}))
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    authenticateRequest(req, res, next)
  },
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (permission: string) => (req: Request, _res: Response, next: NextFunction) => {
    requestedPermissions.push(permission)
    return authorizeRequest(req, next)
  },
}))

import commercialRoutes from '@/routes/dashboard/commercial.routes'
import { commercialAuthenticatedQuoteRateLimiter } from '@/middlewares/commercial-authenticated-quote-rate-limit.middleware'

function app() {
  const server = express()
  server.use(express.json())
  server.use('/api/v1/dashboard/commercial', commercialRoutes)
  server.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ success: false, code: error.code, message: error.message })
  })
  return server
}

describe('authenticated commercial quote API', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    requestedPermissions.length = 0
    commercialAuthenticatedQuoteRateLimiter.resetKey('actor:staff-1')
    mockEnv.COMMERCIAL_V2_CHECKOUT_MODE = 'OFF'
  })

  it('binds persisted quote creation to JWT organization, route venue and physical staff', async () => {
    createAuthenticatedQuote.mockResolvedValue({
      id: 'quote-1',
      snapshot: { quoteId: 'quote-1', totals: { total: '58.00' } },
      checksum: 'a'.repeat(64),
    })
    const body = {
      market: 'MX',
      currency: 'MXN',
      lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
    }

    const response = await request(app()).post('/api/v1/dashboard/commercial/venues/venue-1/quotes').send(body).expect(201)

    expect(createAuthenticatedQuote).toHaveBeenCalledWith({
      organizationId: 'org-1',
      venueId: 'venue-1',
      actorId: 'staff-1',
      lines: body.lines,
    })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.data.quoteId).toBe('quote-1')
  })

  it('rejects browser authority, money and unknown route fields before the direct service', async () => {
    const response = await request(app())
      .post('/api/v1/dashboard/commercial/venues/venue-1/quotes')
      .send({
        market: 'MX',
        currency: 'MXN',
        campaignCode: 'POS_22',
        total: '22.00',
        lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      })
      .expect(400)

    expect(response.body.success).toBe(false)
    expect(createAuthenticatedQuote).not.toHaveBeenCalled()
  })

  it('bridges a sealed preview using JWT identity without generic permission/PIN middleware', async () => {
    bridgeAuthenticatedQuote.mockResolvedValue({
      outcome: 'CREATED',
      quote: { id: 'venue-quote-1', snapshot: { quoteId: 'venue-quote-1', totals: { total: '58.00' } }, checksum: 'a'.repeat(64) },
    })
    const body = {
      acquisitionBearer: 'A'.repeat(43),
      previewToken: 'sealed-preview-v2',
      normalizedLines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
    }

    const response = await request(app())
      .post('/api/v1/dashboard/commercial/venues/venue-1/quotes/from-preview')
      .set('x-permission-override', 'must-not-be-consumed')
      .send(body)
      .expect(201)

    expect(bridgeAuthenticatedQuote).toHaveBeenCalledWith({
      organizationId: 'org-1',
      venueId: 'venue-1',
      actorId: 'staff-1',
      ...body,
    })
    expect(authorizeRequest).not.toHaveBeenCalled()
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toMatchObject({ success: true, outcome: 'CREATED', data: { quoteId: 'venue-quote-1' } })
  })

  it('rejects browser totals and unknown bridge fields before durable authority work', async () => {
    await request(app())
      .post('/api/v1/dashboard/commercial/venues/venue-1/quotes/from-preview')
      .send({
        acquisitionBearer: 'A'.repeat(43),
        previewToken: 'sealed-preview-v2',
        normalizedLines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
        total: '22.00',
      })
      .expect(400)

    expect(bridgeAuthenticatedQuote).not.toHaveBeenCalled()
  })

  it('keeps bridge HTTP precedence authentication → actor limiter → validation → durable authority', async () => {
    const server = app()
    authenticateRequest.mockImplementationOnce((_req, res) => {
      res.status(401).json({ success: false, code: 'AUTH_REQUIRED' })
    })
    await request(server).post('/api/v1/dashboard/commercial/venues/venue-1/quotes/from-preview').send({ total: '22.00' }).expect(401)
    expect(bridgeAuthenticatedQuote).not.toHaveBeenCalled()

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await request(server).post('/api/v1/dashboard/commercial/venues/venue-1/quotes/from-preview').send({ total: '22.00' }).expect(400)
    }
    const limited = await request(server)
      .post('/api/v1/dashboard/commercial/venues/venue-1/quotes/from-preview')
      .send({ total: '22.00' })
      .expect(429)
    expect(limited.body.code).toBe('COMMERCIAL_AUTHENTICATED_QUOTE_RATE_LIMITED')
    expect(bridgeAuthenticatedQuote).not.toHaveBeenCalled()

    commercialAuthenticatedQuoteRateLimiter.resetKey('actor:staff-1')
    bridgeAuthenticatedQuote.mockRejectedValueOnce(
      Object.assign(new Error('Catálogo v2 requerido'), {
        statusCode: 409,
        code: 'COMMERCIAL_QUOTE_CATALOG_V2_REQUIRED',
      }),
    )
    const catalogV2Required = await request(server)
      .post('/api/v1/dashboard/commercial/venues/venue-1/quotes/from-preview')
      .send({
        acquisitionBearer: 'A'.repeat(43),
        previewToken: 'sealed-preview-v2',
        normalizedLines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      })
      .expect(409)
    expect(catalogV2Required.body.code).toBe('COMMERCIAL_QUOTE_CATALOG_V2_REQUIRED')

    bridgeAuthenticatedQuote.mockRejectedValueOnce(
      Object.assign(new Error('No autorizado'), {
        statusCode: 403,
        code: 'COMMERCIAL_PREVIEW_BRIDGE_AUTHORITY_REQUIRED',
      }),
    )
    await request(server)
      .post('/api/v1/dashboard/commercial/venues/venue-1/quotes/from-preview')
      .send({
        acquisitionBearer: 'A'.repeat(43),
        previewToken: 'sealed-preview-v2',
        normalizedLines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      })
      .expect(403)

    bridgeAuthenticatedQuote.mockRejectedValueOnce(
      Object.assign(new Error('Oferta reemplazada'), {
        statusCode: 409,
        code: 'COMMERCIAL_PREVIEW_SUPERSEDED',
      }),
    )
    const superseded = await request(server)
      .post('/api/v1/dashboard/commercial/venues/venue-1/quotes/from-preview')
      .send({
        acquisitionBearer: 'A'.repeat(43),
        previewToken: 'sealed-preview-v2',
        normalizedLines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      })
      .expect(409)
    expect(superseded.body.code).toBe('COMMERCIAL_PREVIEW_SUPERSEDED')
    expect(bridgeAuthenticatedQuote).toHaveBeenCalledTimes(3)
  })

  it('takes idempotency only from the header and identity only from authentication', async () => {
    mockEnv.COMMERCIAL_V2_CHECKOUT_MODE = 'ACTIVE'
    acceptQuote.mockResolvedValue({ id: 'acceptance-1', quoteId: 'quote-1', status: 'ACCEPTED' })

    const response = await request(app())
      .post('/api/v1/dashboard/commercial/venues/venue-1/quotes/quote-1/accept')
      .set('Idempotency-Key', 'accept-quote-1-123456')
      .send({ organizationId: 'attacker-org', acceptedById: 'attacker' })
      .expect(200)

    expect(acceptQuote).toHaveBeenCalledWith({
      quoteId: 'quote-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      acceptedById: 'staff-1',
      idempotencyKey: 'accept-quote-1-123456',
    })
    expect(response.body.data.status).toBe('ACCEPTED')
  })

  it('rejects quote acceptance while OFF before authentication, permission or acceptance dependencies', async () => {
    const response = await request(app())
      .post('/api/v1/dashboard/commercial/venues/venue-1/quotes/quote-1/accept')
      .set('Idempotency-Key', 'accept-quote-1-123456')
      .send()
      .expect(503)

    expect(response.body.code).toBe('COMMERCIAL_V2_CHECKOUT_DISABLED')
    expect(authenticateRequest).not.toHaveBeenCalled()
    expect(authorizeRequest).not.toHaveBeenCalled()
    expect(acceptQuote).not.toHaveBeenCalled()
  })

  it('rejects remote checkout by default before the controller can reach checkout state or Stripe', async () => {
    const response = await request(app())
      .post('/api/v1/dashboard/commercial/venues/venue-1/quote-acceptances/acceptance-1/checkout')
      .send()
      .expect(503)

    expect(response.body.code).toBe('COMMERCIAL_V2_CHECKOUT_DISABLED')
    expect(authenticateRequest).not.toHaveBeenCalled()
    expect(authorizeRequest).not.toHaveBeenCalled()
    expect(createCheckout).not.toHaveBeenCalled()
  })

  it('allows ACTIVE mode to reach the existing exact-quote checkout path', async () => {
    mockEnv.COMMERCIAL_V2_CHECKOUT_MODE = 'ACTIVE'
    createCheckout.mockResolvedValue({
      checkoutSessionId: 'cs_test_1',
      checkoutUrl: 'https://checkout.stripe.test/cs_test_1',
    })

    const response = await request(app())
      .post('/api/v1/dashboard/commercial/venues/venue-1/quote-acceptances/acceptance-1/checkout')
      .send({ totalMinor: 1, quoteId: 'attacker-quote', organizationId: 'attacker-org' })
      .expect(201)

    expect(createCheckout).toHaveBeenCalledWith({
      acceptanceId: 'acceptance-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
    })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.data.checkoutUrl).toBe('https://checkout.stripe.test/cs_test_1')
  })

  it('reads the commercial billing overview only from JWT organization and route venue', async () => {
    getBillingOverview.mockResolvedValue({
      schemaVersion: 1,
      state: 'READY',
      collectionState: 'CURRENT',
      contract: { id: 'contract-1', today: { totalMinor: '28884' } },
    })

    const response = await request(app())
      .get('/api/v1/dashboard/commercial/venues/venue-1/billing/overview')
      .expect(200)

    expect(getBillingOverview).toHaveBeenCalledWith({ organizationId: 'org-1', venueId: 'venue-1' })
    expect(requestedPermissions).toContain('billing:subscriptions:read')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.data.contract.today.totalMinor).toBe('28884')
  })

  it('rejects browser-supplied tenant identity before reading commercial billing', async () => {
    await request(app())
      .get('/api/v1/dashboard/commercial/venues/venue-1/billing/overview?organizationId=attacker-org')
      .expect(400)

    expect(getBillingOverview).not.toHaveBeenCalled()
    expect(authorizeRequest).not.toHaveBeenCalled()
  })

  it('passes only validated cursor pagination to tenant-scoped receipt history', async () => {
    listBillingReceipts.mockResolvedValue({
      schemaVersion: 1,
      state: 'READY',
      items: [{ id: 'receipt-2', amountMinor: '28884' }],
      nextCursor: null,
    })

    const response = await request(app())
      .get('/api/v1/dashboard/commercial/venues/venue-1/billing/receipts?cursor=receipt-3&limit=2')
      .expect(200)

    expect(listBillingReceipts).toHaveBeenCalledWith({
      organizationId: 'org-1',
      venueId: 'venue-1',
      cursor: 'receipt-3',
      limit: 2,
    })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.data.items[0].amountMinor).toBe('28884')
  })
})
