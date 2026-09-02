import directFixture from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-direct.json'
import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { decodeAndVerifyStoredCommercialOfferV3, emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  createCommercialStoredQuoteV3Service,
  type CommercialStoredQuoteV3Dependencies,
  type LoadStoredCommercialQuoteV3Input,
} from '@/services/commercial/quotes-v3/commercialStoredQuoteV3.service'
import { emitCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Contract.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'
import type {
  CommercialQuoteSnapshotV3,
  CommercialQuoteV3Authorities,
  CommercialQuoteV3DecodeInput,
} from '@/types/commercialQuoteV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stackedOfferSource(): CommercialOfferSnapshotV3 {
  const source = clone(offerFixture) as CommercialOfferSnapshotV3
  const saas = source.benefits.find(benefit => benefit.kind === 'SAAS_PRICE')
  if (saas?.kind !== 'SAAS_PRICE') throw new Error('Expected SaaS benefit')
  saas.rules = [
    {
      code: 'A_TEN_PERCENT',
      type: 'PERCENT_OFF',
      priority: 90,
      target: { productCodes: ['POS'] },
      cycles: 3,
      percentBasisPoints: 1000,
    },
    {
      code: 'Z_FIXED_200',
      type: 'FIXED_PRICE',
      priority: 100,
      target: { productCodes: ['POS'] },
      cycles: 3,
      amount: '200.00',
    },
  ]
  saas.stackingGroups = [
    {
      code: 'POS_STACK',
      steps: [
        { position: 1, ruleCode: 'Z_FIXED_200' },
        { position: 2, ruleCode: 'A_TEN_PERCENT' },
      ],
    },
  ]
  return source
}

function verifiedOffer(source: CommercialOfferSnapshotV3): CommercialQuoteV3Authorities['offer'] {
  const emitted = emitCommercialOfferV3(source)
  const authority: CommercialQuoteV3Authorities['offer'] = {
    rowSchemaVersion: 3,
    snapshot: emitted.snapshot,
    checksum: emitted.checksum,
    rowContext: {
      id: emitted.snapshot.campaignVersionId,
      campaignCode: emitted.snapshot.campaignCode,
      sourceRevision: emitted.snapshot.version,
      schemaVersion: 3,
      publishedAt: new Date(emitted.snapshot.publishedAt),
    },
  }
  decodeAndVerifyStoredCommercialOfferV3(authority)
  return authority
}

const catalog = emitCommercialArtifactV2({
  kind: 'CATALOG',
  schemaVersion: 2,
  domainValue: clone(catalogFixture) as CommercialCatalogSnapshotV2,
})
const offer = verifiedOffer(stackedOfferSource())

function rowContext(snapshot: CommercialQuoteSnapshotV3): CommercialQuoteV3DecodeInput['rowContext'] {
  if (snapshot.subject.kind !== 'VENUE') throw new Error('Expected venue fixture')
  return {
    id: snapshot.quoteId,
    schemaVersion: 3,
    catalogPublicationId: snapshot.catalogPublicationId,
    offerVersionId: snapshot.offerVersionId,
    acquisitionContextId: snapshot.acquisitionContextId,
    organizationId: snapshot.subject.organizationId,
    venueId: snapshot.subject.venueId,
    createdById: snapshot.subject.actorId,
    venueOrganizationId: snapshot.subject.organizationId,
    market: snapshot.market,
    currency: snapshot.currency,
    quotedAt: new Date(snapshot.quotedAt),
    expiresAt: new Date(snapshot.expiresAt),
    listSubtotalMinor: BigInt(snapshot.totals.dueNow.listSubtotalMinor),
    discountMinor: BigInt(snapshot.totals.dueNow.discountMinor),
    subtotalMinor: BigInt(snapshot.totals.dueNow.subtotalMinor),
    taxMinor: BigInt(snapshot.totals.dueNow.taxMinor),
    totalMinor: BigInt(snapshot.totals.dueNow.totalMinor),
    renewalSubtotalMinor: BigInt(snapshot.renewal.subtotalMinor),
    renewalTaxMinor: BigInt(snapshot.renewal.taxMinor),
    renewalTotalMinor: BigInt(snapshot.renewal.totalMinor),
  }
}

function validDecodeInput(): CommercialQuoteV3DecodeInput {
  const snapshot = clone(directFixture) as CommercialQuoteSnapshotV3
  const authorities: CommercialQuoteV3Authorities = {
    catalog,
    offer,
    acquisitionContext: null,
  }
  const emitted = emitCommercialQuoteV3(snapshot, authorities)
  return {
    rowSchemaVersion: 3,
    snapshot: emitted.snapshot,
    checksum: emitted.checksum,
    rowContext: rowContext(snapshot),
    authorities,
  }
}

