import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import {
  commercialOfferPublicationService,
  createCommercialOfferPublicationService,
  type CommercialOfferPublicationDependencies,
} from '@/services/commercial/offers/commercialOfferPublication.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

const publishedAt = new Date('2026-07-31T06:00:00.000Z')
const actor = {
  staffId: 'staff-1',
  reason: 'Publicar oferta hardware piloto CDMX',
  permissions: ['commercial:publish'],
}
const draft = {
  id: 'draft-1',
  code: 'SUMMER_2026',
  name: 'Summer 2026',
  description: null,
  revision: 2,
  offerSchemaVersion: 3 as const,
  status: 'ACTIVE' as const,
  startsAt: '2026-08-01T06:00:00.000Z',
  endsAt: '2026-09-01T06:00:00.000Z',
  stackingGroups: [],
  rules: [
    {
      code: 'POS_FIXED_50',
      type: 'FIXED_PRICE' as const,
      priority: 100,
      target: { productCodes: ['POS'] as [string] },
      cycles: 3,
      amount: '50.00',
    },
  ],
  offerBenefits: [
    {
      benefitCode: 'HARDWARE_PAX_10_OFF',
      kind: 'HARDWARE_PERCENT_OFF' as const,
      priority: 50,
      hardwareCatalogKey: 'PAX_A910S',
      percentBasisPoints: 1000,
      quantityLimit: 1,
      benefitStartsAt: '2026-08-01T06:00:00.000Z',
      benefitEndsAt: '2026-09-01T06:00:00.000Z',
    },
  ],
}

const catalog = emitCommercialArtifactV2({
  kind: 'CATALOG',
  schemaVersion: 2,
  domainValue: JSON.parse(JSON.stringify(catalogFixture)) as CommercialCatalogSnapshotV2,
})

const productionCatalog = {
  id: catalog.snapshot.publicationId,
  schemaVersion: 2,
  checksum: catalog.checksum,
  snapshot: catalog.snapshot,
  publishedAt: new Date(catalog.snapshot.publishedAt),
}

function harness(overrideDraft: any = draft, production: typeof productionCatalog | null = productionCatalog) {
  let stored: any = null
  const tx = {
    lockDraft: jest.fn(async () => overrideDraft),
    getProductionCatalog: jest.fn(async () => production),
    findVersionBySourceRevision: jest.fn(async () => stored),
    createVersion: jest.fn(async input => {
      stored = {
        id: input.emitted.snapshot.campaignVersionId,
        campaignCode: input.emitted.snapshot.campaignCode,
        sourceDraftId: input.sourceDraftId,
        sourceRevision: input.sourceRevision,
        schemaVersion: 3,
        snapshot: input.emitted.snapshot,
        checksum: input.emitted.checksum,
        publishedAt: input.publishedAt,
      }
      return stored
    }),
    writeAudit: jest.fn(async () => undefined),
  }
  const dependencies: CommercialOfferPublicationDependencies = {
    now: () => publishedAt,
    randomId: () => 'commercial-offer-version-summer-2026-v3',
    runInTransaction: async operation => operation(tx as never),
  }
  return { service: createCommercialOfferPublicationService(dependencies), tx }
}

