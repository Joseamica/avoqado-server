import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import commercialFixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import { CommercialCatalogAuthorityError } from '@/services/commercial/commercialCatalogAuthority.service'
import { getCorsConfig } from '@/config/corsOptions'

const getActiveCommercialCatalog = jest.fn()
const issueAcquisitionContext = jest.fn()
const previewQuote = jest.fn()
const previewQuoteV2 = jest.fn()

jest.mock('@/services/commercial/commercialRead.service', () => ({
  getActiveCommercialCatalog: (...args: unknown[]) => getActiveCommercialCatalog(...args),
}))
jest.mock('@/services/commercial/commercialAcquisitionContext.service', () => ({
  commercialAcquisitionContextService: { issue: (...args: unknown[]) => issueAcquisitionContext(...args) },
}))
jest.mock('@/services/commercial/commercialQuoteAuthority.service', () => ({
  commercialQuoteAuthorityService: { previewQuote: (...args: unknown[]) => previewQuote(...args) },
}))
jest.mock('@/services/commercial/commercialPublicQuotePreviewV2.service', () => ({
  commercialPublicQuotePreviewV2Service: { preview: (...args: unknown[]) => previewQuoteV2(...args) },
}))

import commercialRoutes from '@/routes/public/commercial.routes'

function app() {
  const server = express()
  server.use(express.json())
  server.use('/api/v1/public/commercial', commercialRoutes)
  server.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ success: false, code: error.code, message: error.message })
  })
  return server
}

const catalog = {
  snapshot: commercialFixture,
  etag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
  fallback: null,
}

describe('GET /api/v1/public/commercial/catalog', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns a stable 404 before the first activation', async () => {
    getActiveCommercialCatalog.mockResolvedValue(null)

    const response = await request(app()).get('/api/v1/public/commercial/catalog').expect(404)
    expect(response.body).toMatchObject({ success: false, code: 'COMMERCIAL_CATALOG_NOT_ACTIVE' })
  })

  it('returns only the safe snapshot with cache and ETag headers', async () => {
    getActiveCommercialCatalog.mockResolvedValue(catalog)

    const response = await request(app()).get('/api/v1/public/commercial/catalog').expect(200)

    expect(response.headers.etag).toBe(catalog.etag)
    expect(response.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300')
    expect(response.body).toEqual({ success: true, data: catalog.snapshot })
    expect(JSON.stringify(response.body)).not.toMatch(/internalCost|payout|commissionRate|marginAmount/i)
  })

  it('returns 304 without a body for a matching If-None-Match', async () => {
    getActiveCommercialCatalog.mockResolvedValue(catalog)

    const response = await request(app()).get('/api/v1/public/commercial/catalog').set('If-None-Match', catalog.etag).expect(304)

    expect(response.text).toBe('')
  })

  it('explains through headers when it serves the last compatible activation', async () => {
    getActiveCommercialCatalog.mockResolvedValue({
      ...catalog,
      fallback: {
        activePublicationId: 'publication-v2',
        servedPublicationId: commercialFixture.publicationId,
        reason: 'ACTIVE_SCHEMA_INCOMPATIBLE',
      },
    })

    const response = await request(app()).get('/api/v1/public/commercial/catalog').expect(200)

    expect(response.headers['x-avoqado-commercial-fallback']).toBe('verified-compatible')
    expect(response.headers['x-avoqado-commercial-active-publication']).toBe('publication-v2')
    expect(response.headers['x-avoqado-commercial-served-publication']).toBe(commercialFixture.publicationId)
    expect(response.body.data).toEqual(commercialFixture)
  })

  it.each([
    ['COMMERCIAL_CATALOG_AUTHORITY_INVALID', 'COMMERCIAL_CATALOG_AUTHORITY_INVALID'],
    ['COMMERCIAL_CATALOG_VERSION_UNSUPPORTED', 'COMMERCIAL_CATALOG_VERSION_UNSUPPORTED'],
  ] as const)('maps %s to a stable public 503 without internal artifact data', async (authorityCode, publicCode) => {
    getActiveCommercialCatalog.mockRejectedValue(new CommercialCatalogAuthorityError(authorityCode))

    const response = await request(app()).get('/api/v1/public/commercial/catalog').expect(503)

    expect(response.body).toEqual({
      success: false,
      code: publicCode,
      message: expect.any(String),
    })
    expect(JSON.stringify(response.body)).not.toMatch(/snapshot|checksum|publicationId|stack/i)
  })

  it('exposes every browser-readable commercial cache/provenance header through CORS', () => {
    expect(getCorsConfig('production').exposedHeaders).toEqual(
      expect.arrayContaining([
        'ETag',
        'X-Avoqado-Commercial-Fallback',
        'X-Avoqado-Commercial-Active-Publication',
        'X-Avoqado-Commercial-Served-Publication',
      ]),
    )
  })

  it.each([
    'W/"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    '"stale", W/"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    '*',
  ])('uses weak comparison and comma-separated validators for If-None-Match: %s', async ifNoneMatch => {
    getActiveCommercialCatalog.mockResolvedValue(catalog)

    await request(app()).get('/api/v1/public/commercial/catalog').set('If-None-Match', ifNoneMatch).expect(304)
  })
})

