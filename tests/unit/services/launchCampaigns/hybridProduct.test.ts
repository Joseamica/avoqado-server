import type { Prisma } from '@prisma/client'
import { lockProducts, productKeyOf, promotionWindow } from '@/services/launchCampaigns/hybridProduct'
import type { HybridOfferDefinition } from '@/services/launchCampaigns/hybridOffer.schema'

const terms = {
  currency: 'MXN',
  interval: 'MONTHLY',
  price: 199,
  taxIncluded: true,
  promotionCycles: null,
  renewal: { kind: 'SAME_PRICE' },
} as const

describe('productKeyOf', () => {
  it('names the single product an offer prices, and nothing for bundles or choices', () => {
    expect(productKeyOf({ schemaVersion: 1, kind: 'PLAN', planTier: 'PREMIUM', terms })).toBe('PLAN:PREMIUM')
    expect(productKeyOf({ schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI'], terms })).toBe('FEATURE:CFDI')
    expect(productKeyOf({ schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI', 'RESERVATIONS'], terms })).toBeNull()
    const choice: HybridOfferDefinition = { schemaVersion: 1, kind: 'CHOICE_BUNDLE', eligibleFeatureCodes: ['CFDI'], choiceCount: 1, terms }
    expect(productKeyOf(choice)).toBeNull()
  })
})

describe('lockProducts', () => {
  it('takes one parameterized transaction lock per product, deduplicated and in sorted order', async () => {
    const executeRaw = jest.fn(async () => 1)
    await lockProducts({ $executeRaw: executeRaw } as unknown as Prisma.TransactionClient, [
      'PLAN:PRO',
      'FEATURE:B',
      'PLAN:PRO',
      'FEATURE:A',
    ])
    const calls = executeRaw.mock.calls as unknown as [TemplateStringsArray, string][]
    expect(calls.map(([, key]) => key)).toEqual(['precio:FEATURE:A', 'precio:FEATURE:B', 'precio:PLAN:PRO'])
    // The key is a bound value, never text spliced into the SQL.
    expect(calls[0][0].join('$1')).toBe('SELECT pg_advisory_xact_lock(hashtext($1))')
  })
})

describe('promotionWindow', () => {
  it('a PROMOTION has its window and capacity; a LIST has neither', () => {
    const endsAt = new Date('2026-10-31T00:00:00Z')
    expect(promotionWindow({ purpose: 'PROMOTION', endsAt, capacity: 5 })).toEqual({ endsAt, capacity: 5 })
    expect(promotionWindow({ purpose: 'LIST', endsAt: null, capacity: null })).toBeNull()
  })
})
