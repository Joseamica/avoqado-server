import express, { type Request } from 'express'
import request from 'supertest'
import { createCommercialPublicRateLimiters } from '@/middlewares/commercial-public-rate-limit.middleware'
import { createCommercialLimiterKeyResolver } from '@/services/commercial/commercialLimiterKeyResolver.service'

const body = {
  success: false,
  code: 'COMMERCIAL_PUBLIC_RATE_LIMITED',
  message: 'Demasiadas solicitudes.',
}

function limiterApp() {
  const keyResolver = (req: Request) => String(req.get('x-test-resolved-key') ?? 'test-fail-safe')
  const limiters = createCommercialPublicRateLimiters({ keyResolver })
  const child = express.Router()
  child.get('/catalog', (_req, res) => res.status(200).json({ ok: true }))
  child.post('/acquisition-context', limiters.acquisitionContext, (_req, res) => res.status(200).json({ ok: true }))
  child.post('/quotes/preview-v2', limiters.quotePreviewV2, (_req, res) => res.status(200).json({ ok: true }))
  const server = express()
  server.set('trust proxy', 1)
  server.use('/commercial', limiters.parent, child)
  return server
}

describe('commercial public rate limits', () => {
  it('enforces independent effective acquisition=10 and preview=30 child caps', async () => {
    const server = limiterApp()
    for (let count = 0; count < 10; count += 1) {
      await request(server).post('/commercial/acquisition-context').set('x-test-resolved-key', 'acquisition-a').expect(200)
    }
    const acquisition429 = await request(server)
      .post('/commercial/acquisition-context')
      .set('x-test-resolved-key', 'acquisition-a')
      .expect(429)
    expect(acquisition429.body).toEqual(body)
    await request(server).get('/commercial/catalog').set('x-test-resolved-key', 'acquisition-a').expect(200)
    await request(server).post('/commercial/acquisition-context').set('x-test-resolved-key', 'acquisition-b').expect(200)

    for (let count = 0; count < 30; count += 1) {
      await request(server).post('/commercial/quotes/preview-v2').set('x-test-resolved-key', 'preview-a').expect(200)
    }
    const preview429 = await request(server).post('/commercial/quotes/preview-v2').set('x-test-resolved-key', 'preview-a').expect(429)
    expect(preview429.body).toEqual(body)
    await request(server).post('/commercial/quotes/preview-v2').set('x-test-resolved-key', 'preview-b').expect(200)
  })

  it('enforces the shared commercial parent cap at 60 before a child handler', async () => {
    const server = limiterApp()
    for (let count = 0; count < 60; count += 1) {
      await request(server).get('/commercial/catalog').set('x-test-resolved-key', 'parent-a').expect(200)
    }
    const response = await request(server).post('/commercial/quotes/preview-v2').set('x-test-resolved-key', 'parent-a').expect(429)

    expect(response.body).toEqual(body)
    expect(JSON.stringify({ body: response.body, headers: response.headers })).not.toContain('parent-a')
  })

  it('records Express trust-proxy=1 behavior without treating raw forwarding metadata as limiter authority', async () => {
    const keyResolver = createCommercialLimiterKeyResolver({ processHmacKey: Buffer.alloc(32, 9) })
    const server = express()
    server.set('trust proxy', 1)
    server.get('/resolved', (req, res) => res.json({ key: keyResolver(req) }))

    const plain = await request(server).get('/resolved')
    const cfOnly = await request(server).get('/resolved').set('CF-Connecting-IP', '198.51.100.20')
    const forwarded = await request(server).get('/resolved').set('X-Forwarded-For', '198.51.100.21')
    const both = await request(server).get('/resolved').set('CF-Connecting-IP', '198.51.100.22').set('X-Forwarded-For', '198.51.100.21')

    expect(cfOnly.body.key).toBe(plain.body.key)
    expect(both.body.key).toBe(forwarded.body.key)
    expect(forwarded.body.key).not.toBe(plain.body.key)
  })
})
