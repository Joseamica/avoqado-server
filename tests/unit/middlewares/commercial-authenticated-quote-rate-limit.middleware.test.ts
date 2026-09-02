import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

type LimiterModule = {
  createCommercialAuthenticatedQuoteRateLimiter(): (req: Request, res: Response, next: NextFunction) => unknown
}

function loadLimiter(): LimiterModule {
  return require('@/middlewares/commercial-authenticated-quote-rate-limit.middleware') as LimiterModule
}

function app() {
  const { createCommercialAuthenticatedQuoteRateLimiter } = loadLimiter()
  const server = express()
  server.use((req, _res, next) => {
    req.authContext = {
      userId: String(req.get('x-test-actor') ?? 'actor-a'),
      orgId: 'org-1',
      venueId: 'venue-home',
      role: 'OWNER',
    }
    next()
  })
  server.post('/venues/:venueId/quotes/from-preview', createCommercialAuthenticatedQuoteRateLimiter(), (_req, res) =>
    res.status(200).json({ ok: true }),
  )
  return server
}

function appWithoutAuthenticationContext() {
  const { createCommercialAuthenticatedQuoteRateLimiter } = loadLimiter()
  const server = express()
  server.post('/venues/:venueId/quotes/from-preview', createCommercialAuthenticatedQuoteRateLimiter(), (_req, res) =>
    res.status(200).json({ ok: true }),
  )
  server.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ success: false, code: error.code, message: error.message })
  })
  return server
}

describe('authenticated commercial quote limiter', () => {
  it('shares the 30/minute budget across target venues for one authenticated actor', async () => {
    const server = app()
    for (let index = 0; index < 30; index += 1) {
      await request(server).post(`/venues/venue-${index}/quotes/from-preview`).set('x-test-actor', 'actor-a').expect(200)
    }

    const limited = await request(server)
      .post('/venues/venue-rotated/quotes/from-preview')
      .set('x-test-actor', 'actor-a')
      .set('x-forwarded-for', '198.51.100.99')
      .expect(429)

    expect(limited.body).toEqual({
      success: false,
      code: 'COMMERCIAL_AUTHENTICATED_QUOTE_RATE_LIMITED',
      message: 'Demasiadas solicitudes de cotización.',
    })
    expect(JSON.stringify(limited.body)).not.toMatch(/actor-a|venue-rotated|198\.51\.100\.99/)
    await request(server).post('/venues/venue-rotated/quotes/from-preview').set('x-test-actor', 'actor-b').expect(200)
  })

  it('fails closed instead of sharing a fallback bucket when authentication context is absent', async () => {
    const response = await request(appWithoutAuthenticationContext()).post('/venues/venue-1/quotes/from-preview').expect(401)

    expect(response.body).toEqual({
      success: false,
      code: 'COMMERCIAL_AUTHENTICATION_REQUIRED',
      message: 'La autenticación es obligatoria para cotizar.',
    })
  })
})
