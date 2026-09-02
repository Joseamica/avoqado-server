import { ConflictError } from '@/errors/AppError'
import { createCommercialPublicationService } from '@/services/commercial/commercialPublication.service'
import { buildValidCommercialDraft } from '../../../__helpers__/commercialDraft'
import { buildCommercialSnapshot } from '@/services/commercial/commercialSnapshot.service'
import { buildCommercialCatalogV2 } from '@/services/commercial/commercialCatalogV2Builder.service'
import { assertEmittedCommercialCatalogV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import type { CommercialOfferSnapshotV3, VerifiedStoredCommercialOfferV3 } from '@/types/commercialOfferV3'

const actor = {
  staffId: 'staff_1',
  reason: 'Publicar catálogo aprobado',
  permissions: ['commercial:publish'],
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function harness(eligibleOffers: readonly VerifiedStoredCommercialOfferV3[] = []) {
  const draft = buildValidCommercialDraft()
  const publications = new Map<string, { id: string; schemaVersion: number; checksum: string; snapshot: unknown; publishedAt: Date }>()
  const audit: unknown[] = []
  const outbox: unknown[] = []
  let now = new Date('2026-08-21T12:00:00.000Z')
  const tx = {
    getDraftForPublication: jest.fn(async () => draft),
    getEligibleOffers: jest.fn(async () => eligibleOffers),
    createPublicationIfAbsent: jest.fn(
      async (input: { id: string; artifact: ReturnType<typeof buildCommercialCatalogV2>; publishedAt: Date }) => {
        const existing = [...publications.values()].find(publication => publication.checksum === input.artifact.checksum)
        if (existing) return { publication: existing, created: false }
        const publication = {
          id: input.id,
          schemaVersion: input.artifact.schemaVersion,
          checksum: input.artifact.checksum,
          snapshot: input.artifact.snapshot,
          publishedAt: input.publishedAt,
        }
        publications.set(publication.id, publication)
        return { publication, created: true }
      },
    ),
    writeAudit: jest.fn(async value => {
      audit.push(value)
    }),
    enqueue: jest.fn(async value => {
      outbox.push(value)
    }),
  }
  const getDraft = jest.fn(async () => draft)
  const runWithEligibleOffers = jest.fn(async (_now, operation) => operation(tx, eligibleOffers))
  const service = createCommercialPublicationService({
    getDraft,
    getActivePublication: jest.fn(async () => null),
    now: () => now,
    randomId: () => 'pub_1',
    signingSecret: 'test-secret-that-is-at-least-32-bytes-long',
    runInTransaction: operation => operation(tx),
    runWithEligibleOffers,
  })
  return { service, draft, getDraft, tx, audit, outbox, runWithEligibleOffers, setNow: (value: Date) => (now = value) }
}

describe('commercial publication preview and confirmation', () => {
  it('previews without mutation, then publishes audit and outbox atomically after confirmation', async () => {
    const { service, tx, audit, outbox } = harness()

    const preview = await service.previewCommercialPublication('draft_1', 3, actor)
    expect(tx.createPublicationIfAbsent).not.toHaveBeenCalled()
    expect(preview.expiresAt).toBe('2026-08-21T12:15:00.000Z')
    expect(preview.snapshot).toMatchObject({ schemaVersion: 2, contractVersion: '2.0.0' })
    expect(preview.snapshot.products.find(product => product.code === 'POS')?.prices[0]).toMatchObject({ amount: '249.00' })

    const published = await service.publishCommercialDraft(
      {
        draftId: 'draft_1',
        expectedRevision: 3,
        previewToken: preview.previewToken,
        checksum: preview.checksum,
        reason: actor.reason,
        confirm: true,
      },
      actor,
    )

    expect(published.id).toBe('pub_1')
    expect(published.schemaVersion).toBe(2)
    expect(audit).toHaveLength(1)
    expect(outbox).toHaveLength(1)
    const persistedInput = tx.createPublicationIfAbsent.mock.calls[0][0]
    expect(() => assertEmittedCommercialCatalogV2(persistedInput.artifact)).not.toThrow()
    expect(persistedInput.artifact.snapshot).toEqual(preview.snapshot)
    expect(persistedInput.artifact.checksum).toBe(preview.checksum)
    expect(audit[0]).toMatchObject({ after: { schemaVersion: 2, checksum: preview.checksum } })
    expect(outbox[0]).toMatchObject({ schemaVersion: 2, checksum: preview.checksum })
  })

  it('uses the preverified eligible-offer snapshot path instead of decoding offers under the writer lock', async () => {
    const preparedOffer = { ...emitCommercialOfferV3(clone(offerFixture)), verified: true } as VerifiedStoredCommercialOfferV3
    const { service, tx, runWithEligibleOffers } = harness([preparedOffer])
    const preview = await service.previewCommercialPublication('draft_1', 3, actor)

    await service.publishCommercialDraft(
      {
        draftId: 'draft_1',
        expectedRevision: 3,
        previewToken: preview.previewToken,
        checksum: preview.checksum,
        reason: actor.reason,
        confirm: true,
      },
      actor,
    )

    expect(runWithEligibleOffers).toHaveBeenCalledTimes(1)
    expect(tx.getEligibleOffers).not.toHaveBeenCalled()
  })

  it('rejects expired, forged and stale previews', async () => {
    const expired = harness()
    const preview = await expired.service.previewCommercialPublication('draft_1', 3, actor)
    expired.setNow(new Date('2026-08-21T12:16:00.000Z'))
    await expect(
      expired.service.publishCommercialDraft(
        {
          draftId: 'draft_1',
          expectedRevision: 3,
          previewToken: preview.previewToken,
          checksum: preview.checksum,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_PREVIEW_EXPIRED' })

    const forged = harness()
    const forgedPreview = await forged.service.previewCommercialPublication('draft_1', 3, actor)
    await expect(
      forged.service.publishCommercialDraft(
        {
          draftId: 'draft_1',
          expectedRevision: 3,
          previewToken: `${forgedPreview.previewToken}x`,
          checksum: forgedPreview.checksum,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_PREVIEW_INVALID' })

    const stale = harness()
    const stalePreview = await stale.service.previewCommercialPublication('draft_1', 3, actor)
    stale.draft.revision = 4
    await expect(
      stale.service.publishCommercialDraft(
        {
          draftId: 'draft_1',
          expectedRevision: 3,
          previewToken: stalePreview.previewToken,
          checksum: stalePreview.checksum,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('makes repeated confirmation idempotent without duplicate audit or outbox events', async () => {
    const { service, audit, outbox } = harness()
    const preview = await service.previewCommercialPublication('draft_1', 3, actor)
    const command = {
      draftId: 'draft_1',
      expectedRevision: 3,
      previewToken: preview.previewToken,
      checksum: preview.checksum,
      reason: actor.reason,
      confirm: true as const,
    }

    const first = await service.publishCommercialDraft(command, actor)
    const second = await service.publishCommercialDraft(command, actor)

    expect(second).toEqual(first)
    expect(audit).toHaveLength(1)
    expect(outbox).toHaveLength(1)
  })

  it('rejects a Catalog candidate incompatible with an eligible Offer before persistence', async () => {
    const source = clone(offerFixture) as CommercialOfferSnapshotV3
    const benefit = source.benefits.find(candidate => candidate.kind === 'SAAS_PRICE')!
    if (benefit.kind !== 'SAAS_PRICE') throw new Error('Expected SAAS_PRICE benefit')
    const original = benefit.rules[0]
    benefit.rules = [
      clone(original),
      { ...clone(original), code: 'POS_PERCENT_05', type: 'PERCENT_OFF', priority: 80, percentBasisPoints: 500 },
      { ...clone(original), code: 'POS_PERCENT_10', type: 'PERCENT_OFF', priority: 90, percentBasisPoints: 1000 },
    ]
    delete (benefit.rules[1] as { amount?: string }).amount
    delete (benefit.rules[2] as { amount?: string }).amount
    benefit.rules.sort((left, right) => (left.code < right.code ? -1 : 1))
    benefit.stackingGroups = [
      {
        code: 'POS_STRICT_SUBSET',
        steps: [
          { position: 1, ruleCode: 'POS_FIXED_50' },
          { position: 2, ruleCode: 'POS_PERCENT_10' },
        ],
      },
    ]
    const emitted = emitCommercialOfferV3(source)
    const { service, tx, audit, outbox } = harness([{ ...emitted, verified: true }] as VerifiedStoredCommercialOfferV3[])
    const preview = await service.previewCommercialPublication('draft_1', 3, actor)

    await expect(
      service.publishCommercialDraft(
        {
          draftId: 'draft_1',
          expectedRevision: 3,
          previewToken: preview.previewToken,
          checksum: preview.checksum,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE' })
    expect(tx.createPublicationIfAbsent).not.toHaveBeenCalled()
    expect(audit).toHaveLength(0)
    expect(outbox).toHaveLength(0)
  })

  it.each(['v1', 'v2'] as const)(
    'projects a verified active %s catalog and an equivalent v2 candidate to the same cross-version diff view',
    async activeVersion => {
      const draft = buildValidCommercialDraft()
      const currentPublishedAt = new Date('2026-08-20T12:00:00.000Z')
      const current =
        activeVersion === 'v1'
          ? buildCommercialSnapshot(draft, { publicationId: 'pub_current', publishedAt: currentPublishedAt })
          : buildCommercialCatalogV2({ draft, publicationId: 'pub_current', publishedAt: currentPublishedAt })
      const base = harness()
      const service = createCommercialPublicationService({
        getDraft: jest.fn(async () => draft),
        getActivePublication: jest.fn(async () => ({
          id: 'pub_current',
          schemaVersion: activeVersion === 'v1' ? 1 : 2,
          checksum: current.checksum,
          snapshot: current.snapshot,
          publishedAt: currentPublishedAt,
        })),
        now: () => new Date('2026-08-21T12:00:00.000Z'),
        randomId: () => 'pub_next',
        signingSecret: 'test-secret-that-is-at-least-32-bytes-long',
        runInTransaction: operation => operation(base.tx),
        runWithEligibleOffers: base.runWithEligibleOffers,
      })

      const preview = await service.previewCommercialPublication('draft_1', 3, actor)

      expect(preview.diff).toEqual({
        fromPublicationId: 'pub_current',
        addedProductCodes: [],
        removedProductCodes: [],
        changedProductCodes: [],
        addedBundleCodes: [],
        removedBundleCodes: [],
        changedBundleCodes: [],
        productOrderChanged: false,
        bundleOrderChanged: false,
      })
    },
  )

  it('includes bundle composition and bundle-price changes in the safe preview diff', async () => {
    const currentDraft = buildValidCommercialDraft({
      bundles: [
        { code: 'PRO_PACK', slug: 'paquete-pro', name: 'Paquete Pro', description: 'Paquete anterior.', active: true, sortOrder: 1 },
      ],
      bundleItems: [{ bundleCode: 'PRO_PACK', productCode: 'PRO', quantity: 1, sortOrder: 1 }],
      prices: [
        ...buildValidCommercialDraft().prices,
        {
          code: 'PRO_PACK_MONTHLY',
          pricebookCode: 'MX_STANDARD',
          bundleCode: 'PRO_PACK',
          billingUnit: 'VENUE_MONTH',
          amount: '1199.00',
          taxBehavior: 'EXCLUSIVE',
          active: true,
        },
      ],
    })
    const current = buildCommercialSnapshot(currentDraft, {
      publicationId: 'pub_current',
      publishedAt: new Date('2026-08-20T12:00:00.000Z'),
    })
    const nextDraft = clone(currentDraft)
    nextDraft.bundleItems[0].productCode = 'POS'
    nextDraft.prices.find(price => price.code === 'PRO_PACK_MONTHLY')!.amount = '1299.00'
    const base = harness()
    const service = createCommercialPublicationService({
      getDraft: jest.fn(async () => nextDraft),
      getActivePublication: jest.fn(async () => ({
        id: 'pub_current',
        schemaVersion: 1,
        checksum: current.checksum,
        snapshot: current.snapshot,
        publishedAt: new Date(current.snapshot.publishedAt),
      })),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
      randomId: () => 'pub_next',
      signingSecret: 'test-secret-that-is-at-least-32-bytes-long',
      runInTransaction: operation => operation(base.tx),
      runWithEligibleOffers: base.runWithEligibleOffers,
    })

    const preview = await service.previewCommercialPublication('draft_1', 3, actor)

    expect(preview.diff).toMatchObject({
      addedBundleCodes: [],
      removedBundleCodes: [],
      changedBundleCodes: ['PRO_PACK'],
    })
  })

  it('reports public product ordering changes even when product content is unchanged', async () => {
    const currentDraft = buildValidCommercialDraft()
    const current = buildCommercialSnapshot(currentDraft, {
      publicationId: 'pub_current',
      publishedAt: new Date('2026-08-20T12:00:00.000Z'),
    })
    const nextDraft = clone(currentDraft)
    nextDraft.products.find(product => product.code === 'PRO')!.sortOrder = 30
    nextDraft.products.find(product => product.code === 'POS')!.sortOrder = 10
    const base = harness()
    const service = createCommercialPublicationService({
      getDraft: jest.fn(async () => nextDraft),
      getActivePublication: jest.fn(async () => ({
        id: 'pub_current',
        schemaVersion: 1,
        checksum: current.checksum,
        snapshot: current.snapshot,
        publishedAt: new Date(current.snapshot.publishedAt),
      })),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
      randomId: () => 'pub_next',
      signingSecret: 'test-secret-that-is-at-least-32-bytes-long',
      runInTransaction: operation => operation(base.tx),
      runWithEligibleOffers: base.runWithEligibleOffers,
    })

    const preview = await service.previewCommercialPublication('draft_1', 3, actor)

    expect(preview.diff).toMatchObject({
      changedProductCodes: [],
      productOrderChanged: true,
      bundleOrderChanged: false,
    })
  })

  it('treats bundle item ordering as public bundle content', async () => {
    const currentDraft = buildValidCommercialDraft({
      bundles: [{ code: 'PRO_PACK', slug: 'paquete-pro', name: 'Paquete Pro', description: 'Paquete.', active: true, sortOrder: 1 }],
      bundleItems: [
        { bundleCode: 'PRO_PACK', productCode: 'PRO', quantity: 1, sortOrder: 1 },
        { bundleCode: 'PRO_PACK', productCode: 'POS', quantity: 1, sortOrder: 2 },
      ],
      prices: [
        ...buildValidCommercialDraft().prices,
        {
          code: 'PRO_PACK_MONTHLY',
          pricebookCode: 'MX_STANDARD',
          bundleCode: 'PRO_PACK',
          billingUnit: 'VENUE_MONTH',
          amount: '1199.00',
          taxBehavior: 'EXCLUSIVE',
          active: true,
        },
      ],
    })
    const current = buildCommercialSnapshot(currentDraft, {
      publicationId: 'pub_current',
      publishedAt: new Date('2026-08-20T12:00:00.000Z'),
    })
    const nextDraft = clone(currentDraft)
    nextDraft.bundleItems[0].sortOrder = 2
    nextDraft.bundleItems[1].sortOrder = 1
    const base = harness()
    const service = createCommercialPublicationService({
      getDraft: jest.fn(async () => nextDraft),
      getActivePublication: jest.fn(async () => ({
        id: 'pub_current',
        schemaVersion: 1,
        checksum: current.checksum,
        snapshot: current.snapshot,
        publishedAt: new Date(current.snapshot.publishedAt),
      })),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
      randomId: () => 'pub_next',
      signingSecret: 'test-secret-that-is-at-least-32-bytes-long',
      runInTransaction: operation => operation(base.tx),
      runWithEligibleOffers: base.runWithEligibleOffers,
    })

    const preview = await service.previewCommercialPublication('draft_1', 3, actor)

    expect(preview.diff.changedBundleCodes).toEqual(['PRO_PACK'])
  })

  it('rejects publication when an active bundle contains an inactive product', async () => {
    const { service, draft } = harness()
    draft.products.find(product => product.code === 'PRO')!.active = false
    draft.bundles = [{ code: 'PRO_PACK', slug: 'paquete-pro', name: 'Paquete Pro', description: 'Paquete.', active: true, sortOrder: 1 }]
    draft.bundleItems = [{ bundleCode: 'PRO_PACK', productCode: 'PRO', quantity: 1, sortOrder: 1 }]

    await expect(service.previewCommercialPublication('draft_1', 3, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_DRAFT_INVALID',
      details: {
        errors: expect.arrayContaining([expect.objectContaining({ code: 'INACTIVE_BUNDLE_PRODUCT' })]),
      },
    })
  })

  it('fails closed before the writer when an injected builder returns an unbranded artifact', async () => {
    const base = harness()
    let buildCatalog = buildCommercialCatalogV2
    const service = createCommercialPublicationService({
      getDraft: jest.fn(async () => base.draft),
      getActivePublication: jest.fn(async () => null),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
      randomId: () => 'pub_1',
      signingSecret: 'test-secret-that-is-at-least-32-bytes-long',
      runInTransaction: operation => operation(base.tx),
      runWithEligibleOffers: base.runWithEligibleOffers,
      buildCatalog: input => buildCatalog(input),
    })
    const preview = await service.previewCommercialPublication('draft_1', 3, actor)
    buildCatalog = input => {
      const emitted = buildCommercialCatalogV2(input)
      return { ...emitted, snapshot: { ...emitted.snapshot, schemaVersion: 1 } } as never
    }

    await expect(
      service.publishCommercialDraft(
        {
          draftId: 'draft_1',
          expectedRevision: 3,
          previewToken: preview.previewToken,
          checksum: preview.checksum,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED' })
    expect(base.tx.createPublicationIfAbsent).not.toHaveBeenCalled()
    expect(base.audit).toHaveLength(0)
    expect(base.outbox).toHaveLength(0)
  })

  it('rejects a writer row/snapshot schema mismatch before audit or outbox', async () => {
    const base = harness()
    const preview = await base.service.previewCommercialPublication('draft_1', 3, actor)
    base.tx.createPublicationIfAbsent.mockImplementation(async input => ({
      publication: {
        id: input.id,
        schemaVersion: 1,
        checksum: input.artifact.checksum,
        snapshot: input.artifact.snapshot,
        publishedAt: input.publishedAt,
      },
      created: true,
    }))

    await expect(
      base.service.publishCommercialDraft(
        {
          draftId: 'draft_1',
          expectedRevision: 3,
          previewToken: preview.previewToken,
          checksum: preview.checksum,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_IDENTITY_MISMATCH' })
    expect(base.audit).toHaveLength(0)
    expect(base.outbox).toHaveLength(0)
  })

  it('fails closed on malformed or unsupported active publications instead of treating them as an empty diff', async () => {
    const base = harness()
    const service = createCommercialPublicationService({
      getDraft: jest.fn(async () => base.draft),
      getActivePublication: jest.fn(async () => ({
        id: 'pub_unknown',
        schemaVersion: 3,
        checksum: 'a'.repeat(64),
        snapshot: { schemaVersion: 3 },
        publishedAt: new Date('2026-08-20T12:00:00.000Z'),
      })),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
      randomId: () => 'pub_next',
      signingSecret: 'test-secret-that-is-at-least-32-bytes-long',
      runInTransaction: operation => operation(base.tx),
      runWithEligibleOffers: base.runWithEligibleOffers,
    })

    await expect(service.previewCommercialPublication('draft_1', 3, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED',
    })
  })
})
