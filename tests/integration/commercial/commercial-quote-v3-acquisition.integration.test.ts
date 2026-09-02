import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { Prisma, PrismaClient, StaffRole } from '@prisma/client'
import { Client } from 'pg'

import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import {
  createCommercialAcquisitionContextCleanupService,
  createPrismaCommercialAcquisitionContextCleanupRepository,
} from '@/services/commercial/commercialAcquisitionContextCleanup.service'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  countAllowedCommercialOfferV3Q3BReferences,
  countProhibitedCommercialOfferV3Q3BReferences,
} from '@/services/commercial/offers/commercialOfferReleasePreflight.service'
import { createPrismaCommercialAcquisitionBindingV3Service } from '@/services/commercial/quotes-v3/commercialAcquisitionBindingV3.service'
import { createPrismaCommercialAcquisitionContextV3Service } from '@/services/commercial/quotes-v3/commercialAcquisitionContextV3.service'
import { createPrismaCommercialOfferClaimV3Service } from '@/services/commercial/quotes-v3/commercialOfferClaimV3.service'
import { createPrismaCommercialDirectQuoteV3Service } from '@/services/commercial/quotes-v3/commercialDirectQuoteV3.service'
import { createPrismaCommercialPublicQuotePreviewV3Service } from '@/services/commercial/quotes-v3/commercialPublicQuotePreviewV3.service'
import { createPrismaCommercialQuotePreviewBridgeV3Service } from '@/services/commercial/quotes-v3/commercialQuotePreviewBridgeV3.service'
import {
  createCommercialQuoteV3AcceptanceService,
  createPrismaCommercialQuoteV3AcceptanceService,
  createPrismaCommercialQuoteV3AcceptanceTransaction,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Acceptance.service'
import { verifyCommercialQuotePreviewTokenV3 } from '@/services/commercial/quotes-v3/commercialQuotePreviewTokenV3.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'

jest.setTimeout(120_000)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function maintenanceDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL
  if (!raw?.trim()) throw new Error('COMMERCIAL_ACQUISITION_V3_TEST_DATABASE_URL_REQUIRED')
  const parsed = new URL(raw)
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !/test/iu.test(parsed.pathname)) {
    throw new Error('COMMERCIAL_ACQUISITION_V3_DISPOSABLE_DATABASE_REQUIRED')
  }
  parsed.searchParams.set('application_name', `commercial-acquisition-v3-${process.pid}`)
  return parsed.toString()
}

function quoteIdentifier(value: string): string {
  if (!/^avoqado_acquisition_v3_[a-z0-9_]+$/u.test(value)) {
    throw new Error('COMMERCIAL_ACQUISITION_V3_DATABASE_NAME_REJECTED')
  }
  return `"${value}"`
}

function databaseUrl(maintenanceUrl: string, databaseName: string): string {
  const parsed = new URL(maintenanceUrl)
  parsed.pathname = `/${databaseName}`
  return parsed.toString()
}

function postgresCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const candidate = error as { code?: unknown; meta?: unknown }
  const meta = typeof candidate.meta === 'object' && candidate.meta !== null ? (candidate.meta as { code?: unknown }) : null
  return typeof meta?.code === 'string' ? meta.code : typeof candidate.code === 'string' ? candidate.code : null
}

function applicationCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

async function expectPostgresCode(promise: Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await promise
    throw new Error(`EXPECTED_POSTGRES_${expectedCode}`)
  } catch (error) {
    expect(postgresCode(error)).toBe(expectedCode)
  }
}

