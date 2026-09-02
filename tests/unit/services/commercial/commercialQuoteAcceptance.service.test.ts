import campaignFixture from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import {
  createCommercialQuoteAcceptanceService,
  isCommercialQuoteCampaignAuthorityCurrent,
} from '@/services/commercial/commercialQuoteAcceptance.service'
import { assertCommercialV2CheckoutActive } from '@/services/commercial/commercialV2CheckoutPolicy.service'
import type { CommercialCampaignSnapshotV2 } from '@/types/commercialV2'

const now = new Date('2026-08-22T15:00:00.000Z')
const quote = {
  id: 'quote-1',
  organizationId: 'org-1',
  venueId: 'venue-1',
  schemaVersion: 2,
  offerVersionId: null as string | null,
  catalogPublicationId: 'catalog-publication-1',
  campaignVersionId: 'campaign-version-1',
  expiresAt: new Date('2026-08-22T15:15:00.000Z'),
}
const input = {
  quoteId: 'quote-1',
  organizationId: 'org-1',
  venueId: 'venue-1',
  acceptedById: 'staff-1',
  idempotencyKey: 'accept-quote-1-123456',
}

function harness() {
  let existing: any = null
  const tx = {
    lockQuote: jest.fn(async () => quote),
    findAcceptanceByQuoteId: jest.fn(async () => existing),
    isQuoteAuthorityCurrent: jest.fn(async () => true),
    createAcceptance: jest.fn(async row => {
      existing = { ...row, status: 'ACCEPTED', revision: 1 }
      return existing
    }),
    writeAudit: jest.fn(async () => undefined),
  }
  const dependencies = {
    assertCheckoutAllowed: jest.fn(() => undefined),
    now: jest.fn(() => now),
    randomId: jest.fn(() => 'acceptance-1'),
    runInTransaction: jest.fn(async operation => operation(tx)),
  }
  return {
    service: createCommercialQuoteAcceptanceService(dependencies),
    dependencies,
    tx,
    setExisting: (value: any) => {
      existing = value
    },
  }
}

