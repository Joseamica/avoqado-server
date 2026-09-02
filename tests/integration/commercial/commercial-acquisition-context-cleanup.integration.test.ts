import catalogFixtureJson from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import {
  cleanupCommercialAcquisitionContexts,
  createCommercialAcquisitionContextCleanupService,
  prismaCommercialAcquisitionContextCleanupRepository,
} from '@/services/commercial/commercialAcquisitionContextCleanup.service'
import { prismaCommercialPublicationDependencies } from '@/services/commercial/commercialPublication.service'
import { evaluateCommercialQuoteV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import { persistCommercialQuoteV2 } from '@/services/commercial/commercialQuotePersistence.service'
import { buildCommercialQuoteV2 } from '@/services/commercial/commercialQuoteV2Builder.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import prisma from '@/utils/prismaClient'

const RUN_SUFFIX = `${process.pid}-${Date.now()}`
const FIXTURE_IDS = Object.freeze({
  expiredDirect: `acquisition-cleanup-expired-direct-${RUN_SUFFIX}`,
  futureDirect: `acquisition-cleanup-future-direct-${RUN_SUFFIX}`,
  expiredService: `acquisition-cleanup-expired-service-${RUN_SUFFIX}`,
  futureService: `acquisition-cleanup-future-service-${RUN_SUFFIX}`,
  timezoneFuture: `acquisition-cleanup-timezone-future-${RUN_SUFFIX}`,
  previewGrace: `acquisition-cleanup-preview-grace-${RUN_SUFFIX}`,
  graceElapsed: `acquisition-cleanup-grace-elapsed-${RUN_SUFFIX}`,
})

function fixtureTokenHash(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}

const SHARED_FUNCTION_BODY = `
BEGIN
  RAISE EXCEPTION '% is immutable; create a new version or lifecycle record', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
`

function postgresCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  const meta = Object.getOwnPropertyDescriptor(error, 'meta')
  if (!meta || !('value' in meta) || typeof meta.value !== 'object' || meta.value === null) return undefined
  return Object.getOwnPropertyDescriptor(meta.value, 'code')?.value
}

async function expectPostgresCode(operation: Promise<unknown>, code: string): Promise<void> {
  try {
    await operation
    throw new Error(`EXPECTED_POSTGRES_${code}`)
  } catch (error) {
    expect(postgresCode(error)).toBe(code)
  }
}

