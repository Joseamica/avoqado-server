import type { Prisma } from '@prisma/client'
import { BASIC_PLAN_KEY, lockProducts, productKeyOf, productKeySql, promotionWindow } from '@/services/launchCampaigns/hybridProduct'
import { hybridOfferDefinition, type HybridOfferDefinition } from '@/services/launchCampaigns/hybridOffer.schema'
import { hybridHash } from '@/services/launchCampaigns/hybridProvider'

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

describe('Plan Básico marker', () => {
  it('names PLAN:BASICO for a FEATURES offer with basicPlan, however many functions it has', () => {
    expect(BASIC_PLAN_KEY).toBe('PLAN:BASICO')
    expect(productKeyOf({ schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI', 'RESERVATIONS'], basicPlan: true, terms })).toBe(
      'PLAN:BASICO',
    )
    expect(productKeyOf({ schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI'], basicPlan: true, terms })).toBe('PLAN:BASICO')
  })

  it('its SQL twin knows the marker too', () => {
    const text = productKeySql('p').sql
    expect(text).toContain("'basicPlan'")
    expect(text).toContain('PLAN:BASICO')
  })

  it('accepts seatCap 1-500 or null only with basicPlan', () => {
    const base = { schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI'], terms }
    expect(hybridOfferDefinition.safeParse({ ...base, basicPlan: true, seatCap: 3 }).success).toBe(true)
    expect(hybridOfferDefinition.safeParse({ ...base, basicPlan: true, seatCap: null }).success).toBe(true)
    expect(hybridOfferDefinition.safeParse({ ...base, basicPlan: true, seatCap: 0 }).success).toBe(false)
    expect(hybridOfferDefinition.safeParse({ ...base, basicPlan: true, seatCap: 501 }).success).toBe(false)
    expect(hybridOfferDefinition.safeParse({ ...base, basicPlan: true, seatCap: 1.5 }).success).toBe(false)
    const orphan = hybridOfferDefinition.safeParse({ ...base, seatCap: 3 })
    expect(orphan.success).toBe(false)
    expect(JSON.stringify((orphan as { error: unknown }).error)).toContain('El tope de usuarios sólo aplica al Plan Básico')
  })

  it('a definition without the new fields keeps its hash', () => {
    const today = { schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI', 'RESERVATIONS'], terms }
    const parsed = hybridOfferDefinition.parse({ ...today, terms: { ...terms, price: 199 } })
    expect(hybridHash(parsed)).toBe('de8b32928f546743138ed9fc7f17d1c84e8c7a9d8befd83a8112e2bd20cb3a88')
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