function loadInput(): LoadStoredCommercialQuoteV3Input {
  const snapshot = directFixture as CommercialQuoteSnapshotV3
  if (snapshot.subject.kind !== 'VENUE') throw new Error('Expected venue fixture')
  return {
    quoteId: snapshot.quoteId,
    organizationId: snapshot.subject.organizationId,
    venueId: snapshot.subject.venueId,
    correlationId: 'correlation-quote-v3-safe-replay',
  }
}

function dependencies(
  value: CommercialQuoteV3DecodeInput | null = validDecodeInput(),
): CommercialStoredQuoteV3Dependencies & {
  loadRowAndAuthorities: jest.Mock
  recordPoisonedResolution: jest.Mock
} {
  return {
    loadRowAndAuthorities: jest.fn().mockResolvedValue(value),
    recordPoisonedResolution: jest.fn(),
  }
}

async function expectPoisoned(
  rawValue: CommercialQuoteV3DecodeInput,
  expectedAlertCount = 1,
): Promise<jest.Mock> {
  const deps = dependencies(rawValue)
  const service = createCommercialStoredQuoteV3Service(deps)
  await expect(service.loadVerified(loadInput())).rejects.toMatchObject({
    statusCode: 409,
    code: 'COMMERCIAL_OFFER_RESOLUTION_VERSION_UNSUPPORTED',
  })
  expect(deps.recordPoisonedResolution).toHaveBeenCalledTimes(expectedAlertCount)
  expect(deps.recordPoisonedResolution).toHaveBeenCalledWith({
    quoteId: loadInput().quoteId,
    correlationId: loadInput().correlationId,
    code: 'COMMERCIAL_OFFER_RESOLUTION_VERSION_POISONED_ROW',
  })
  return deps.recordPoisonedResolution
}

