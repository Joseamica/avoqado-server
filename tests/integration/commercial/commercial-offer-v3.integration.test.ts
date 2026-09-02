import { randomUUID } from 'node:crypto'

import prisma from '@/utils/prismaClient'
import { createCommercialActivationService, prismaCommercialActivationDependencies } from '@/services/commercial/commercialActivation.service'
import { commercialCampaignDraftService } from '@/services/commercial/commercialCampaignDraft.service'
import { commercialCampaignPublicationService } from '@/services/commercial/commercialCampaignPublication.service'
import { createCommercialDraft } from '@/services/commercial/commercialDraft.service'
import { buildInitialCommercialDraftV1 } from '@/services/commercial/commercialInitialCatalog'
import {
  createCommercialPublicationService,
  prismaCommercialPublicationDependencies,
} from '@/services/commercial/commercialPublication.service'
import { commercialOfferDraftService } from '@/services/commercial/offers/commercialOfferDraft.service'
import { commercialOfferPublicationService } from '@/services/commercial/offers/commercialOfferPublication.service'
import { commercialOfferReleasePreflightService } from '@/services/commercial/offers/commercialOfferReleasePreflight.service'

const startsAt = '2026-08-01T06:00:00.000Z'
const endsAt = '2026-09-01T06:00:00.000Z'

async function staffAndActor(label: string) {
  const suffix = randomUUID().replace(/-/g, '')
  const staff = await prisma.staff.create({
    data: {
      id: `offer_v3_staff_${suffix}`,
      email: `offer-v3-${label}-${suffix}@example.test`,
      firstName: 'Offer',
      lastName: 'V3',
    },
  })
  return {
    actor: {
      staffId: staff.id,
      reason: `Prueba integrada Offer v3 ${label}`,
      permissions: ['commercial:publish'],
    },
    suffix,
  }
}

async function v2Draft(label: string) {
  const { actor, suffix } = await staffAndActor(label)
  const code = `OFFER_V3_${suffix.slice(0, 16).toUpperCase()}`
  const draft = await commercialCampaignDraftService.createDraft(
    {
      code,
      name: `Offer v3 ${label}`,
      startsAt,
      endsAt,
      stackingGroups: [],
      rules: [
        {
          code: 'POS_FIXED_50',
          type: 'FIXED_PRICE',
          priority: 100,
          target: { productCodes: ['POS'] },
          amount: '50.00',
          cycles: 3,
        },
      ],
    },
    { staffId: actor.staffId, reason: actor.reason },
  )
  return { actor, draft, suffix }
}

function hardwareBenefits() {
  return [
    {
      benefitCode: 'HARDWARE_N62_FIXED',
      kind: 'HARDWARE_FIXED_PRICE' as const,
      priority: 50,
      hardwareCatalogKey: 'NEXGO_N62',
      unitAmountMinor: '150000',
      quantityLimit: 2,
      benefitStartsAt: startsAt,
      benefitEndsAt: endsAt,
    },
  ]
}

function draftActor(actor: { staffId: string; reason: string }) {
  return { staffId: actor.staffId, reason: actor.reason }
}