describe('Commercial Quote v3 acquisition PostgreSQL laboratory', () => {
  const repoRoot = path.resolve(__dirname, '../../..')
  let admin: Client
  let prisma: PrismaClient
  let databaseName: string
  let targetUrl: string

  const ids = {
    publisher: 'acquisition_v3_publisher',
    catalogDraft: 'acquisition_v3_catalog_draft',
    catalog: 'acquisition_v3_catalog',
    catalogActivation: 'acquisition_v3_catalog_activation',
    offerDraft: 'acquisition_v3_offer_draft',
    offer: 'acquisition_v3_offer',
  }
  const previewSecrets = {
    publicationPreviewSigningSecret: 'integration-publication-preview-secret-v3'.repeat(2),
    quotePreviewSigningSecret: 'integration-quote-preview-secret-v3'.repeat(2),
  }

  beforeAll(async () => {
    const maintenanceUrl = maintenanceDatabaseUrl()
    databaseName = `avoqado_acquisition_v3_${process.pid}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    admin = new Client({ connectionString: maintenanceUrl })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    targetUrl = databaseUrl(maintenanceUrl, databaseName)
    const migration = spawnSync(path.join(repoRoot, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: targetUrl },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (migration.error || migration.status !== 0) {
      throw new Error(
        `COMMERCIAL_ACQUISITION_V3_MIGRATION_FAILED:${migration.status ?? 'NO_STATUS'}:${migration.error?.message ?? ''}\n${migration.stdout}\n${migration.stderr}`,
      )
    }
    prisma = new PrismaClient({ datasources: { db: { url: targetUrl } } })

    await prisma.staff.create({
      data: {
        id: ids.publisher,
        email: 'acquisition-v3-publisher@example.test',
        firstName: 'Acquisition',
        lastName: 'Publisher',
      },
    })

    const catalogSource = clone(catalogFixture) as CommercialCatalogSnapshotV2
    catalogSource.publicationId = ids.catalog
    const emittedCatalog = emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue: catalogSource })
    await prisma.commercialDraft.create({
      data: {
        id: ids.catalogDraft,
        name: 'Acquisition v3 catalog draft',
        createdById: ids.publisher,
        updatedById: ids.publisher,
      },
    })
    await prisma.commercialPublication.create({
      data: {
        id: ids.catalog,
        sourceDraftId: ids.catalogDraft,
        sourceRevision: 1,
        schemaVersion: 2,
        snapshot: emittedCatalog.snapshot as unknown as Prisma.InputJsonValue,
        checksum: emittedCatalog.checksum,
        reason: 'Acquisition v3 integration catalog',
        publishedById: ids.publisher,
        publishedAt: new Date(emittedCatalog.snapshot.publishedAt),
      },
    })
    await prisma.commercialPublicationActivation.create({
      data: {
        id: ids.catalogActivation,
        environment: 'PRODUCTION',
        publicationId: ids.catalog,
        reason: 'Acquisition v3 integration activation',
        updatedById: ids.publisher,
      },
    })

    const offerSource = clone(offerFixture) as CommercialOfferSnapshotV3
    offerSource.campaignVersionId = ids.offer
    offerSource.campaignCode = 'ACQUISITION_V3'
    offerSource.claimStartsAt = '2026-01-01T00:00:00.000Z'
    offerSource.claimEndsAt = '2027-01-01T00:00:00.000Z'
    const emittedOffer = emitCommercialOfferV3(offerSource)
    await prisma.commercialCampaignDraft.create({
      data: {
        id: ids.offerDraft,
        code: offerSource.campaignCode,
        name: 'Acquisition v3 offer draft',
        revision: 1,
        offerSchemaVersion: 3,
        startsAt: new Date(offerSource.claimStartsAt),
        endsAt: new Date(offerSource.claimEndsAt),
        stackingGroups: [],
        createdById: ids.publisher,
        updatedById: ids.publisher,
      },
    })
    await prisma.commercialCampaignVersion.create({
      data: {
        id: ids.offer,
        campaignCode: offerSource.campaignCode,
        sourceDraftId: ids.offerDraft,
        sourceRevision: 1,
        schemaVersion: 3,
        snapshot: emittedOffer.snapshot as unknown as Prisma.InputJsonValue,
        checksum: emittedOffer.checksum,
        reason: 'Acquisition v3 integration offer',
        publishedById: ids.publisher,
        publishedAt: new Date(emittedOffer.snapshot.publishedAt),
      },
    })
  })

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined)
    if (admin && databaseName) {
      await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => undefined)
    }
    await admin?.end().catch(() => undefined)
  })

  it('applies and validates dedicated lineage while preserving every legacy schema-3 barrier', async () => {
    const constraints = [
      'CommercialCampaignClaim_authority_shape_v3_pending',
      'CommercialCampaignClaim_offerVersionId_offerSchemaVersion_fkey',
      'CommercialAcquisitionContext_authority_shape_v3_pending',
      'CommercialAcqContext_offerVersion_schemaVersion_fkey',
      'CommercialAcqContext_reservedCatalog_schemaVersion_fkey',
    ]
    const validated = await prisma.$queryRaw<Array<{ conname: string; convalidated: boolean }>>`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conname = ANY(${constraints}::text[])
      ORDER BY conname
    `
    expect(validated).toHaveLength(constraints.length)
    expect(validated.every(item => item.convalidated)).toBe(true)

    const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname = ANY(${[
          'commercial_campaign_activation_reject_offer_v3',
          'commercial_campaign_claim_reject_offer_v3',
          'commercial_acquisition_context_reject_offer_v3',
          'commercial_quote_reject_offer_v3',
        ]}::text[])
      ORDER BY tgname
    `
    expect(triggers.map(item => item.tgname)).toEqual([
      'commercial_acquisition_context_reject_offer_v3',
      'commercial_campaign_activation_reject_offer_v3',
      'commercial_campaign_claim_reject_offer_v3',
      'commercial_quote_reject_offer_v3',
    ])
    const immutableTriggers = await prisma.$queryRaw<Array<{ tgname: string; tgenabled: string }>>`
      SELECT tgname, tgenabled
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname = ANY(${[
          'commercial_acquisition_context_binding_immutable',
          'commercial_acquisition_context_binding_truncate_immutable',
          'commercial_acquisition_redemption_immutable',
          'commercial_acquisition_redemption_truncate_immutable',
          'commercial_quote_preview_bridge_immutable',
          'commercial_quote_preview_bridge_truncate_immutable',
        ]}::text[])
      ORDER BY tgname
    `
    expect(immutableTriggers).toHaveLength(6)
    expect(immutableTriggers.every(trigger => trigger.tgenabled === 'A')).toBe(true)
    await expect(
      prisma.commercialCampaignActivation.count({
        where: { environment: 'PRODUCTION', campaignVersion: { schemaVersion: 3 } },
      }),
    ).resolves.toBe(0)

    await expectPostgresCode(
      prisma.$executeRaw`
        INSERT INTO "CommercialAcquisitionContext" (
          "id", "tokenHash", "campaignVersionId", "offerVersionId", "offerSchemaVersion",
          "channel", "attribution", "createdAt", "expiresAt"
        ) VALUES (
          'acquisition_v3_missing_catalog', ${'d'.repeat(64)}, NULL, ${ids.offer}, 3,
          'PAID_META', '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '7 days'
        )
      `,
      '23514',
    )
  })

  it('runs claim → pinned context → new account binding with exact replay under contention', async () => {
    const claimService = createPrismaCommercialOfferClaimV3Service(prisma)
    const contextService = createPrismaCommercialAcquisitionContextV3Service(prisma)
    const bindingService = createPrismaCommercialAcquisitionBindingV3Service(prisma)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000)
    const issuedClaim = await claimService.issue(
      {
        offerVersionId: ids.offer,
        channel: 'PAID_META',
        sourceRef: 'meta:integration:acquisition-v3',
        expiresAt,
        reason: 'Acquisition v3 integration claim',
        confirm: true,
      },
      { staffId: ids.publisher, permissions: ['commercial:publish'] },
    )
    const claimRow = await prisma.commercialCampaignClaim.findFirstOrThrow({
      where: { sourceRef: 'meta:integration:acquisition-v3' },
    })
    await expect(
      prisma.activityLog.count({ where: { action: 'COMMERCIAL_OFFER_CLAIM_ISSUED', entityId: claimRow.id } }),
    ).resolves.toBe(1)
    const runLegacyEndpoint = (claim: string) => {
      const harness = spawnSync(
        process.execPath,
        [
          '-r',
          'ts-node/register/transpile-only',
          '-r',
          'tsconfig-paths/register',
          path.join(repoRoot, 'tests/integration/commercial/commercial-quote-v3-v1v2-route-harness.ts'),
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, DATABASE_URL: targetUrl, Q3B_ROUTE_CLAIM: claim },
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      )
      if (harness.error || harness.status !== 0) {
        throw new Error(`Q3B_LEGACY_ROUTE_HARNESS_FAILED:${harness.status ?? 'NO_STATUS'}\n${harness.stdout}\n${harness.stderr}`)
      }
      const line = harness.stdout.trim().split('\n').at(-1)
      if (!line) throw new Error('Q3B_LEGACY_ROUTE_HARNESS_EMPTY')
      return JSON.parse(line) as { status: number; body: { code?: string }; before: number; after: number }
    }
    expect(runLegacyEndpoint(issuedClaim.claim)).toEqual({
      status: 404,
      body: { code: 'COMMERCIAL_CAMPAIGN_CLAIM_NOT_FOUND' },
      before: 0,
      after: 0,
    })

    const collisionClaim = 'A'.repeat(43)
    await prisma.commercialCampaignClaim.create({
      data: {
        id: 'acquisition_v3_legacy_hash_collision_claim',
        tokenHash: createHash('sha256').update(collisionClaim).digest('hex'),
        offerVersionId: ids.offer,
        offerSchemaVersion: 3,
        channel: 'PAID_META',
        sourceRef: 'meta:integration:legacy-hash-wall',
        issuedById: ids.publisher,
        reason: 'Prove null legacy lineage is an independent reader wall',
        expiresAt,
      },
    })
    expect(runLegacyEndpoint(collisionClaim)).toEqual({
      status: 404,
      body: { code: 'COMMERCIAL_CAMPAIGN_CLAIM_NOT_FOUND' },
      before: 0,
      after: 0,
    })
    const issuedContext = await contextService.issue({
      offerClaim: issuedClaim.claim,
      utmSource: 'facebook',
      utmCampaign: 'integration-v3',
    })
    const context = await prisma.commercialAcquisitionContext.findUniqueOrThrow({ where: { id: issuedContext.acquisitionContextId } })
    expect(context).toMatchObject({
      campaignVersionId: null,
      offerVersionId: ids.offer,
      offerSchemaVersion: 3,
      reservedCatalogPublicationId: ids.catalog,
      reservedCatalogSchemaVersion: 2,
      channel: 'PAID_META',
    })
    const contextBytes = Buffer.from(issuedContext.token, 'base64url')
    expect(context.tokenHash).toBe(
      createHash('sha256')
        .update(Buffer.concat([Buffer.from('avoqado.commercial.acquisition-context@3\0', 'ascii'), contextBytes]))
        .digest('hex'),
    )
    expect(context.tokenHash).not.toBe(createHash('sha256').update(issuedContext.token).digest('hex'))
    expect(context.expiresAt.getTime() - context.createdAt.getTime()).toBe(7 * 24 * 60 * 60 * 1_000)

    const previewService = createPrismaCommercialPublicQuotePreviewV3Service(prisma, previewSecrets)
    const preview = await previewService.preview({
      acquisitionToken: issuedContext.token,
      saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      hardwareSelections: [],
      rateBlockers: [],
    })
    expect(preview.quote).toMatchObject({
      subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: issuedContext.acquisitionContextId },
      acquisitionContextId: issuedContext.acquisitionContextId,
      derivedFromPreview: null,
      catalogPublicationId: ids.catalog,
      offerVersionId: ids.offer,
      totals: {
        dueNow: {
          listSubtotalMinor: '24900',
          discountMinor: '19900',
          subtotalMinor: '5000',
          taxMinor: '800',
          totalMinor: '5800',
        },
      },
      renewal: {
        subtotalMinor: '24900',
        taxMinor: '3984',
        totalMinor: '28884',
      },
    })
    expect(
      verifyCommercialQuotePreviewTokenV3(preview.previewToken, previewSecrets, new Date(preview.quote.quotedAt)),
    ).toMatchObject({
      previewQuoteId: preview.quote.quoteId,
      previewChecksum: preview.checksum,
      acquisitionContextId: issuedContext.acquisitionContextId,
      catalogPublicationId: ids.catalog,
      offerVersionId: ids.offer,
    })
    await expect(prisma.commercialQuote.count({ where: { acquisitionContextId: issuedContext.acquisitionContextId } })).resolves.toBe(0)

    const staffId = 'acquisition_v3_new_staff'
    const organizationId = 'acquisition_v3_new_org'
    const staff = await prisma.staff.create({
      data: {
        id: staffId,
        email: 'acquisition-v3-new-staff@example.test',
        firstName: 'New',
        lastName: 'Owner',
      },
    })
    expect(staff.commercialCreatedAt).not.toBeNull()
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Acquisition v3 new organization',
        email: 'acquisition-v3-new-org@example.test',
        phone: '+525500000001',
      },
    })
    await prisma.staffOrganization.create({
      data: {
        staffId,
        organizationId,
        role: 'OWNER',
        isActive: true,
        isPrimary: true,
      },
    })

    const bindInput = {
      acquisitionToken: issuedContext.token,
      staffId,
      organizationId,
      purpose: 'NEW_ACCOUNT' as const,
    }
    const [first, second] = await Promise.all([bindingService.bind(bindInput), bindingService.bind(bindInput)])
    expect([first.outcome, second.outcome].sort()).toEqual(['CREATED', 'REPLAYED'])
    await expect(
      prisma.commercialAcquisitionContextBinding.count({ where: { acquisitionContextId: issuedContext.acquisitionContextId } }),
    ).resolves.toBe(1)
    const binding = await prisma.commercialAcquisitionContextBinding.findUniqueOrThrow({
      where: { acquisitionContextId: issuedContext.acquisitionContextId },
    })
    await expect(
      prisma.activityLog.count({ where: { action: 'COMMERCIAL_ACQUISITION_CONTEXT_BOUND', entityId: binding.id } }),
    ).resolves.toBe(1)

    const venueId = 'acquisition_v3_new_venue'
    await prisma.venue.create({
      data: {
        id: venueId,
        organizationId,
        name: 'Acquisition v3 new venue',
        slug: `acquisition-v3-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      },
    })
    await prisma.staffVenue.create({
      data: { staffId, venueId, role: StaffRole.OWNER, active: true },
    })
    const bridgeService = createPrismaCommercialQuotePreviewBridgeV3Service(prisma, previewSecrets)
    const bridgeInput = {
      organizationId,
      venueId,
      actorId: staffId,
      acquisitionContextId: issuedContext.acquisitionContextId,
      previewToken: preview.previewToken,
      normalizedSaasLines: [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      normalizedHardwareSelections: [],
      rateBlockers: [],
    }
    const [firstBridge, secondBridge] = await Promise.all([
      bridgeService.bridge(bridgeInput),
      bridgeService.bridge(bridgeInput),
    ])
    expect([firstBridge.outcome, secondBridge.outcome].sort()).toEqual(['CREATED', 'REPLAYED'])
    expect(firstBridge.quote.snapshot.totals).toEqual(secondBridge.quote.snapshot.totals)
    expect(firstBridge.quote.snapshot.renewal).toEqual(secondBridge.quote.snapshot.renewal)
    expect(firstBridge.quote.snapshot).toMatchObject({
      subject: { kind: 'VENUE', organizationId, venueId, actorId: staffId },
      acquisitionContextId: issuedContext.acquisitionContextId,
      derivedFromPreview: {
        previewQuoteId: preview.quote.quoteId,
        previewChecksum: preview.checksum,
      },
      catalogPublicationId: ids.catalog,
      offerVersionId: ids.offer,
      totals: preview.quote.totals,
      renewal: preview.quote.renewal,
    })
    await expect(
      prisma.commercialQuote.count({ where: { acquisitionContextId: issuedContext.acquisitionContextId } }),
    ).resolves.toBe(1)
    const bridge = await prisma.commercialQuotePreviewBridge.findUniqueOrThrow({
      where: { previewQuoteId: preview.quote.quoteId },
    })
    await expectPostgresCode(
      prisma.$executeRaw`UPDATE "CommercialQuotePreviewBridge" SET "createdAt" = CURRENT_TIMESTAMP WHERE "id" = ${bridge.id}`,
      '55000',
    )
    await expectPostgresCode(
      prisma.$executeRaw`DELETE FROM "CommercialQuotePreviewBridge" WHERE "id" = ${bridge.id}`,
      '55000',
    )

    await expectPostgresCode(
      prisma.$executeRaw`UPDATE "CommercialAcquisitionContextBinding" SET "boundAt" = CURRENT_TIMESTAMP WHERE "id" = ${binding.id}`,
      '55000',
    )
    await expectPostgresCode(
      prisma.$executeRaw`DELETE FROM "CommercialAcquisitionContextBinding" WHERE "id" = ${binding.id}`,
      '55000',
    )

    const secondVenueId = 'acquisition_v3_second_venue'
    await prisma.venue.create({
      data: {
        id: secondVenueId,
        organizationId,
        name: 'Acquisition v3 second venue',
        slug: `acquisition-v3-second-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      },
    })
    await prisma.staffVenue.create({
      data: { staffId, venueId: secondVenueId, role: StaffRole.OWNER, active: true },
    })
    const secondPreview = await previewService.preview({
      acquisitionToken: issuedContext.token,
      saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      hardwareSelections: [],
      rateBlockers: [],
    })
    const otherVenueBridge = await bridgeService.bridge({
      ...bridgeInput,
      venueId: secondVenueId,
      previewToken: secondPreview.previewToken,
    })

    const acceptanceInputs = [
      {
        quoteId: firstBridge.quote.id,
        organizationId,
        venueId,
        acceptedById: staffId,
        idempotencyKey: 'acquisition-v3-acceptance-first-0001',
        correlationId: 'acquisition-v3-acceptance-first',
      },
      {
        quoteId: otherVenueBridge.quote.id,
        organizationId,
        venueId: secondVenueId,
        acceptedById: staffId,
        idempotencyKey: 'acquisition-v3-acceptance-second-0001',
        correlationId: 'acquisition-v3-acceptance-second',
      },
    ] as const
    const auditFailure = new Error('ACQUISITION_V3_ACCEPTANCE_AUDIT_FAILURE')
    const rollbackService = createCommercialQuoteV3AcceptanceService({
      runInTransaction: (operation, options) =>
        prisma.$transaction(
          tx =>
            operation({
              ...createPrismaCommercialQuoteV3AcceptanceTransaction(tx),
              writeAudit: async () => {
                throw auditFailure
              },
            }),
          options,
        ),
      randomId: randomUUID,
      sleep: async () => undefined,
      retryDelayMilliseconds: () => 0,
      recordPoisonedResolution: () => undefined,
    })
    await expect(rollbackService.accept(acceptanceInputs[0])).rejects.toBe(auditFailure)
    await expect(
      prisma.commercialQuoteAcceptance.count({
        where: { quote: { acquisitionContextId: issuedContext.acquisitionContextId } },
      }),
    ).resolves.toBe(0)
    await expect(
      prisma.commercialAcquisitionRedemption.count({
        where: { acquisitionContextId: issuedContext.acquisitionContextId },
      }),
    ).resolves.toBe(0)
    await expect(
      prisma.activityLog.count({ where: { action: 'COMMERCIAL_QUOTE_ACCEPTED' } }),
    ).resolves.toBe(0)

    const acceptanceService = createPrismaCommercialQuoteV3AcceptanceService(prisma)
    const raced = await Promise.allSettled(acceptanceInputs.map(candidate => acceptanceService.accept(candidate)))
    const winner = raced.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acceptanceService.accept>>> =>
      result.status === 'fulfilled',
    )
    const loser = raced.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(winner).toBeDefined()
    expect(loser).toBeDefined()
    expect(applicationCode(loser?.reason)).toBe('COMMERCIAL_ACQUISITION_ALREADY_REDEEMED')
    expect((loser?.reason as { details?: unknown }).details).toEqual({ retryable: false })
    const winningInput = acceptanceInputs.find(candidate => candidate.quoteId === winner?.value.quoteId)
    expect(winningInput).toBeDefined()
    await expect(acceptanceService.accept(winningInput!)).resolves.toEqual(winner?.value)

    await expect(
      acceptanceService.accept({
        ...winningInput!,
        acceptedById: ids.publisher,
        idempotencyKey: 'acquisition-v3-foreign-actor-0001',
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_BINDING_MISMATCH' })
    await expect(
      acceptanceService.accept({
        ...winningInput!,
        organizationId: 'acquisition_v3_unbound_org',
        venueId: 'acquisition_v3_unbound_venue',
        idempotencyKey: 'acquisition-v3-unbound-tenant-0001',
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_V3_NOT_FOUND' })

    await expect(
      prisma.commercialQuoteAcceptance.count({
        where: { quote: { acquisitionContextId: issuedContext.acquisitionContextId } },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.commercialAcquisitionRedemption.count({
        where: { acquisitionContextId: issuedContext.acquisitionContextId },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.activityLog.count({
        where: { action: 'COMMERCIAL_QUOTE_ACCEPTED', entityId: winner?.value.id },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.activityLog.count({
        where: {
          action: 'COMMERCIAL_QUOTE_CREATED',
          entityId: { in: [firstBridge.quote.id, otherVenueBridge.quote.id] },
        },
      }),
    ).resolves.toBe(2)
    const redemption = await prisma.commercialAcquisitionRedemption.findUniqueOrThrow({
      where: { acquisitionContextId: issuedContext.acquisitionContextId },
    })
    await expectPostgresCode(
      prisma.$executeRaw`
        UPDATE "CommercialAcquisitionRedemption"
        SET "redeemedAt" = "redeemedAt" + interval '1 millisecond'
        WHERE "id" = ${redemption.id}
      `,
      '55000',
    )
    await expectPostgresCode(
      prisma.$executeRaw`DELETE FROM "CommercialAcquisitionRedemption" WHERE "id" = ${redemption.id}`,
      '55000',
    )
    const redemptionIndexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = ANY(${[
          'CommercialAcquisitionRedemption_acquisitionContextId_key',
          'CommercialAcquisitionRedemption_quoteId_key',
          'CommercialAcquisitionRedemption_acceptanceId_key',
          'CommercialAcqRedemption_org_venue_redeemed_idx',
        ]}::text[])
      ORDER BY indexname
    `
    expect(redemptionIndexes.map(item => item.indexname)).toEqual([
      'CommercialAcqRedemption_org_venue_redeemed_idx',
      'CommercialAcquisitionRedemption_acceptanceId_key',
      'CommercialAcquisitionRedemption_acquisitionContextId_key',
      'CommercialAcquisitionRedemption_quoteId_key',
    ])
    const q3bPreflight = await prisma.$transaction(async tx => ({
      allowed: await countAllowedCommercialOfferV3Q3BReferences(tx),
      prohibited: await countProhibitedCommercialOfferV3Q3BReferences(tx),
    }))
    expect(q3bPreflight.allowed).toEqual({
      offerControlEvents: 0,
      dedicatedClaims: 2,
      pinnedAcquisitionContexts: 1,
      acquisitionBindings: 1,
      directQuotes: 0,
      bridgedQuotes: 2,
      previewBridges: 2,
      quoteAcceptances: 1,
      acquisitionRedemptions: 1,
    })
    expect(q3bPreflight.prohibited).toEqual({
      campaignActivations: 0,
      legacyCampaignClaims: 0,
      legacyAcquisitionContexts: 0,
      legacyCampaignLinkedQuotes: 0,
      invalidOfferQuoteShapes: 0,
      stripeOperations: 0,
      subscriptionEvents: 0,
      entitlementEffects: 0,
      hardwareOrderEffects: 0,
    })
  })

  it('keeps legacy Staff rows ineligible instead of inventing a creation timestamp', async () => {
    const claimService = createPrismaCommercialOfferClaimV3Service(prisma)
    const contextService = createPrismaCommercialAcquisitionContextV3Service(prisma)
    const bindingService = createPrismaCommercialAcquisitionBindingV3Service(prisma)
    const issuedClaim = await claimService.issue(
      {
        offerVersionId: ids.offer,
        channel: 'DISTRIBUTOR',
        sourceRef: 'distributor:integration:legacy-staff',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        reason: 'Acquisition v3 legacy identity proof',
        confirm: true,
      },
      { staffId: ids.publisher, permissions: ['commercial:publish'] },
    )
    const issuedContext = await contextService.issue({ offerClaim: issuedClaim.claim })
    const staffId = 'acquisition_v3_legacy_staff'
    const organizationId = 'acquisition_v3_legacy_org'
    await prisma.staff.create({
      data: {
        id: staffId,
        email: 'acquisition-v3-legacy-staff@example.test',
        firstName: 'Legacy',
        lastName: 'Identity',
        commercialCreatedAt: null,
      },
    })
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Acquisition v3 legacy organization',
        email: 'acquisition-v3-legacy-org@example.test',
        phone: '+525500000002',
      },
    })
    await prisma.staffOrganization.create({
      data: { staffId, organizationId, role: 'OWNER', isActive: true, isPrimary: true },
    })

    await expect(
      bindingService.bind({ acquisitionToken: issuedContext.token, staffId, organizationId, purpose: 'NEW_ACCOUNT' }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_NEW_ACCOUNT_INELIGIBLE' })
    await expect(prisma.commercialAcquisitionContextBinding.count({ where: { staffId } })).resolves.toBe(0)
  })

  it('cascades binding-only cleanup after grace and preserves redemption before issuing DELETE', async () => {
    const cleanupRepository = createPrismaCommercialAcquisitionContextCleanupRepository(prisma)
    const clockRows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT pg_catalog.now() AS "now"`
    const now = clockRows[0].now
    const bindingContextId = 'acquisition_v3_cleanup_binding_only'
    const graceContextId = 'acquisition_v3_cleanup_binding_grace'
    const redemptionContextId = 'acquisition_v3_cleanup_redemption_only'
    const contextData = (id: string, expiresAt: Date) => ({
      id,
      tokenHash: Buffer.from(id).toString('hex').padEnd(64, '0').slice(0, 64),
      campaignVersionId: null,
      offerVersionId: ids.offer,
      offerSchemaVersion: 3,
      reservedCatalogPublicationId: ids.catalog,
      reservedCatalogSchemaVersion: 2,
      channel: 'DIRECT' as const,
      attribution: {},
      createdAt: new Date(now.getTime() - 60 * 60_000),
      expiresAt,
    })
    await prisma.commercialAcquisitionContext.createMany({
      data: [
        contextData(bindingContextId, new Date(now.getTime() - 30 * 60_000)),
        contextData(graceContextId, new Date(now.getTime() - 19 * 60_000)),
        contextData(redemptionContextId, new Date(now.getTime() - 30 * 60_000)),
      ],
    })

    const createBindingIdentity = async (key: 'binding' | 'grace') => {
      const staff = await prisma.staff.create({
        data: {
          id: `acquisition_v3_cleanup_${key}_staff`,
          email: `acquisition-v3-cleanup-${key}@example.test`,
          firstName: 'Cleanup',
          lastName: key,
        },
      })
      const organization = await prisma.organization.create({
        data: {
          id: `acquisition_v3_cleanup_${key}_org`,
          name: `Acquisition v3 cleanup ${key}`,
          email: `acquisition-v3-cleanup-${key}-org@example.test`,
          phone: key === 'binding' ? '+525500000011' : '+525500000012',
        },
      })
      return { staff, organization }
    }
    const bindingIdentity = await createBindingIdentity('binding')
    const graceIdentity = await createBindingIdentity('grace')
    await prisma.commercialAcquisitionContextBinding.createMany({
      data: [
        {
          acquisitionContextId: bindingContextId,
          staffId: bindingIdentity.staff.id,
          organizationId: bindingIdentity.organization.id,
          purpose: 'NEW_ACCOUNT',
          staffCreatedAt: bindingIdentity.staff.commercialCreatedAt!,
          organizationCreatedAt: bindingIdentity.organization.createdAt,
        },
        {
          acquisitionContextId: graceContextId,
          staffId: graceIdentity.staff.id,
          organizationId: graceIdentity.organization.id,
          purpose: 'NEW_ACCOUNT',
          staffCreatedAt: graceIdentity.staff.commercialCreatedAt!,
          organizationCreatedAt: graceIdentity.organization.createdAt,
        },
      ],
    })
    await expectPostgresCode(
      prisma.$executeRaw`DELETE FROM "CommercialAcquisitionContextBinding" WHERE "acquisitionContextId" = ${graceContextId}`,
      '55000',
    )

    const redemptionStaffId = 'acquisition_v3_cleanup_redemption_staff'
    const redemptionOrganizationId = 'acquisition_v3_cleanup_redemption_org'
    const redemptionVenueId = 'acquisition_v3_cleanup_redemption_venue'
    await prisma.staff.create({
      data: {
        id: redemptionStaffId,
        email: 'acquisition-v3-cleanup-redemption@example.test',
        firstName: 'Cleanup',
        lastName: 'Redemption',
      },
    })
    await prisma.organization.create({
      data: {
        id: redemptionOrganizationId,
        name: 'Acquisition v3 cleanup redemption',
        email: 'acquisition-v3-cleanup-redemption-org@example.test',
        phone: '+525500000013',
      },
    })
    await prisma.venue.create({
      data: {
        id: redemptionVenueId,
        organizationId: redemptionOrganizationId,
        name: 'Acquisition v3 cleanup redemption venue',
        slug: 'acquisition-v3-cleanup-redemption-venue',
      },
    })
    await prisma.staffVenue.create({
      data: { staffId: redemptionStaffId, venueId: redemptionVenueId, role: StaffRole.OWNER, active: true },
    })
    const directQuote = await createPrismaCommercialDirectQuoteV3Service(prisma).create({
      organizationId: redemptionOrganizationId,
      venueId: redemptionVenueId,
      actorId: redemptionStaffId,
      offerVersionId: ids.offer,
      saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      hardwareSelections: [],
      rateBlockers: [],
      correlationId: 'acquisition-v3-cleanup-redemption',
    })
    const acceptanceId = 'acquisition_v3_cleanup_redemption_acceptance'
    await prisma.commercialQuoteAcceptance.create({
      data: {
        id: acceptanceId,
        quoteId: directQuote.id,
        idempotencyKey: 'acquisition-v3-cleanup-redemption-acceptance-0001',
        organizationId: redemptionOrganizationId,
        venueId: redemptionVenueId,
        acceptedById: redemptionStaffId,
      },
    })
    await prisma.commercialAcquisitionRedemption.create({
      data: {
        id: 'acquisition_v3_cleanup_redemption',
        acquisitionContextId: redemptionContextId,
        quoteId: directQuote.id,
        acceptanceId,
        organizationId: redemptionOrganizationId,
        venueId: redemptionVenueId,
        staffId: redemptionStaffId,
      },
    })

    const databaseCutoff = await cleanupRepository.getDatabaseCutoff()
    await expect(
      cleanupRepository.deleteCandidate({ id: redemptionContextId, databaseCutoff }),
    ).resolves.toEqual({ deleted: false, preservedReferenced: true })
    await expectPostgresCode(
      prisma.$executeRaw`DELETE FROM "CommercialAcquisitionContext" WHERE "id" = ${redemptionContextId}`,
      '23503',
    )

    const cleanup = createCommercialAcquisitionContextCleanupService({
      repository: {
        getDatabaseCutoff: cleanupRepository.getDatabaseCutoff,
        listCandidates: jest.fn().mockResolvedValueOnce([{ id: bindingContextId }]),
        deleteCandidate: cleanupRepository.deleteCandidate,
      },
      monotonicNow: () => 0,
    })
    await expect(
      cleanup({ execute: true, pageSize: 10, maxScanned: 10, maxRuntimeMs: 5_000 }),
    ).resolves.toMatchObject({
      scanned: 1,
      deleted: 1,
      preservedReferenced: 0,
      preservedDatabaseRejected: 0,
    })
    await expect(
      prisma.commercialAcquisitionContextBinding.count({ where: { acquisitionContextId: bindingContextId } }),
    ).resolves.toBe(0)
  })
})