describe('Commercial stored Quote v3 replay', () => {
  it('returns only a verified, tenant-bound stored Quote v3', async () => {
    const deps = dependencies()
    const result = await createCommercialStoredQuoteV3Service(deps).loadVerified(loadInput())

    expect(result).toMatchObject({
      kind: 'COMMERCIAL_QUOTE',
      schemaVersion: 3,
      mode: 'READ_WRITE',
      verified: true,
    })
    expect(deps.loadRowAndAuthorities).toHaveBeenCalledWith(loadInput())
    expect(deps.recordPoisonedResolution).not.toHaveBeenCalled()
  })

  it('fails closed for a missing row without disclosing tenant existence', async () => {
    const deps = dependencies(null)
    await expect(createCommercialStoredQuoteV3Service(deps).loadVerified(loadInput())).rejects.toMatchObject({
      statusCode: 404,
      message: 'COMMERCIAL_QUOTE_V3_NOT_FOUND',
      code: 'COMMERCIAL_QUOTE_V3_NOT_FOUND',
    })
    expect(deps.recordPoisonedResolution).not.toHaveBeenCalled()
  })

  it.each([1, 2])('rejects a stored schema %s row before Quote v3 decoding', async schemaVersion => {
    const value = validDecodeInput()
    value.rowSchemaVersion = schemaVersion
    value.rowContext.schemaVersion = schemaVersion
    const deps = dependencies(value)

    await expect(createCommercialStoredQuoteV3Service(deps).loadVerified(loadInput())).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_QUOTE_V3_SCHEMA_UNSUPPORTED',
    })
    expect(deps.recordPoisonedResolution).not.toHaveBeenCalled()
  })

  it.each([
    ['organization', 'organizationId', 'organization-other'],
    ['venue', 'venueId', 'venue-other'],
    ['venue ownership', 'venueOrganizationId', 'organization-other'],
  ] as const)('hides a row with the wrong %s binding', async (_label, field, value) => {
    const stored = validDecodeInput()
    stored.rowContext[field] = value
    const deps = dependencies(stored)

    await expect(createCommercialStoredQuoteV3Service(deps).loadVerified(loadInput())).rejects.toMatchObject({
      statusCode: 404,
      message: 'COMMERCIAL_QUOTE_V3_NOT_FOUND',
      code: 'COMMERCIAL_QUOTE_V3_NOT_FOUND',
    })
    expect(deps.recordPoisonedResolution).not.toHaveBeenCalled()
  })

  it.each([
    ['checksum', (value: CommercialQuoteV3DecodeInput) => { value.checksum = '0'.repeat(64) }, 'COMMERCIAL_QUOTE_V3_CHECKSUM_MISMATCH'],
    ['row identity', (value: CommercialQuoteV3DecodeInput) => { value.rowContext.id = 'quote-other' }, 'COMMERCIAL_QUOTE_V3_IDENTITY_MISMATCH'],
  ] as const)('translates a known %s domain failure into a stable conflict', async (_label, mutate, code) => {
    const value = validDecodeInput()
    mutate(value)
    const deps = dependencies(value)

    await expect(createCommercialStoredQuoteV3Service(deps).loadVerified(loadInput())).rejects.toMatchObject({
      statusCode: 409,
      code,
    })
    expect(deps.recordPoisonedResolution).not.toHaveBeenCalled()
  })

  it.each([
    ['missing snapshot', (value: any) => { delete value.snapshot }],
    ['null snapshot', (value: any) => { value.snapshot = null }],
    ['array snapshot', (value: any) => { value.snapshot = [] }],
    ['missing resolution', (value: any) => { value.snapshot = clone(value.snapshot); delete value.snapshot.resolution }],
    ['null resolution', (value: any) => { value.snapshot = clone(value.snapshot); value.snapshot.resolution = null }],
    ['array resolution', (value: any) => { value.snapshot = clone(value.snapshot); value.snapshot.resolution = [] }],
  ])('classifies a %s container as one poisoned row', async (_label, mutate) => {
    const value = validDecodeInput() as any
    mutate(value)
    await expectPoisoned(value)
  })

  it.each([
    ['missing', (resolution: any) => { delete resolution.resolutionVersion }],
    ['string', (resolution: any) => { resolution.resolutionVersion = '2' }],
    ['unknown', (resolution: any) => { resolution.resolutionVersion = 3 }],
    ['fractional', (resolution: any) => { resolution.resolutionVersion = 2.5 }],
    ['accessor', (resolution: any) => {
      Object.defineProperty(resolution, 'resolutionVersion', { enumerable: true, get: () => 2 })
    }],
    ['non-enumerable', (resolution: any) => {
      Object.defineProperty(resolution, 'resolutionVersion', { enumerable: false, value: 2 })
    }],
    ['inherited', (resolution: any) => {
      delete resolution.resolutionVersion
      Object.setPrototypeOf(resolution, { resolutionVersion: 2 })
    }],
  ])('classifies a %s resolution version as one poisoned row', async (_label, mutate) => {
    const value = validDecodeInput()
    const snapshot = clone(value.snapshot) as CommercialQuoteSnapshotV3
    mutate(snapshot.resolution)
    value.snapshot = snapshot
    await expectPoisoned(value)
  })

  it('catches reflection failures and never evaluates the decoder for an unknown revision', async () => {
    const value = validDecodeInput()
    const snapshot = clone(value.snapshot) as CommercialQuoteSnapshotV3
    let decoderReached = false
    Object.defineProperty(snapshot, 'schemaVersion', {
      enumerable: true,
      get: () => {
        decoderReached = true
        throw new Error('DECODER_MUST_NOT_RUN')
      },
    })
    snapshot.resolution.resolutionVersion = 3 as 2
    value.snapshot = snapshot
    await expectPoisoned(value)
    expect(decoderReached).toBe(false)

    const proxyValue = validDecodeInput()
    proxyValue.snapshot = new Proxy(clone(proxyValue.snapshot) as object, {
      getOwnPropertyDescriptor() {
        throw new Error('REFLECTION_FAILURE')
      },
    })
    await expectPoisoned(proxyValue)
  })

  it('emits a minimal alert with no acquisition, authentication or PII data', async () => {
    const value = validDecodeInput() as any
    value.utm = 'secret-utm'
    value.gclid = 'secret-gclid'
    value.fbclid = 'secret-fbclid'
    value.ip = '203.0.113.10'
    value.userAgent = 'secret-agent'
    value.bearerToken = 'secret-token'
    value.snapshot = clone(value.snapshot)
    value.snapshot.customerEmail = 'customer@example.com'
    value.snapshot.resolution.resolutionVersion = 999

    const alert = await expectPoisoned(value)
    const serialized = JSON.stringify(alert.mock.calls)
    for (const forbidden of [
      'snapshot',
      'utm',
      'gclid',
      'fbclid',
      '203.0.113.10',
      'secret-agent',
      'secret-token',
      'customer@example.com',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('rethrows unexpected dependency failures unchanged', async () => {
    const failure = new Error('DATABASE_CONNECTION_DROPPED')
    const deps = dependencies()
    deps.loadRowAndAuthorities.mockRejectedValue(failure)

    await expect(createCommercialStoredQuoteV3Service(deps).loadVerified(loadInput())).rejects.toBe(failure)
    expect(deps.recordPoisonedResolution).not.toHaveBeenCalled()
  })
})
