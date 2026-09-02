import { registerCommercialTools } from '@/mcp/tools/commercial'
import type { McpScope } from '@/mcp/scope'
import { CommercialArtifactCodecError } from '@/services/commercial/commercialArtifactCodecRegistry.service'

const getActiveCommercialCatalog = jest.fn()
const previewQuote = jest.fn()
const resolveActiveVersion = jest.fn()
jest.mock('@/services/commercial/commercialCatalogAuthority.service', () => ({
  readVerifiedActiveCatalog: jest.fn(),
  CommercialCatalogAuthorityError: class CommercialCatalogAuthorityError extends Error {},
}))
jest.mock('@/services/commercial/commercialRead.service', () => ({
  getActiveCommercialCatalog: (...args: unknown[]) => getActiveCommercialCatalog(...args),
}))
jest.mock('@/services/commercial/commercialQuoteAuthority.service', () => ({
  commercialQuoteAuthorityService: { previewQuote: (...args: unknown[]) => previewQuote(...args) },
}))

const handlers = new Map<string, (args: any) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 'staff_1',
  activeOrg: 'org_1',
  allowedVenueIds: ['venue_1'],
  perVenueAccess: new Map(),
} as unknown as McpScope

describe('commercial_catalog MCP tool', () => {
  beforeAll(() => {
    registerCommercialTools(
      { tool: (...args: unknown[]) => handlers.set(args[0] as string, args[args.length - 1] as never) } as never,
      scope,
      { resolveActiveVersion },
    )
  })
  beforeEach(() => {
    jest.clearAllMocks()
    resolveActiveVersion.mockResolvedValue('ACTIVE_V1')
  })

  it('returns the safe catalog in major MXN units and anchors POS at $249', async () => {
    const catalog = {
      etag: '"abc"',
      snapshot: {
        schemaVersion: 1,
        publicationId: 'pub_1',
        products: [
          {
            code: 'POS',
            prices: [
              {
                code: 'POS_MONTHLY',
                billingUnit: 'VENUE_MONTH',
                amountMinor: 24_900,
                currency: 'MXN',
                taxBehavior: 'EXCLUSIVE',
                taxRateBasisPoints: 1600,
              },
            ],
          },
        ],
        bundles: [],
      },
    }
    getActiveCommercialCatalog.mockResolvedValue(catalog)

    const result = await handlers.get('commercial_catalog')!({})
    const data = JSON.parse(result.content[0].text)

    expect(data.active).toBe(true)
    expect(data.etag).toBe(catalog.etag)
    expect(data.catalog.products[0].prices[0]).toMatchObject({ amountMxn: 249, currency: 'MXN' })
    expect(JSON.stringify(data)).not.toContain('amountMinor')
    expect(JSON.stringify(data)).not.toMatch(/cost|payout|commission|margin/i)
  })

  it('explains that no offer is active instead of inventing a fallback price', async () => {
    resolveActiveVersion.mockResolvedValue('MISSING')

    const result = await handlers.get('commercial_catalog')!({})

    expect(JSON.parse(result.content[0].text)).toEqual({
      active: false,
      code: 'COMMERCIAL_CATALOG_NOT_ACTIVE',
      message: 'El catálogo comercial todavía no está activo.',
    })
    expect(getActiveCommercialCatalog).not.toHaveBeenCalled()
  })

  it('blocks the legacy catalog projection before reading when verified authority is active v2', async () => {
    resolveActiveVersion.mockResolvedValue('ACTIVE_V2')

    const result = await handlers.get('commercial_catalog')!({})

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: false,
      code: 'COMMERCIAL_MCP_V2_NOT_ENABLED',
      message: 'El catálogo comercial del MCP todavía no está habilitado para esta versión.',
    })
    expect(getActiveCommercialCatalog).not.toHaveBeenCalled()
  })

  it('maps a known authority failure from the second catalog read to the stable disabled result', async () => {
    getActiveCommercialCatalog.mockRejectedValue(new CommercialArtifactCodecError('COMMERCIAL_CATALOG_CHECKSUM_INVALID'))

    const result = await handlers.get('commercial_catalog')!({})

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: false,
      code: 'COMMERCIAL_MCP_V2_NOT_ENABLED',
      message: 'El catálogo comercial del MCP todavía no está habilitado para esta versión.',
    })
  })

  it('rethrows an unknown infrastructure failure from the second catalog read', async () => {
    const failure = new Error('database unavailable')
    getActiveCommercialCatalog.mockRejectedValue(failure)

    await expect(handlers.get('commercial_catalog')!({})).rejects.toBe(failure)
  })

  it('previews exact campaign and renewal money in major MXN without accepting or charging', async () => {
    previewQuote.mockResolvedValue({
      quote: {
        schemaVersion: 1,
        quoteId: 'quote-1',
        lines: [
          {
            targetType: 'PRODUCT',
            targetCode: 'POS',
            priceCode: 'POS_MONTHLY',
            quantity: 1,
            adjustments: [
              { ruleCode: 'POS_FIXED_50', type: 'FIXED_PRICE', beforeMinor: 24900, afterMinor: 5000, discountMinor: 19900, cycles: 3 },
            ],
            unitAmountMinor: 24900,
            listSubtotalMinor: 24900,
            discountMinor: 19900,
            subtotalMinor: 5000,
            taxMinor: 800,
            totalMinor: 5800,
            renewalSubtotalMinor: 24900,
            renewalTaxMinor: 3984,
            renewalTotalMinor: 28884,
          },
        ],
        totals: { listSubtotalMinor: 24900, discountMinor: 19900, subtotalMinor: 5000, taxMinor: 800, totalMinor: 5800 },
        renewal: { subtotalMinor: 24900, taxMinor: 3984, totalMinor: 28884 },
      },
    })

    const result = await handlers.get('commercial_quote_preview')!({
      acquisitionToken: 'A'.repeat(43),
      lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
    })
    const data = JSON.parse(result.content[0].text)

    expect(previewQuote).toHaveBeenCalledWith(expect.objectContaining({ market: 'MX', currency: 'MXN' }))
    expect(data.quote.totals).toEqual({
      listSubtotalMxn: 249,
      discountMxn: 199,
      subtotalMxn: 50,
      taxMxn: 8,
      totalMxn: 58,
    })
    expect(data.quote.renewal.totalMxn).toBe(288.84)
    expect(JSON.stringify(data)).not.toContain('Minor')
  })
})