describe('commercial acquisition context cleanup migration and repository', () => {
  beforeAll(async () => {
    const catalogSnapshot = JSON.parse(JSON.stringify(catalogFixtureJson)) as CommercialCatalogSnapshotV2
    const publishedAt = new Date(catalogSnapshot.publishedAt)
    await prisma.staff.upsert({
      where: { id: 'staff-commercial-acquisition-cleanup' },
      update: {},
      create: {
        id: 'staff-commercial-acquisition-cleanup',
        email: 'commercial-acquisition-cleanup@avoqado.test',
        firstName: 'Commercial',
        lastName: 'Cleanup',
      },
    })
    await prisma.commercialDraft.upsert({
      where: { id: 'draft-commercial-acquisition-cleanup' },
      update: {},
      create: {
        id: 'draft-commercial-acquisition-cleanup',
        sourceKey: 'draft-commercial-acquisition-cleanup',
        name: 'Commercial acquisition cleanup fixture',
        createdById: 'staff-commercial-acquisition-cleanup',
        updatedById: 'staff-commercial-acquisition-cleanup',
      },
    })
    const catalog = emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue: catalogSnapshot })
    await prismaCommercialPublicationDependencies.runInTransaction(tx =>
      tx.createPublicationIfAbsent({
        id: catalogSnapshot.publicationId,
        sourceDraftId: 'draft-commercial-acquisition-cleanup',
        sourceRevision: 1,
        artifact: catalog,
        reason: 'Disposable cleanup integration fixture',
        publishedById: 'staff-commercial-acquisition-cleanup',
        publishedAt,
      }),
    )
    const activation = await prisma.commercialPublicationActivation.findUnique({ where: { environment: 'PRODUCTION' } })
    if (!activation) {
      await prisma.commercialPublicationActivation.create({
        data: {
          environment: 'PRODUCTION',
          publicationId: catalogSnapshot.publicationId,
          revision: 1,
          reason: 'Disposable cleanup integration fixture',
          updatedById: 'staff-commercial-acquisition-cleanup',
        },
      })
    }
    const organization = await prisma.organization.upsert({
      where: { id: 'organization-commercial-acquisition-cleanup' },
      update: {},
      create: {
        id: 'organization-commercial-acquisition-cleanup',
        name: 'Commercial acquisition cleanup',
        email: 'commercial-acquisition-cleanup-organization@avoqado.test',
        phone: '0000000000',
      },
    })
    const venue = await prisma.venue.upsert({
      where: { id: 'venue-commercial-acquisition-cleanup' },
      update: {},
      create: {
        id: 'venue-commercial-acquisition-cleanup',
        organizationId: organization.id,
        name: 'Commercial acquisition cleanup venue',
        slug: 'commercial-acquisition-cleanup-venue',
      },
    })

    const databaseNow = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT pg_catalog.now() AS "now"`
    const now = databaseNow[0].now
    const contextFixture = (id: string, tokenHash: string, expiresAt: Date) => ({
      id,
      tokenHash,
      campaignVersionId: null,
      channel: 'DIRECT' as const,
      attribution: {},
      createdAt: new Date(now.getTime() - 60 * 60_000),
      expiresAt,
    })
    await prisma.commercialAcquisitionContext.createMany({
      skipDuplicates: true,
      data: [
        contextFixture(FIXTURE_IDS.expiredDirect, fixtureTokenHash(FIXTURE_IDS.expiredDirect), new Date(now.getTime() - 30 * 60_000)),
        contextFixture(FIXTURE_IDS.futureDirect, fixtureTokenHash(FIXTURE_IDS.futureDirect), new Date(now.getTime() + 24 * 60 * 60_000)),
        contextFixture(FIXTURE_IDS.expiredService, fixtureTokenHash(FIXTURE_IDS.expiredService), new Date(now.getTime() - 30 * 60_000)),
        contextFixture(FIXTURE_IDS.futureService, fixtureTokenHash(FIXTURE_IDS.futureService), new Date(now.getTime() + 24 * 60 * 60_000)),
        contextFixture('acquisition-cleanup-referenced', 'e'.repeat(64), new Date(now.getTime() - 30 * 60_000)),
        contextFixture('acquisition-cleanup-bridge-only', '3'.repeat(64), new Date(now.getTime() - 30 * 60_000)),
      ],
    })

    const quotedAt = new Date(now.getTime() - 20 * 60 * 1000)
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000)
    const evaluation = evaluateCommercialQuoteV2({
      catalog: catalog.snapshot,
      campaign: null,
      lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      now: quotedAt,
    })
    const quote = buildCommercialQuoteV2({
      quoteId: 'quote-acquisition-cleanup-referenced',
      subject: {
        kind: 'VENUE',
        organizationId: organization.id,
        venueId: venue.id,
        actorId: 'staff-commercial-acquisition-cleanup',
      },
      acquisitionContextId: 'acquisition-cleanup-referenced',
      derivedFromPreview: {
        previewQuoteId: 'preview-acquisition-cleanup-referenced',
        previewChecksum: '6'.repeat(64),
        selectionFingerprint: '7'.repeat(64),
      },
      quotedAt,
      expiresAt,
      evaluation,
      authorities: { catalog, campaign: null },
    })
    const existingQuote = await prisma.commercialQuote.findUnique({ where: { id: quote.snapshot.quoteId } })
    if (!existingQuote) await prisma.$transaction(tx => persistCommercialQuoteV2(quote, tx))
    const existingBridge = await prisma.commercialQuotePreviewBridge.findUnique({
      where: { previewQuoteId: 'preview-acquisition-cleanup-bridge-only' },
    })
    if (!existingBridge) {
      await prisma.commercialQuotePreviewBridge.create({
        data: {
          previewQuoteId: 'preview-acquisition-cleanup-bridge-only',
          previewChecksum: '4'.repeat(64),
          acquisitionContextId: 'acquisition-cleanup-bridge-only',
          organizationId: organization.id,
          venueId: venue.id,
          actorId: 'staff-commercial-acquisition-cleanup',
          selectionFingerprint: '5'.repeat(64),
          venueQuoteId: quote.snapshot.quoteId,
        },
      })
    }
  })

  afterAll(async () => prisma.$disconnect())

  it('keeps all five immutable triggers exact and changes only the acquisition function', async () => {
    const triggers = await prisma.$queryRaw<Array<{ tableName: string; triggerName: string; triggerType: number; functionName: string }>>`
      SELECT
        relation.relname AS "tableName",
        trigger.tgname AS "triggerName",
        trigger.tgtype::integer AS "triggerType",
        procedure.proname AS "functionName"
      FROM pg_trigger AS trigger
      JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
      WHERE namespace.nspname = 'public'
        AND NOT trigger.tgisinternal
        AND trigger.tgname IN (
          'commercial_campaign_version_immutable',
          'commercial_campaign_claim_immutable',
          'commercial_acquisition_context_immutable',
          'commercial_quote_immutable',
          'commercial_subscription_event_immutable'
        )
      ORDER BY trigger.tgname
    `

    expect(triggers).toHaveLength(5)
    expect(triggers.every(trigger => trigger.triggerType === 27)).toBe(true)
    expect(triggers.find(trigger => trigger.triggerName === 'commercial_acquisition_context_immutable')).toEqual({
      tableName: 'CommercialAcquisitionContext',
      triggerName: 'commercial_acquisition_context_immutable',
      triggerType: 27,
      functionName: 'reject_commercial_acquisition_context_unsafe_mutation',
    })
    expect(
      triggers
        .filter(trigger => trigger.triggerName !== 'commercial_acquisition_context_immutable')
        .every(trigger => trigger.functionName === 'reject_commercial_immutable_mutation'),
    ).toBe(true)
    const sharedFunction = await prisma.$queryRaw<Array<{ source: string }>>`
      SELECT prosrc AS "source"
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = 'reject_commercial_immutable_mutation'
    `
    expect(sharedFunction).toEqual([{ source: SHARED_FUNCTION_BODY }])
  })

  it('rejects every UPDATE and a nonexpired DELETE while allowing only expired unreferenced DELETE to reach FK rules', async () => {
    const expiryEvidence = await prisma.$queryRaw<Array<{ id: string; expired: boolean }>>`
      SELECT "id", "expiresAt" <= (pg_catalog.now() AT TIME ZONE 'UTC') AS "expired"
      FROM "CommercialAcquisitionContext"
      WHERE "id" = ${FIXTURE_IDS.expiredDirect}
         OR "id" = ${FIXTURE_IDS.futureDirect}
      ORDER BY "id"
    `
    expect(expiryEvidence).toEqual([
      { id: FIXTURE_IDS.expiredDirect, expired: true },
      { id: FIXTURE_IDS.futureDirect, expired: false },
    ])
    await expectPostgresCode(
      prisma.$executeRaw`UPDATE "CommercialAcquisitionContext" SET "channel" = 'ORGANIC' WHERE "id" = ${FIXTURE_IDS.expiredDirect}`,
      '55000',
    )
    await expectPostgresCode(
      prisma.$executeRaw`DELETE FROM "CommercialAcquisitionContext" WHERE "id" = ${FIXTURE_IDS.futureDirect}`,
      '55000',
    )
    await expect(prisma.$executeRaw`DELETE FROM "CommercialAcquisitionContext" WHERE "id" = ${FIXTURE_IDS.expiredDirect}`).resolves.toBe(1)
    await expectPostgresCode(
      prisma.$executeRaw`DELETE FROM "CommercialAcquisitionContext" WHERE "id" = 'acquisition-cleanup-referenced'`,
      '23503',
    )
    await expectPostgresCode(
      prisma.$executeRaw`DELETE FROM "CommercialAcquisitionContext" WHERE "id" = 'acquisition-cleanup-bridge-only'`,
      '23503',
    )
  })

  it('uses the database clock, deletes only expired unreferenced rows and preserves quote lineage', async () => {
    const databaseCutoff = await prismaCommercialAcquisitionContextCleanupRepository.getDatabaseCutoff()
    const candidates = await prismaCommercialAcquisitionContextCleanupRepository.listCandidates({
      databaseCutoff,
      afterId: null,
      limit: 100,
    })
    const references = await Promise.all(
      candidates.map(async candidate => ({
        id: candidate.id,
        referenced:
          (await prisma.commercialQuote.count({ where: { acquisitionContextId: candidate.id } })) > 0 ||
          (await prisma.commercialQuotePreviewBridge.count({ where: { acquisitionContextId: candidate.id } })) > 0,
      })),
    )
    const expectedReferenced = references.filter(candidate => candidate.referenced).length
    const expectedDeleted = references.length - expectedReferenced
    const result = await cleanupCommercialAcquisitionContexts({
      execute: true,
      pageSize: 100,
      maxScanned: 100,
      maxRuntimeMs: 5_000,
    })

    expect(result).toMatchObject({
      scanned: candidates.length,
      deleted: expectedDeleted,
      preservedReferenced: expectedReferenced,
      preservedDatabaseRejected: 0,
      retried: 0,
      exhausted: candidates.length === 100,
    })
    const expectedResidualIds = [
      'acquisition-cleanup-bridge-only',
      FIXTURE_IDS.futureDirect,
      FIXTURE_IDS.futureService,
      'acquisition-cleanup-referenced',
    ].sort()
    const residual = await prisma.commercialAcquisitionContext.findMany({
      where: { id: { in: expectedResidualIds } },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
    expect(residual).toEqual(expectedResidualIds.map(id => ({ id })))
    await expect(prisma.commercialQuote.count({ where: { acquisitionContextId: 'acquisition-cleanup-referenced' } })).resolves.toBe(1)
    await expect(
      prisma.commercialQuotePreviewBridge.count({ where: { acquisitionContextId: 'acquisition-cleanup-bridge-only' } }),
    ).resolves.toBe(1)
  })

  it('classifies real P2010-wrapped trigger and foreign-key SQLSTATEs without aborting the sweep', async () => {
    const repository = {
      getDatabaseCutoff: prismaCommercialAcquisitionContextCleanupRepository.getDatabaseCutoff,
      listCandidates: jest.fn().mockResolvedValue([{ id: 'database-trigger-rejection' }, { id: 'database-foreign-key-rejection' }]),
      deleteCandidate: async ({ id }: { id: string; databaseCutoff: Date }) => {
        if (id === 'database-trigger-rejection') {
          await prisma.$executeRaw`DELETE FROM "CommercialAcquisitionContext" WHERE "id" = ${FIXTURE_IDS.futureService}`
        } else {
          await prisma.$executeRaw`DELETE FROM "CommercialAcquisitionContext" WHERE "id" = 'acquisition-cleanup-referenced'`
        }
        return { deleted: true, preservedReferenced: false }
      },
    }

    await expect(
      createCommercialAcquisitionContextCleanupService({ repository, monotonicNow: () => 0 })({
        execute: true,
        pageSize: 10,
        maxScanned: 10,
        maxRuntimeMs: 5_000,
      }),
    ).resolves.toMatchObject({
      scanned: 2,
      deleted: 0,
      preservedReferenced: 1,
      preservedDatabaseRejected: 1,
      retried: 0,
    })
  })

  it('uses UTC semantics and preserves a preview-token grace period under a non-UTC session', async () => {
    const databaseNow = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT pg_catalog.now() AS "now"`
    const now = databaseNow[0].now
    await prisma.commercialAcquisitionContext.createMany({
      skipDuplicates: true,
      data: [
        {
          id: FIXTURE_IDS.timezoneFuture,
          tokenHash: fixtureTokenHash(FIXTURE_IDS.timezoneFuture),
          campaignVersionId: null,
          channel: 'DIRECT',
          attribution: {},
          createdAt: new Date(now.getTime() - 60_000),
          expiresAt: new Date(now.getTime() + 5 * 60_000),
        },
        {
          id: FIXTURE_IDS.previewGrace,
          tokenHash: fixtureTokenHash(FIXTURE_IDS.previewGrace),
          campaignVersionId: null,
          channel: 'DIRECT',
          attribution: {},
          createdAt: new Date(now.getTime() - 60 * 60_000),
          expiresAt: new Date(now.getTime() - 19 * 60_000),
        },
        {
          id: FIXTURE_IDS.graceElapsed,
          tokenHash: fixtureTokenHash(FIXTURE_IDS.graceElapsed),
          campaignVersionId: null,
          channel: 'DIRECT',
          attribution: {},
          createdAt: new Date(now.getTime() - 60 * 60_000),
          expiresAt: new Date(now.getTime() - 21 * 60_000),
        },
      ],
    })

    for (const id of [FIXTURE_IDS.timezoneFuture, FIXTURE_IDS.previewGrace]) {
      await expectPostgresCode(
        prisma.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`
          await tx.$executeRaw`DELETE FROM "CommercialAcquisitionContext" WHERE "id" = ${id}`
        }),
        '55000',
      )
    }
    await expect(
      prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`
        return tx.$executeRaw`DELETE FROM "CommercialAcquisitionContext" WHERE "id" = ${FIXTURE_IDS.graceElapsed}`
      }),
    ).resolves.toBe(1)

    const cutoff = await prismaCommercialAcquisitionContextCleanupRepository.getDatabaseCutoff()
    const candidates = await prismaCommercialAcquisitionContextCleanupRepository.listCandidates({
      databaseCutoff: cutoff,
      afterId: null,
      limit: 100,
    })
    const candidateIds = candidates.map(candidate => candidate.id)
    expect(candidateIds).not.toContain(FIXTURE_IDS.timezoneFuture)
    expect(candidateIds).not.toContain(FIXTURE_IDS.previewGrace)
  })
})
import { createHash } from 'node:crypto'
