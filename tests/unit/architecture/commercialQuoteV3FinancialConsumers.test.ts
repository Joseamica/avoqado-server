import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8')
}

function filesBelow(relativeRoot: string): string[] {
  const absoluteRoot = path.join(root, relativeRoot)
  const result: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory).sort()) {
      const absolute = path.join(directory, entry)
      if (statSync(absolute).isDirectory()) visit(absolute)
      else if (/\.[cm]?tsx?$/u.test(entry)) result.push(path.relative(root, absolute))
    }
  }
  visit(absoluteRoot)
  return result
}

function prismaModel(schema: string, model: string): string {
  const match = schema.match(new RegExp(`(?:^|\\n)model ${model} \\{([\\s\\S]*?)\\n\\}`, 'u'))
  if (!match) throw new Error(`Prisma model not found: ${model}`)
  return match[1]
}

describe('Quote v3 financial consumer inventory', () => {
  it('freezes every direct commercial acceptance, operation and lifecycle consumer in src', () => {
    const lineageToken =
      /CommercialQuoteAcceptance|commercialQuoteAcceptance|CommercialStripeOperation|commercialStripeOperation|CommercialSubscriptionEvent|commercialSubscriptionEvent/u
    const inventory = filesBelow('src')
      .filter(file => lineageToken.test(source(file)))
      .sort()

    expect(inventory).toEqual([
      'src/controllers/dashboard/commercial.dashboard.controller.ts',
      'src/services/commercial/billing/entitlementProjection.service.ts',
      'src/services/commercial/billing/subscriptionContract.service.ts',
      'src/services/commercial/billing/zeroAmountActivation.service.ts',
      'src/services/commercial/commercialQuoteAcceptance.service.ts',
      'src/services/commercial/commercialStripeCheckout.service.ts',
      'src/services/commercial/commercialStripeGateway.service.ts',
      'src/services/commercial/commercialSubscriptionLifecycle.service.ts',
      'src/services/commercial/offers/commercialOfferReleasePreflight.service.ts',
      'src/services/commercial/quotes-v3/commercialQuoteV3Acceptance.service.ts',
      'src/services/stripe-webhooks/platformWebhookClassifier.prisma.ts',
    ])
  })

  it('freezes every known direct or transaction-delegate CommercialQuote reader and writer in src', () => {
    const quotePersistenceToken =
      /commercialQuote\.(?:find|create|update|upsert|delete|count|aggregate|groupBy)|\bcommercialQuote\s*:\s*tx\.commercialQuote\b|"CommercialQuote"/u
    const inventory = filesBelow('src')
      .filter(file => quotePersistenceToken.test(source(file)))
      .sort()

    expect(inventory).toEqual([
      'src/services/commercial/billing/subscriptionContract.service.ts',
      'src/services/commercial/commercialAcquisitionContextCleanup.service.ts',
      'src/services/commercial/commercialQuoteAcceptance.service.ts',
      'src/services/commercial/commercialQuotePersistence.service.ts',
      'src/services/commercial/commercialSubscriptionLifecycle.service.ts',
      'src/services/commercial/offers/commercialOfferReleasePreflight.service.ts',
      'src/services/commercial/quotes-v3/commercialDirectQuoteV3.service.ts',
      'src/services/commercial/quotes-v3/commercialQuotePreviewBridgeV3.service.ts',
      'src/services/commercial/quotes-v3/commercialQuoteV3Acceptance.service.ts',
      'src/services/commercial/quotes-v3/commercialQuoteV3Persistence.service.ts',
    ])
  })

  it('requires fail-closed lineage checks at every v2 financial boundary', () => {
    const acceptance = source('src/services/commercial/commercialQuoteAcceptance.service.ts')
    expect(acceptance).toContain('COMMERCIAL_QUOTE_SCHEMA_UNSUPPORTED')
    expect(acceptance).toMatch(/SELECT[\s\S]*"schemaVersion"[\s\S]*"offerVersionId"[\s\S]*FROM "CommercialQuote"/u)

    const checkout = source('src/services/commercial/commercialStripeCheckout.service.ts')
    expect(checkout).toContain('COMMERCIAL_QUOTE_SCHEMA_UNSUPPORTED')
    expect(checkout).toMatch(/schemaVersion[^\n]*offerVersionId|offerVersionId[^\n]*schemaVersion/u)

    const gateway = source('src/services/commercial/commercialStripeGateway.service.ts')
    expect(gateway).toContain('quote.schemaVersion !== 1')

    const lifecycle = source('src/services/commercial/commercialSubscriptionLifecycle.service.ts')
    expect(lifecycle).toContain('quoteSchemaVersion')
    expect(lifecycle).toContain('offerVersionId')
    expect(lifecycle).toMatch(/JOIN "CommercialQuote"/u)

    const classifier = source('src/services/stripe-webhooks/platformWebhookClassifier.prisma.ts')
    expect(classifier).toMatch(/FROM "CommercialStripeOperation" operation/u)
  })

  it.each(['OrganizationEntitlement', 'TerminalOrder', 'TerminalOrderItem', 'CheckoutSession']) (
    'keeps %s structurally unrelated to Quote or acceptance lineage',
    model => {
      const block = prismaModel(source('prisma/schema.prisma'), model)
      expect(block).not.toMatch(/CommercialQuote|commercialQuote|acceptanceId|quoteId/u)
    },
  )
})
