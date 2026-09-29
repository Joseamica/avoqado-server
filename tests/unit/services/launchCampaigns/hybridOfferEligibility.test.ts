// tests/unit/services/launchCampaigns/hybridOfferEligibility.test.ts
import { audienceIncludes, hybridOfferBlocker } from '@/services/launchCampaigns/hybridOfferEligibility'

const now = new Date('2026-09-28T12:00:00Z')
const org = { id: 'org', createdAt: new Date('2026-09-01T00:00:00Z') }
const campaign = (overrides: Record<string, unknown> = {}) => ({
  status: 'ACTIVE',
  startsAt: new Date('2026-09-20T00:00:00Z'),
  endsAt: new Date('2026-10-20T00:00:00Z'),
  capacity: 10,
  reservedCount: 0,
  redeemedCount: 0,
  audience: 'ALL',
  eligibleOrganizationIds: [] as string[],
  latestPublicationId: 'pub' as string | undefined,
  ...overrides,
})
const publication = (overrides: Record<string, unknown> = {}) => ({
  id: 'pub',
  stripePriceId: 'price' as string | null,
  stripeProductId: 'prod' as string | null,
  stripeRenewalPriceId: null as string | null,
  renewalKind: 'SAME_PRICE' as 'SAME_PRICE' | 'REPRICE' | 'END',
  ...overrides,
})

describe('hybridOfferBlocker', () => {
  it('a live, priced, open offer for everyone can be bought', () => {
    expect(hybridOfferBlocker(campaign(), publication(), org, now)).toBeNull()
  })

  it.each([
    ['paused', { status: 'PAUSED' }],
    ['not started', { startsAt: new Date('2026-09-29T00:00:00Z') }],
    ['ended', { endsAt: now }],
    ['republished', { latestPublicationId: 'pub_v2' }],
  ])('UNAVAILABLE when %s', (_label, overrides) => {
    expect(hybridOfferBlocker(campaign(overrides), publication(), org, now)).toBe('UNAVAILABLE')
  })

  it('FULL when reserved plus redeemed reach the capacity', () => {
    expect(hybridOfferBlocker(campaign({ capacity: 2, reservedCount: 1, redeemedCount: 1 }), publication(), org, now)).toBe('FULL')
  })

  it('INELIGIBLE outside the audience', () => {
    expect(hybridOfferBlocker(campaign({ audience: 'ORGANIZATIONS' }), publication(), org, now)).toBe('INELIGIBLE')
    expect(hybridOfferBlocker(campaign({ audience: 'NEW_ORGANIZATIONS' }), publication(), org, now)).toBe('INELIGIBLE')
  })

  it('PREPARING while Stripe prices are not ready, including the renewal price of a reprice', () => {
    expect(hybridOfferBlocker(campaign(), publication({ stripePriceId: null }), org, now)).toBe('PREPARING')
    expect(hybridOfferBlocker(campaign(), publication({ renewalKind: 'REPRICE' }), org, now)).toBe('PREPARING')
  })
})

describe('audienceIncludes', () => {
  it('listed organizations and organizations created after the start', () => {
    expect(audienceIncludes({ audience: 'ORGANIZATIONS', eligibleOrganizationIds: ['org'], startsAt: now }, org)).toBe(true)
    expect(
      audienceIncludes({ audience: 'NEW_ORGANIZATIONS', eligibleOrganizationIds: [], startsAt: new Date('2026-08-01T00:00:00Z') }, org),
    ).toBe(true)
  })
})