describe('Commercial Offer v3 PostgreSQL authority', () => {
  beforeAll(async () => {
    const { actor, suffix } = await staffAndActor('catalog-authority')
    const initialCatalog = buildInitialCommercialDraftV1()
    const catalogDraft = await createCommercialDraft(initialCatalog.draft, { staffId: actor.staffId, reason: actor.reason })
    const publicationService = createCommercialPublicationService({
      ...prismaCommercialPublicationDependencies,
      now: () => new Date('2026-07-31T05:58:00.000Z'),
      randomId: () => `offer_v3_catalog_${suffix}`,
    })
    const preview = await publicationService.previewCommercialPublication(catalogDraft.id, catalogDraft.revision, actor)
    const publication = await publicationService.publishCommercialDraft(
      {
        draftId: catalogDraft.id,
        expectedRevision: catalogDraft.revision,
        previewToken: preview.previewToken,
        checksum: preview.checksum,
        reason: actor.reason,
        confirm: true,
      },
      actor,
    )
    const activationService = createCommercialActivationService({
      ...prismaCommercialActivationDependencies,
      now: () => new Date('2026-07-31T05:59:00.000Z'),
    })
    await activationService.activateCommercialPublication(
      {
        publicationId: publication.id,
        expectedActivationRevision: 0,
        reason: actor.reason,
        confirm: true,
      },
      actor,
    )
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('promotes, publishes once, freezes hardware and remains disconnected from operational authority', async () => {
    const { actor, draft } = await v2Draft('happy-path')
    const promoted = await commercialOfferDraftService.promoteDraft(draft.id, hardwareBenefits(), draft.revision, draftActor(actor))
    expect(promoted).toMatchObject({ offerSchemaVersion: 3, revision: draft.revision + 1 })
    expect(promoted.rules[0]).toMatchObject({ amount: '50.00' })
    expect(promoted.offerBenefits[0]).toMatchObject({ unitAmountMinor: '150000' })

    const command = {
      draftId: draft.id,
      expectedDraftRevision: promoted.revision,
      reason: actor.reason,
      confirm: true as const,
    }
    const [first, second] = await Promise.all([
      commercialOfferPublicationService.publish(command, actor),
      commercialOfferPublicationService.publish(command, actor),
    ])
    expect(second.snapshot.campaignVersionId).toBe(first.snapshot.campaignVersionId)
    expect(first.snapshot.benefits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'HARDWARE_FIXED_PRICE',
          unitAmountMinor: '150000',
          skuSnapshot: expect.objectContaining({
            catalogKey: 'NEXGO_N62',
            listUnitAmountMinor: '180000',
            currency: 'MXN',
            taxRateBasisPoints: 1600,
          }),
        }),
        expect.objectContaining({ kind: 'SAAS_PRICE', rules: [expect.objectContaining({ amount: '50.00' })] }),
      ]),
    )
    await expect(
      prisma.commercialCampaignVersion.count({
        where: { sourceDraftId: draft.id, sourceRevision: promoted.revision, schemaVersion: 3 },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.activityLog.count({ where: { action: 'COMMERCIAL_OFFER_V3_PUBLISHED', entityId: first.snapshot.campaignVersionId } }),
    ).resolves.toBe(1)
    await expect(commercialOfferReleasePreflightService.run()).resolves.toMatchObject({
      status: 'PASS',
      schemaVersion: 3,
      q3a: {
        allowed: { offerControlEvents: 0, directQuotes: 0, directQuoteAcceptances: 0 },
        prohibited: {
          campaignActivations: 0,
          campaignClaims: 0,
          acquisitionContexts: 0,
          legacyCampaignLinkedQuotes: 0,
          invalidOfferQuoteShapes: 0,
          previewBridges: 0,
          stripeOperations: 0,
          subscriptionEvents: 0,
        },
      },
    })
  })

  it('allows exactly one concurrent v2-to-v3 promotion winner', async () => {
    const { actor, draft } = await v2Draft('promotion-race')
    const attempts = await Promise.allSettled([
      commercialOfferDraftService.promoteDraft(draft.id, hardwareBenefits(), draft.revision, draftActor(actor)),
      commercialOfferDraftService.promoteDraft(draft.id, hardwareBenefits(), draft.revision, draftActor(actor)),
    ])
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1)
    expect(attempts.find(attempt => attempt.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ code: 'COMMERCIAL_OFFER_DRAFT_CONFLICT' }),
    })
    await expect(prisma.commercialOfferBenefitDraft.count({ where: { campaignDraftId: draft.id } })).resolves.toBe(1)
  })

  it('serializes a v2 publication racing a v3 promotion without deleting the v3 benefits', async () => {
    const { actor, draft } = await v2Draft('publish-race')
    const results = await Promise.allSettled([
      commercialCampaignPublicationService.publishAndActivate(
        {
          draftId: draft.id,
          expectedDraftRevision: draft.revision,
          expectedActivationRevision: null,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
      commercialOfferDraftService.promoteDraft(draft.id, hardwareBenefits(), draft.revision, draftActor(actor)),
    ])
    expect(results[1].status).toBe('fulfilled')
    if (results[0].status === 'fulfilled') expect(results[0].value.version.schemaVersion).toBe(2)
    else expect(results[0].reason).toMatchObject({ code: 'COMMERCIAL_CAMPAIGN_DRAFT_SCHEMA_UNSUPPORTED' })
    await expect(commercialOfferDraftService.getDraft(draft.id)).resolves.toMatchObject({
      offerSchemaVersion: 3,
      offerBenefits: [expect.objectContaining({ benefitCode: 'HARDWARE_N62_FIXED' })],
    })
  })

  it('enforces v3 discriminants, immutable versions and all four operational-reference barriers in SQL', async () => {
    const { actor, draft, suffix } = await v2Draft('sql-guards')
    await expect(
      prisma.$executeRaw`
        INSERT INTO "CommercialOfferBenefitDraft" (
          "id", "campaignDraftId", "offerSchemaVersion", "benefitCode", "kind", "priority",
          "hardwareCatalogKey", "unitAmountMinor", "quantityLimit", "benefitStartsAt", "benefitEndsAt", "updatedAt"
        ) VALUES (
          ${`bad_parent_${suffix}`}, ${draft.id}, 3, 'BAD_PARENT_FIXED', 'HARDWARE_FIXED_PRICE', 1,
          'NEXGO_N62', 100, 1, ${new Date(startsAt)}, ${new Date(endsAt)}, CURRENT_TIMESTAMP
        )
      `,
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '23503' }) })

    const promoted = await commercialOfferDraftService.promoteDraft(draft.id, hardwareBenefits(), draft.revision, draftActor(actor))
    await expect(
      prisma.$executeRaw`
        INSERT INTO "CommercialOfferBenefitDraft" (
          "id", "campaignDraftId", "offerSchemaVersion", "benefitCode", "kind", "priority",
          "hardwareCatalogKey", "unitAmountMinor", "quantityLimit", "benefitStartsAt", "benefitEndsAt", "updatedAt"
        ) VALUES (
          ${`bad_shape_${suffix}`}, ${draft.id}, 3, 'BAD_SHAPE_FIXED', 'HARDWARE_FIXED_PRICE', 1,
          'NEXGO_N62', -1, 0, ${new Date(endsAt)}, ${new Date(startsAt)}, CURRENT_TIMESTAMP
        )
      `,
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '23514' }) })

    const published = await commercialOfferPublicationService.publish(
      { draftId: draft.id, expectedDraftRevision: promoted.revision, reason: actor.reason, confirm: true },
      actor,
    )
    const versionId = published.snapshot.campaignVersionId
    await expect(
      prisma.$executeRaw`UPDATE "CommercialCampaignVersion" SET "reason" = 'mutated' WHERE "id" = ${versionId}`,
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '55000' }) })
    await expect(
      prisma.$executeRaw`DELETE FROM "CommercialCampaignVersion" WHERE "id" = ${versionId}`,
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '55000' }) })

    const operationalWrites = [
      prisma.$executeRaw`
        INSERT INTO "CommercialCampaignActivation" (
          "id", "environment", "campaignCode", "campaignVersionId", "reason", "updatedById", "updatedAt"
        ) VALUES (
          ${`activation_${suffix}`}, 'PREVIEW', ${published.snapshot.campaignCode}, ${versionId}, 'forbidden', ${actor.staffId}, CURRENT_TIMESTAMP
        )
      `,
      prisma.$executeRaw`
        INSERT INTO "CommercialCampaignClaim" (
          "id", "tokenHash", "campaignVersionId", "campaignCode", "channel", "sourceRef", "issuedById", "reason", "expiresAt"
        ) VALUES (
          ${`claim_${suffix}`}, ${'a'.repeat(64)}, ${versionId}, ${published.snapshot.campaignCode}, 'DIRECT', 'forbidden',
          ${actor.staffId}, 'forbidden', ${new Date(endsAt)}
        )
      `,
      prisma.$executeRaw`
        INSERT INTO "CommercialAcquisitionContext" (
          "id", "tokenHash", "campaignVersionId", "channel", "attribution", "expiresAt"
        ) VALUES (
          ${`context_${suffix}`}, ${'b'.repeat(64)}, ${versionId}, 'DIRECT', '{}'::jsonb, ${new Date(endsAt)}
        )
      `,
      prisma.$executeRaw`
        INSERT INTO "CommercialQuote" (
          "id", "catalogPublicationId", "campaignVersionId", "schemaVersion", "market", "currency", "snapshot", "checksum",
          "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
          "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "expiresAt"
        ) VALUES (
          ${`quote_${suffix}`}, 'missing-catalog', ${versionId}, 2, 'MX', 'MXN', '{}'::jsonb, ${'c'.repeat(64)},
          0, 0, 0, 0, 0, 0, 0, 0, ${new Date(endsAt)}
        )
      `,
    ]
    const rejected = await Promise.allSettled(operationalWrites)
    expect(rejected).toHaveLength(4)
    for (const result of rejected) {
      expect(result).toMatchObject({ status: 'rejected', reason: { meta: expect.objectContaining({ code: '23514' }) } })
    }
  })

  it('rejects moving an existing v2 activation to a published v3 version', async () => {
    const { actor, draft } = await v2Draft('activation-update-guard')
    const publishedV2 = await commercialCampaignPublicationService.publishAndActivate(
      {
        draftId: draft.id,
        expectedDraftRevision: draft.revision,
        expectedActivationRevision: null,
        reason: actor.reason,
        confirm: true,
      },
      actor,
    )
    const promoted = await commercialOfferDraftService.promoteDraft(draft.id, hardwareBenefits(), draft.revision, draftActor(actor))
    const publishedV3 = await commercialOfferPublicationService.publish(
      { draftId: draft.id, expectedDraftRevision: promoted.revision, reason: actor.reason, confirm: true },
      actor,
    )

    await expect(
      prisma.$executeRaw`
        UPDATE "CommercialCampaignActivation"
        SET "campaignVersionId" = ${publishedV3.snapshot.campaignVersionId}
        WHERE "id" = ${publishedV2.activation.id}
      `,
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '23514' }) })
    await expect(
      prisma.commercialCampaignActivation.findUnique({ where: { id: publishedV2.activation.id } }),
    ).resolves.toMatchObject({ campaignVersionId: publishedV2.version.id })
  })

  it('serializes a concurrent v3 version insert before checking an operational reference', async () => {
    const { actor, draft, suffix } = await v2Draft('uncommitted-version-race')
    const promoted = await commercialOfferDraftService.promoteDraft(draft.id, hardwareBenefits(), draft.revision, draftActor(actor))
    const versionId = `offer_v3_race_${suffix}`
    const checksum = randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64)
    let signalInserted!: () => void
    let allowCommit!: () => void
    const inserted = new Promise<void>(resolve => {
      signalInserted = resolve
    })
    const commitGate = new Promise<void>(resolve => {
      allowCommit = resolve
    })

    const versionWrite = prisma.$transaction(async tx => {
      await tx.$executeRaw`
        INSERT INTO "CommercialCampaignVersion" (
          "id", "campaignCode", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById"
        ) VALUES (
          ${versionId}, ${draft.code}, ${draft.id}, ${promoted.revision}, 3, ${JSON.stringify({ schemaVersion: 3 })}::jsonb,
          ${checksum}, 'concurrent race proof', ${actor.staffId}
        )
      `
      signalInserted()
      await commitGate
    })
    await inserted

    const referenceAttempt = prisma
      .$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'")
        return tx.$executeRaw`
          INSERT INTO "CommercialCampaignActivation" (
            "id", "environment", "campaignCode", "campaignVersionId", "reason", "updatedById", "updatedAt"
          ) VALUES (
            ${`activation_race_${suffix}`}, 'PREVIEW', ${draft.code}, ${versionId}, 'must fail closed', ${actor.staffId}, CURRENT_TIMESTAMP
          )
        `
      })
      .then(
        value => ({ status: 'fulfilled' as const, value }),
        reason => ({ status: 'rejected' as const, reason }),
      )

    await new Promise(resolve => setTimeout(resolve, 100))
    allowCommit()
    await versionWrite
    const result = await referenceAttempt
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') throw new Error('EXPECTED_OPERATIONAL_REFERENCE_REJECTION')
    // PostgreSQL may reject from our schema-v3 trigger (23514) or from the
    // composite FK's statement snapshot (23503). Both are fail-closed; the
    // invariant is that the concurrent operational row can never commit.
    expect(['23503', '23514']).toContain(result.reason?.meta?.code)
    await expect(
      prisma.commercialCampaignActivation.count({ where: { campaignVersionId: versionId } }),
    ).resolves.toBe(0)
  })

  it('fails closed if a rollback rehearsal tries to narrow schema support while v3 rows exist', async () => {
    await expect(
      prisma.$transaction(tx =>
        tx.$executeRawUnsafe(`
          ALTER TABLE "CommercialCampaignVersion"
            DROP CONSTRAINT "CommercialCampaignVersion_schema_version_check",
            ADD CONSTRAINT "CommercialCampaignVersion_schema_version_check" CHECK ("schemaVersion" IN (1, 2))
        `),
      ),
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '23514' }) })

    const constraints = await prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'CommercialCampaignVersion_schema_version_check'
    `
    expect(constraints).toEqual([expect.objectContaining({ definition: expect.stringContaining('ANY (ARRAY[1, 2, 3])') })])
  })
})