describe('public commercial acquisition and quote APIs', () => {
  beforeEach(() => jest.clearAllMocks())

  it('issues an opaque acquisition context without returning authoritative price fields', async () => {
    issueAcquisitionContext.mockResolvedValue({ token: 'A'.repeat(43), expiresAt: '2026-08-22T16:00:00.000Z' })

    const response = await request(app())
      .post('/api/v1/public/commercial/acquisition-context')
      .send({ campaignClaim: 'C'.repeat(43), utmSource: 'facebook' })
      .expect(201)

    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({
      success: true,
      data: { token: 'A'.repeat(43), expiresAt: '2026-08-22T16:00:00.000Z' },
    })
    expect(issueAcquisitionContext).toHaveBeenCalledWith({ campaignClaim: 'C'.repeat(43), utmSource: 'facebook' }, expect.any(Date))
    expect(JSON.stringify(response.body)).not.toMatch(/amountMinor|priceId|discountMinor/)
  })

  it('rejects raw campaign, paid-channel and source fields before they reach price authority', async () => {
    await request(app())
      .post('/api/v1/public/commercial/acquisition-context')
      .send({ campaignCode: 'POS_INTRO_2026', channel: 'PAID_META', sourceRef: 'attacker' })
      .expect(400)

    expect(issueAcquisitionContext).not.toHaveBeenCalled()
  })

  it('returns the Server quote disclosure and strips internal checksum/context ids', async () => {
    previewQuote.mockResolvedValue({
      quote: {
        quoteId: 'quote-preview-1',
        totals: { listSubtotalMinor: 24900, discountMinor: 19900, subtotalMinor: 5000, taxMinor: 800, totalMinor: 5800 },
        renewal: { subtotalMinor: 24900, taxMinor: 3984, totalMinor: 28884 },
      },
      checksum: 'a'.repeat(64),
      acquisitionContextId: 'internal-acquisition-id',
    })

    const body = {
      market: 'MX',
      currency: 'MXN',
      acquisitionToken: 'A'.repeat(43),
      lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
    }
    const response = await request(app()).post('/api/v1/public/commercial/quotes/preview').send(body).expect(200)

    expect(previewQuote).toHaveBeenCalledWith(body)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({ success: true, data: expect.objectContaining({ quoteId: 'quote-preview-1' }) })
    expect(JSON.stringify(response.body)).not.toContain('internal-acquisition-id')
    expect(JSON.stringify(response.body)).not.toContain('a'.repeat(64))
  })

  it('returns the exact v2 quote plus signed preview token with no-store and no wrapper checksum', async () => {
    const body = {
      market: 'MX',
      currency: 'MXN',
      acquisitionToken: 'A'.repeat(43),
      lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
    }
    previewQuoteV2.mockResolvedValue({
      quote: {
        schemaVersion: 2,
        quoteId: 'quote-preview-v2',
        acquisitionContextId: 'acquisition-v2',
        totals: { listSubtotal: '249.00', discount: '199.00', subtotal: '50.00', tax: '8.00', total: '58.00' },
      },
      previewToken: 'v2.canonical-payload.signature',
    })

    const response = await request(app()).post('/api/v1/public/commercial/quotes/preview-v2').send(body).expect(200)

    expect(previewQuoteV2).toHaveBeenCalledWith(body, 'commercial-correlation-unavailable')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({
      success: true,
      data: {
        quote: expect.objectContaining({ schemaVersion: 2, quoteId: 'quote-preview-v2' }),
        previewToken: 'v2.canonical-payload.signature',
      },
    })
    expect(response.body.data).not.toHaveProperty('checksum')
  })

  it('rejects forbidden v2 authority fields before calling the preview service', async () => {
    await request(app())
      .post('/api/v1/public/commercial/quotes/preview-v2')
      .send({
        market: 'MX',
        currency: 'MXN',
        acquisitionToken: 'A'.repeat(43),
        campaignVersionId: 'attacker-campaign',
        lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1, total: '22.00' }],
      })
      .expect(400)

    expect(previewQuoteV2).not.toHaveBeenCalled()
  })
})
