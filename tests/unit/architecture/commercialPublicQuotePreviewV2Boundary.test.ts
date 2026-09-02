import fs from 'node:fs'
import path from 'node:path'

const source = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')

describe('commercial public quote preview v2 boundary', () => {
  it('mounts one additive v2 route while retaining the exact legacy preview route', () => {
    const routes = source('src/routes/public/commercial.routes.ts')
    const parentRoutes = source('src/routes/public.routes.ts')

    expect(routes).toMatch(
      /router\.post\(\s*'\/quotes\/preview',\s*validateRequest\(commercialQuotePreviewRequestSchema\),\s*previewCommercialQuote\s*\)/,
    )
    expect(routes).toMatch(
      /router\.post\(\s*'\/quotes\/preview-v2',\s*commercialQuotePreviewV2RateLimiter,\s*validateRequest\(commercialPublicQuotePreviewV2HttpRequestSchema\),\s*previewCommercialQuoteV2,?\s*\)/,
    )
    expect(routes).toMatch(
      /router\.post\(\s*'\/acquisition-context',\s*commercialAcquisitionContextRateLimiter,\s*validateRequest\(commercialAcquisitionContextRequestSchema\),\s*createCommercialAcquisitionContext,?\s*\)/,
    )
    expect(parentRoutes).toContain("router.use('/commercial', commercialPublicParentRateLimiter, commercialRoutes)")
    expect(parentRoutes).not.toContain("router.use('/commercial', readLimit, commercialRoutes)")
  })

  it('keeps the v2 preview path read-only and free of quote, bridge, audit or outbox writers', () => {
    const service = source('src/services/commercial/commercialPublicQuotePreviewV2.service.ts')
    const controller = source('src/controllers/public/commercial.public.controller.ts')
    const forbidden = [
      /prismaClient/,
      /\.commercialQuote\.(?:create|update|upsert|delete)/,
      /ActivityLog/,
      /Outbox/,
      /persistQuote/,
      /persistBridge/,
    ]

    for (const pattern of forbidden) {
      expect(service).not.toMatch(pattern)
      expect(controller).not.toMatch(pattern)
    }
    expect(controller).toContain(
      "commercialPublicQuotePreviewV2Service.preview(req.body, req.correlationId ?? 'commercial-correlation-unavailable')",
    )
    expect(controller).toContain("res.setHeader('Cache-Control', 'no-store')")
  })

  it('keeps additive v2 request authority outside the byte-frozen C4 schema and makes the service consume it directly', () => {
    const legacySchema = source('src/schemas/commercialQuote.schema.ts')
    const v2Schema = source('src/schemas/commercialQuoteV2.schema.ts')
    const service = source('src/services/commercial/commercialPublicQuotePreviewV2.service.ts')
    const routes = source('src/routes/public/commercial.routes.ts')

    expect(legacySchema).not.toContain('commercialPublicQuotePreviewRequestV2Schema')
    expect(v2Schema).toContain("import { commercialQuoteRequestSchema } from './commercialQuote.schema'")
    expect(v2Schema).toContain('commercialQuoteRequestSchema.shape.lines.element')
    expect(service).toContain("import { commercialPublicQuotePreviewRequestV2Schema } from '@/schemas/commercialQuoteV2.schema'")
    expect(service).toContain('commercialPublicQuotePreviewRequestV2Schema.safeParse(input)')
    expect(routes).toContain("from '@/schemas/commercialQuoteV2.schema'")
  })
})