describe('commercial quote acceptance', () => {
  it('fails closed while checkout is OFF before input validation, clocks, repositories or audit', async () => {
    const blocked = harness()
    blocked.dependencies.assertCheckoutAllowed.mockImplementation(() => {
      assertCommercialV2CheckoutActive('OFF')
      return undefined
    })

    await expect(blocked.service.accept(input)).rejects.toMatchObject({ code: 'COMMERCIAL_V2_CHECKOUT_DISABLED' })

    expect(blocked.dependencies.assertCheckoutAllowed).toHaveBeenCalledTimes(1)
    expect(blocked.dependencies.now).not.toHaveBeenCalled()
    expect(blocked.dependencies.randomId).not.toHaveBeenCalled()
    expect(blocked.dependencies.runInTransaction).not.toHaveBeenCalled()
    expect(blocked.tx.lockQuote).not.toHaveBeenCalled()
    expect(blocked.tx.createAcceptance).not.toHaveBeenCalled()
    expect(blocked.tx.writeAudit).not.toHaveBeenCalled()
  })

  it('locks the quote, validates scope/expiry and creates one audited acceptance', async () => {
    const { service, tx } = harness()

    await expect(service.accept(input)).resolves.toMatchObject({
      id: 'acceptance-1',
      quoteId: 'quote-1',
      idempotencyKey: input.idempotencyKey,
      status: 'ACCEPTED',
    })
    expect(tx.lockQuote).toHaveBeenCalledWith('quote-1')
    expect(tx.isQuoteAuthorityCurrent).toHaveBeenCalledWith(quote, now)
    expect(tx.createAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'acceptance-1',
        acceptedAt: now,
      }),
    )
    expect(tx.writeAudit).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(tx.createAcceptance.mock.calls)).not.toMatch(/amount|price|discount/i)
  })

  it('returns the same acceptance for a replay with the same idempotency key', async () => {
    const { service, tx, setExisting } = harness()
    const accepted = { id: 'acceptance-existing', ...input, status: 'ACCEPTED', revision: 1 }
    setExisting(accepted)

    await expect(service.accept(input)).resolves.toBe(accepted)
    expect(tx.createAcceptance).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it('rejects a consumed quote replayed with a different key', async () => {
    const { service, tx, setExisting } = harness()
    setExisting({ id: 'acceptance-existing', ...input, idempotencyKey: 'another-key-123456', status: 'ACCEPTED', revision: 1 })

    await expect(service.accept(input)).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_ALREADY_ACCEPTED' })
    expect(tx.createAcceptance).not.toHaveBeenCalled()
  })

  it('fails closed for expired or cross-organization quotes', async () => {
    const expired = harness()
    expired.tx.lockQuote.mockResolvedValueOnce({ ...quote, expiresAt: now })
    await expect(expired.service.accept(input)).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_EXPIRED' })

    const crossed = harness()
    crossed.tx.lockQuote.mockResolvedValueOnce({ ...quote, organizationId: 'org-other' })
    await expect(crossed.service.accept(input)).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_SCOPE_MISMATCH' })
  })

  it('rejects a quote superseded by catalog or campaign rollback before creating acceptance', async () => {
    const { service, tx } = harness()
    tx.isQuoteAuthorityCurrent.mockResolvedValueOnce(false)

    await expect(service.accept(input)).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_SUPERSEDED' })
    expect(tx.createAcceptance).not.toHaveBeenCalled()
  })

  it.each([
    ['a direct Quote v3', { schemaVersion: 3, offerVersionId: 'offer-v3-1' }],
    ['a non-offer future schema', { schemaVersion: 4, offerVersionId: null }],
    ['an Offer-linked row disguised as schema 2', { schemaVersion: 2, offerVersionId: 'offer-v3-1' }],
  ])('rejects %s before any v2 authority, acceptance or audit work', async (_label, lineage) => {
    const unsupported = harness()
    unsupported.tx.lockQuote.mockResolvedValueOnce({ ...quote, ...lineage })

    await expect(unsupported.service.accept(input)).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_SCHEMA_UNSUPPORTED',
      statusCode: 409,
    })

    expect(unsupported.tx.findAcceptanceByQuoteId).not.toHaveBeenCalled()
    expect(unsupported.tx.isQuoteAuthorityCurrent).not.toHaveBeenCalled()
    expect(unsupported.tx.createAcceptance).not.toHaveBeenCalled()
    expect(unsupported.tx.writeAudit).not.toHaveBeenCalled()
  })

  it('rejects malformed idempotency input before opening a transaction', async () => {
    const { service, dependencies } = harness()
    await expect(service.accept({ ...input, idempotencyKey: 'short' })).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_ACCEPTANCE_INVALID',
    })
    expect(dependencies.runInTransaction).not.toHaveBeenCalled()
  })
})

describe('commercial quote campaign authority at acceptance', () => {
  const snapshot = campaignFixture as unknown as CommercialCampaignSnapshotV2
  const row = {
    id: snapshot.campaignVersionId,
    campaignCode: snapshot.campaignCode,
    sourceRevision: snapshot.version,
    schemaVersion: snapshot.schemaVersion,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CAMPAIGN_SNAPSHOT, snapshot),
    publishedAt: new Date(snapshot.publishedAt),
  }

  it('accepts an active verified Campaign v2 row inside its half-open window', () => {
    expect(isCommercialQuoteCampaignAuthorityCurrent(row, new Date('2026-08-15T12:00:00.000Z'))).toBe(true)
  })

  it.each([
    ['corrupt checksum', { checksum: '0'.repeat(64) }],
    ['mismatched row identity', { id: 'different-campaign-version' }],
    ['unsupported historical schema', { schemaVersion: 1 }],
    ['unsupported future schema', { schemaVersion: 3 }],
  ])('fails closed for %s', (_label, override) => {
    expect(isCommercialQuoteCampaignAuthorityCurrent({ ...row, ...override }, new Date('2026-08-15T12:00:00.000Z'))).toBe(false)
  })

  it.each([snapshot.startsAt, snapshot.endsAt])('uses a half-open campaign window at %s', instant => {
    const expected = instant === snapshot.startsAt
    expect(isCommercialQuoteCampaignAuthorityCurrent(row, new Date(instant))).toBe(expected)
  })

  it('rejects an inactive verified snapshot', () => {
    const inactiveSnapshot = { ...snapshot, status: 'INACTIVE' as const }
    expect(
      isCommercialQuoteCampaignAuthorityCurrent(
        {
          ...row,
          snapshot: inactiveSnapshot,
          checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CAMPAIGN_SNAPSHOT, inactiveSnapshot),
        },
        new Date('2026-08-15T12:00:00.000Z'),
      ),
    ).toBe(false)
  })
})