describe('Commercial Offer v3 publish-only service', () => {
  it('exposes only the production publish surface and no activation operation', () => {
    expect(commercialOfferPublicationService).toEqual(expect.objectContaining({ publish: expect.any(Function) }))
    expect(Object.keys(commercialOfferPublicationService)).toEqual(['publish'])
  })

  it('publishes an immutable SaaS + hardware snapshot without an activation surface', async () => {
    const { service, tx } = harness()
    const result = await service.publish(
      { draftId: draft.id, expectedDraftRevision: 2, reason: actor.reason, confirm: true },
      actor,
    )

    expect(result.schemaVersion).toBe(3)
    expect(result.snapshot.benefits).toEqual([
      expect.objectContaining({
        benefitCode: 'HARDWARE_PAX_10_OFF',
        kind: 'HARDWARE_PERCENT_OFF',
        skuSnapshot: expect.objectContaining({ catalogKey: 'PAX_A910S', listUnitAmountMinor: '400000' }),
      }),
      expect.objectContaining({ benefitCode: 'SAAS_PRICE', kind: 'SAAS_PRICE', rules: draft.rules }),
    ])
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(tx.createVersion).toHaveBeenCalledTimes(1)
    expect(tx.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'COMMERCIAL_OFFER_V3_PUBLISHED' }))
    expect(Object.keys(tx)).not.toEqual(expect.arrayContaining(['createActivation', 'moveActivationIfRevision']))
  })

  it('returns the same verified version for an idempotent same-revision retry', async () => {
    const { service, tx } = harness()
    const input = { draftId: draft.id, expectedDraftRevision: 2, reason: actor.reason, confirm: true as const }
    const first = await service.publish(input, actor)
    const second = await service.publish(input, actor)
    expect(second).toEqual(first)
    expect(tx.createVersion).toHaveBeenCalledTimes(1)
    expect(tx.writeAudit).toHaveBeenCalledTimes(1)
  })

  it('does not let an old idempotency result bypass a newer draft revision', async () => {
    const { service, tx } = harness()
    const input = { draftId: draft.id, expectedDraftRevision: 2, reason: actor.reason, confirm: true as const }
    await service.publish(input, actor)
    tx.lockDraft.mockResolvedValueOnce({ ...draft, revision: 3 })

    await expect(service.publish(input, actor)).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_DRAFT_CONFLICT' })
    expect(tx.createVersion).toHaveBeenCalledTimes(1)
    expect(tx.writeAudit).toHaveBeenCalledTimes(1)
  })

  it('categorically rejects rate schedules until their immutable authority exists', async () => {
    const rateDraft = {
      ...draft,
      offerBenefits: [
        {
          benefitCode: 'PAYMENTS_STARTER_RATE',
          kind: 'PAYMENTS_RATE_SCHEDULE',
          priority: 10,
          paymentsRateScheduleVersionId: 'payments-rate-schedule-version-starter-2026-v1',
        },
      ],
    }
    const { service, tx } = harness(rateDraft)
    await expect(
      service.publish({ draftId: draft.id, expectedDraftRevision: 2, reason: actor.reason, confirm: true }, actor),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_RATE_SCHEDULE_AUTHORITY_UNAVAILABLE' })
    expect(tx.createVersion).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it('fails closed before persistence when no production Catalog authority exists', async () => {
    const { service, tx } = harness(draft, null)

    await expect(
      service.publish({ draftId: draft.id, expectedDraftRevision: 2, reason: actor.reason, confirm: true }, actor),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_PRODUCTION_CATALOG_REQUIRED' })
    expect(tx.createVersion).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it('fails closed before persistence while an emergency Catalog v1 authority is active', async () => {
    const v1Production = {
      ...productionCatalog,
      schemaVersion: 1,
      snapshot: { ...productionCatalog.snapshot, schemaVersion: 1 },
    }
    const { service, tx } = harness(draft, v1Production as never)

    await expect(
      service.publish({ draftId: draft.id, expectedDraftRevision: 2, reason: actor.reason, confirm: true }, actor),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_PRODUCTION_CATALOG_REQUIRED' })
    expect(tx.createVersion).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it('fails closed before persistence when the candidate has an ambiguous subset stack for the production Catalog', async () => {
    const ambiguousDraft = JSON.parse(JSON.stringify(draft))
    ambiguousDraft.rules = [
      JSON.parse(JSON.stringify(draft.rules[0])),
      {
        ...JSON.parse(JSON.stringify(draft.rules[0])),
        code: 'POS_PERCENT_10',
        type: 'PERCENT_OFF',
        priority: 90,
        percentBasisPoints: 1000,
      },
      {
        ...JSON.parse(JSON.stringify(draft.rules[0])),
        code: 'POS_PERCENT_05',
        type: 'PERCENT_OFF',
        priority: 80,
        percentBasisPoints: 500,
      },
    ]
    delete ambiguousDraft.rules[1].amount
    delete ambiguousDraft.rules[2].amount
    ambiguousDraft.rules.sort((left: any, right: any) => (left.code < right.code ? -1 : 1))
    ambiguousDraft.stackingGroups = [
      {
        code: 'POS_STRICT_SUBSET',
        steps: [
          { position: 1, ruleCode: 'POS_FIXED_50' },
          { position: 2, ruleCode: 'POS_PERCENT_10' },
        ],
      },
    ]
    const { service, tx } = harness(ambiguousDraft)

    await expect(
      service.publish({ draftId: draft.id, expectedDraftRevision: 2, reason: actor.reason, confirm: true }, actor),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE' })
    expect(tx.createVersion).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it('rejects missing permission, stale revision, wrong schema and missing confirmation', async () => {
    const noPermission = harness()
    await expect(
      noPermission.service.publish(
        { draftId: draft.id, expectedDraftRevision: 2, reason: actor.reason, confirm: true },
        { ...actor, permissions: [] },
      ),
    ).rejects.toMatchObject({ statusCode: 403 })

    const stale = harness()
    await expect(
      stale.service.publish({ draftId: draft.id, expectedDraftRevision: 3, reason: actor.reason, confirm: true }, actor),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_DRAFT_CONFLICT' })

    const wrongSchema = harness({ ...draft, offerSchemaVersion: 2 })
    await expect(
      wrongSchema.service.publish({ draftId: draft.id, expectedDraftRevision: 2, reason: actor.reason, confirm: true }, actor),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_DRAFT_SCHEMA_UNSUPPORTED' })

    const unconfirmed = harness()
    await expect(
      unconfirmed.service.publish(
        { draftId: draft.id, expectedDraftRevision: 2, reason: actor.reason, confirm: false as true },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 422 })
  })
})
