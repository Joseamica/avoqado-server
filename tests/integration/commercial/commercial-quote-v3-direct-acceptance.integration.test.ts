import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { Prisma, PrismaClient, StaffRole } from '@prisma/client'
import { Client } from 'pg'

import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import directFixture from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-direct.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import {
  decodeAndVerifyStoredCommercialCatalogV2,
  emitCommercialArtifactV2,
} from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { canonicalJsonBytesV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import {
  createCommercialQuoteAcceptanceService,
  type CommercialQuoteAcceptanceTransaction,
} from '@/services/commercial/commercialQuoteAcceptance.service'
import { assertCommercialV2CheckoutActive } from '@/services/commercial/commercialV2CheckoutPolicy.service'
import { decodeAndVerifyStoredCommercialOfferV3, emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  countAllowedCommercialOfferV3Q3AReferences,
  countProhibitedCommercialOfferV3Q3AReferences,
} from '@/services/commercial/offers/commercialOfferReleasePreflight.service'
import {
  COMMERCIAL_OFFER_CONTROL_V3_TRANSACTION_OPTIONS,
  createCommercialOfferControlV3Service,
  createPrismaCommercialOfferControlTransactionV3,
  createPrismaCommercialOfferControlV3Service,
  resolveCommercialOfferControlStateV3,
} from '@/services/commercial/quotes-v3/commercialOfferControlV3.service'
import { createCommercialStoredQuoteV3Service } from '@/services/commercial/quotes-v3/commercialStoredQuoteV3.service'
import { buildCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Builder.service'
import {
  decodeAndVerifyStoredCommercialQuoteV3,
  emitCommercialQuoteV3,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Contract.service'
import { evaluateCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Engine.service'
import {
  persistCommercialQuoteV3,
  type CommercialQuoteV3PersistenceTransaction,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Persistence.service'
import {
  createCommercialDirectQuoteV3Service,
  createPrismaCommercialDirectQuoteV3Service,
  createPrismaCommercialDirectQuoteV3Transaction,
} from '@/services/commercial/quotes-v3/commercialDirectQuoteV3.service'
import {
  createCommercialQuoteV3AcceptanceService,
  createPrismaCommercialQuoteV3AcceptanceService,
  createPrismaCommercialQuoteV3AcceptanceTransaction,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Acceptance.service'
import type { CommercialCampaignRuleV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'
import type {
  CommercialQuoteSnapshotV3,
  CommercialQuoteV3Authorities,
  CommercialQuoteV3DecodeInput,
  EmittedCommercialQuoteV3,
} from '@/types/commercialQuoteV3'

jest.setTimeout(120_000)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function maintenanceDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL
  if (!raw?.trim()) throw new Error('COMMERCIAL_DIRECT_ACCEPTANCE_TEST_DATABASE_URL_REQUIRED')
  const parsed = new URL(raw)
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !/test/i.test(parsed.pathname)) {
    throw new Error('COMMERCIAL_DIRECT_ACCEPTANCE_DISPOSABLE_DATABASE_REQUIRED')
  }
  parsed.searchParams.set('application_name', `commercial-direct-acceptance-${process.pid}`)
  return parsed.toString()
}

function quoteIdentifier(value: string): string {
  if (!/^avoqado_direct_acceptance_[a-z0-9_]+$/.test(value)) {
    throw new Error('COMMERCIAL_DIRECT_ACCEPTANCE_DATABASE_NAME_REJECTED')
  }
  return `"${value}"`
}

function databaseUrl(maintenanceUrl: string, databaseName: string): string {
  const parsed = new URL(maintenanceUrl)
  parsed.pathname = `/${databaseName}`
  return parsed.toString()
}

function stackedOfferSource(offerVersionId: string, offerCode: string): CommercialOfferSnapshotV3 {
  const source = clone(offerFixture) as CommercialOfferSnapshotV3
  const claimStartsAt = '2020-01-01T00:00:00.000Z'
  const claimEndsAt = '2099-12-31T23:59:59.999Z'
  source.campaignVersionId = offerVersionId
  source.campaignCode = offerCode
  source.claimStartsAt = claimStartsAt
  source.claimEndsAt = claimEndsAt
  for (const benefit of source.benefits) {
    if (benefit.kind === 'HARDWARE_FIXED_PRICE' || benefit.kind === 'HARDWARE_PERCENT_OFF') {
      benefit.benefitStartsAt = claimStartsAt
      benefit.benefitEndsAt = claimEndsAt
    }
  }
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

function replaceString(value: unknown, from: string, to: string): unknown {
  return JSON.parse(JSON.stringify(value).split(from).join(to)) as unknown
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(resolver => {
    resolve = resolver
  })
  return { promise, resolve }
}

function percentile(samples: readonly number[], percentage: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)]
}

type PerformanceMetrics = Readonly<{ p99: number; max: number }>
type PerformanceVerdict = 'PASS' | 'INCONCLUSIVE' | 'FAIL'

function performanceVerdict(
  replay: PerformanceMetrics,
  transaction: PerformanceMetrics,
  thresholds: Readonly<{
    replayP99: number
    replayAbsolute: number
    transactionP99: number
    transactionAbsolute: number
  }>,
): PerformanceVerdict {
  if (
    replay.p99 > thresholds.replayP99 ||
    replay.max > thresholds.replayAbsolute ||
    transaction.p99 > thresholds.transactionP99 ||
    transaction.max > thresholds.transactionAbsolute
  ) {
    return 'FAIL'
  }
  if (replay.max > thresholds.replayP99 || transaction.max > thresholds.transactionP99) {
    return 'INCONCLUSIVE'
  }
  return 'PASS'
}

async function within<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('COMMERCIAL_DIRECT_ACCEPTANCE_CONCURRENCY_TIMEOUT')), milliseconds)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

describe('Commercial Quote v3 direct-acceptance laboratory', () => {
  const repoRoot = path.resolve(__dirname, '../../..')
  let admin: Client
  let prisma: PrismaClient
  let databaseName: string
  let targetUrl: string

  beforeAll(async () => {
    const maintenanceUrl = maintenanceDatabaseUrl()
    databaseName = `avoqado_direct_acceptance_${process.pid}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
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
        `COMMERCIAL_DIRECT_ACCEPTANCE_MIGRATION_FAILED:${migration.status ?? 'NO_STATUS'}:${migration.error?.message ?? ''}\n${migration.stdout}\n${migration.stderr}`,
      )
    }
    prisma = new PrismaClient({ datasources: { db: { url: targetUrl } } })
  })

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined)
    if (admin && databaseName) {
      await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => undefined)
    }
    await admin?.end().catch(() => undefined)
  })

  it('replays a real stored Quote and rejects a poisoned boundary copy before decoder evaluation', async () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 16)
    const ids = {
      staff: `direct_acceptance_staff_${suffix}`,
      organization: `direct_acceptance_org_${suffix}`,
      alternateOrganization: `direct_acceptance_alt_org_${suffix}`,
      venue: `direct_acceptance_venue_${suffix}`,
      catalogDraft: `direct_acceptance_catalog_draft_${suffix}`,
      catalog: `direct_acceptance_catalog_${suffix}`,
      offerDraft: `direct_acceptance_offer_draft_${suffix}`,
      offer: `direct_acceptance_offer_${suffix}`,
      quote: `direct_acceptance_quote_${suffix}`,
    }
    const offerCode = `DA_${suffix.toUpperCase()}`
    const expectedRollback = new Error('COMMERCIAL_DIRECT_ACCEPTANCE_EXPECTED_ROLLBACK')

    await expect(
      prisma.$transaction(
        async tx => {
          await tx.staff.create({
            data: {
              id: ids.staff,
              email: `${ids.staff}@example.test`,
              firstName: 'Direct',
              lastName: 'Acceptance',
            },
          })
          await tx.organization.create({
            data: {
              id: ids.organization,
              name: 'Direct acceptance disposable organization',
              email: `${ids.organization}@example.test`,
              phone: '+525500000000',
            },
          })
          await tx.organization.create({
            data: {
              id: ids.alternateOrganization,
              name: 'Direct acceptance alternate disposable organization',
              email: `${ids.alternateOrganization}@example.test`,
              phone: '+525500000001',
            },
          })
          await tx.venue.create({
            data: {
              id: ids.venue,
              organizationId: ids.organization,
              name: 'Direct acceptance disposable venue',
              slug: `direct-acceptance-${suffix}`,
            },
          })

          const catalogSource = clone(catalogFixture) as CommercialCatalogSnapshotV2
          catalogSource.publicationId = ids.catalog
          const catalog = emitCommercialArtifactV2({
            kind: 'CATALOG',
            schemaVersion: 2,
            domainValue: catalogSource,
          })
          await tx.commercialDraft.create({
            data: {
              id: ids.catalogDraft,
              sourceKey: ids.catalogDraft,
              name: 'Direct acceptance disposable catalog',
              revision: 1,
              createdById: ids.staff,
              updatedById: ids.staff,
            },
          })
          await tx.commercialPublication.create({
            data: {
              id: ids.catalog,
              sourceDraftId: ids.catalogDraft,
              sourceRevision: 1,
              schemaVersion: 2,
              snapshot: catalog.snapshot as unknown as Prisma.InputJsonValue,
              checksum: catalog.checksum,
              reason: 'Direct acceptance disposable proof',
              publishedById: ids.staff,
              publishedAt: new Date(catalog.snapshot.publishedAt),
            },
          })

          const emittedOffer = emitCommercialOfferV3(stackedOfferSource(ids.offer, offerCode))
          const offer: CommercialQuoteV3Authorities['offer'] = {
            rowSchemaVersion: 3,
            snapshot: emittedOffer.snapshot,
            checksum: emittedOffer.checksum,
            rowContext: {
              id: ids.offer,
              campaignCode: offerCode,
              sourceRevision: emittedOffer.snapshot.version,
              schemaVersion: 3,
              publishedAt: new Date(emittedOffer.snapshot.publishedAt),
            },
          }
          decodeAndVerifyStoredCommercialOfferV3(offer)
          await tx.commercialCampaignDraft.create({
            data: {
              id: ids.offerDraft,
              code: offerCode,
              name: 'Direct acceptance disposable offer',
              revision: 1,
              offerSchemaVersion: 3,
              allowedRuleCodeGroups: Prisma.DbNull,
              stackingGroups: [],
              startsAt: new Date(emittedOffer.snapshot.claimStartsAt),
              endsAt: new Date(emittedOffer.snapshot.claimEndsAt),
              createdById: ids.staff,
              updatedById: ids.staff,
            },
          })
          await tx.commercialCampaignVersion.create({
            data: {
              id: ids.offer,
              campaignCode: offerCode,
              sourceDraftId: ids.offerDraft,
              sourceRevision: 1,
              schemaVersion: 3,
              snapshot: emittedOffer.snapshot as unknown as Prisma.InputJsonValue,
              checksum: emittedOffer.checksum,
              reason: 'Direct acceptance disposable proof',
              publishedById: ids.staff,
              publishedAt: new Date(emittedOffer.snapshot.publishedAt),
            },
          })

          let quoteSource = clone(directFixture) as CommercialQuoteSnapshotV3
          quoteSource = replaceString(quoteSource, directFixture.quoteId, ids.quote) as CommercialQuoteSnapshotV3
          quoteSource = replaceString(quoteSource, directFixture.catalogPublicationId, ids.catalog) as CommercialQuoteSnapshotV3
          quoteSource = replaceString(quoteSource, directFixture.offerVersionId, ids.offer) as CommercialQuoteSnapshotV3
          quoteSource = replaceString(quoteSource, directFixture.offerCode, offerCode) as CommercialQuoteSnapshotV3
          quoteSource.subject = {
            kind: 'VENUE',
            organizationId: ids.organization,
            venueId: ids.venue,
            actorId: ids.staff,
          }
          quoteSource.catalogChecksum = catalog.checksum
          quoteSource.offerCode = offerCode
          quoteSource.offerChecksum = emittedOffer.checksum
          const emittedQuote = emitCommercialQuoteV3(quoteSource, {
            catalog,
            offer,
            acquisitionContext: null,
          })
          const originalTimezone = process.env.TZ
          let utcEmission: EmittedCommercialQuoteV3
          let mexicoEmission: EmittedCommercialQuoteV3
          try {
            process.env.TZ = 'UTC'
            utcEmission = emitCommercialQuoteV3(clone(quoteSource), { catalog, offer, acquisitionContext: null })
            process.env.TZ = 'America/Mexico_City'
            mexicoEmission = emitCommercialQuoteV3(clone(quoteSource), { catalog, offer, acquisitionContext: null })
          } finally {
            if (originalTimezone === undefined) delete process.env.TZ
            else process.env.TZ = originalTimezone
          }
          expect(mexicoEmission.checksum).toBe(utcEmission.checksum)
          expect(canonicalJsonBytesV2(mexicoEmission.snapshot)).toEqual(canonicalJsonBytesV2(utcEmission.snapshot))
          const dueNow = emittedQuote.snapshot.totals.dueNow
          const renewal = emittedQuote.snapshot.renewal
          const validData: Prisma.CommercialQuoteUncheckedCreateInput = {
            id: ids.quote,
            catalogPublicationId: ids.catalog,
            campaignVersionId: null,
            offerVersionId: ids.offer,
            offerSchemaVersion: 3,
            acquisitionContextId: null,
            organizationId: ids.organization,
            venueId: ids.venue,
            createdById: ids.staff,
            schemaVersion: 3,
            market: 'MX',
            currency: 'MXN',
            snapshot: emittedQuote.snapshot as unknown as Prisma.InputJsonValue,
            checksum: emittedQuote.checksum,
            listSubtotalMinor: BigInt(dueNow.listSubtotalMinor),
            discountMinor: BigInt(dueNow.discountMinor),
            subtotalMinor: BigInt(dueNow.subtotalMinor),
            taxMinor: BigInt(dueNow.taxMinor),
            totalMinor: BigInt(dueNow.totalMinor),
            renewalSubtotalMinor: BigInt(renewal.subtotalMinor),
            renewalTaxMinor: BigInt(renewal.taxMinor),
            renewalTotalMinor: BigInt(renewal.totalMinor),
            quotedAt: new Date(emittedQuote.snapshot.quotedAt),
            expiresAt: new Date(emittedQuote.snapshot.expiresAt),
          }
          const assertNoPersistence = async () => {
            await expect(tx.commercialQuote.count({ where: { id: ids.quote } })).resolves.toBe(0)
            await expect(tx.activityLog.count({ where: { entity: 'CommercialQuote', entityId: ids.quote } })).resolves.toBe(0)
          }
          const expectSqlRejected = async (savepoint: string, data: Prisma.CommercialQuoteUncheckedCreateInput) => {
            await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`)
            let rejected = false
            try {
              await tx.commercialQuote.create({ data })
            } catch {
              rejected = true
              await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`)
            }
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`)
            expect(rejected).toBe(true)
            await assertNoPersistence()
          }

          const wrongCatalogSnapshot = clone(emittedQuote.snapshot)
          wrongCatalogSnapshot.catalogChecksum = '0'.repeat(64)
          await expectSqlRejected('quote_v3_wrong_catalog', {
            ...validData,
            snapshot: wrongCatalogSnapshot as unknown as Prisma.InputJsonValue,
          })
          const wrongOfferSnapshot = clone(emittedQuote.snapshot)
          wrongOfferSnapshot.offerChecksum = '0'.repeat(64)
          await expectSqlRejected('quote_v3_wrong_offer', {
            ...validData,
            snapshot: wrongOfferSnapshot as unknown as Prisma.InputJsonValue,
          })
          await expectSqlRejected('quote_v3_wrong_aggregate', {
            ...validData,
            totalMinor: BigInt(dueNow.totalMinor) + 1n,
          })
          const wrongTenantSnapshot = clone(emittedQuote.snapshot)
          if (wrongTenantSnapshot.subject.kind !== 'VENUE') throw new Error('COMMERCIAL_DIRECT_ACCEPTANCE_VENUE_REQUIRED')
          wrongTenantSnapshot.subject.organizationId = ids.alternateOrganization
          await expectSqlRejected('quote_v3_wrong_tenant', {
            ...validData,
            organizationId: ids.alternateOrganization,
            snapshot: wrongTenantSnapshot as unknown as Prisma.InputJsonValue,
          })

          const persistenceTx: CommercialQuoteV3PersistenceTransaction = {
            loadAuthorities: async input =>
              input.catalogPublicationId === ids.catalog &&
              input.offerVersionId === ids.offer &&
              input.organizationId === ids.organization &&
              input.venueId === ids.venue
                ? { catalog, offer, acquisitionContext: null }
                : null,
            commercialQuote: { create: input => tx.commercialQuote.create(input) },
            activityLog: { create: input => tx.activityLog.create(input) },
          }
          await expect(persistCommercialQuoteV3({ ...emittedQuote, checksum: '0'.repeat(64) }, persistenceTx)).rejects.toMatchObject({
            code: 'COMMERCIAL_QUOTE_V3_CHECKSUM_MISMATCH',
          })
          await assertNoPersistence()

          await expect(persistCommercialQuoteV3(emittedQuote, persistenceTx)).resolves.toEqual({
            id: ids.quote,
            snapshot: emittedQuote.snapshot,
            checksum: emittedQuote.checksum,
          })
          await expect(tx.activityLog.count({ where: { action: 'COMMERCIAL_QUOTE_CREATED', entityId: ids.quote } })).resolves.toBe(1)
          const persistedTimestampRow = await tx.commercialQuote.findUniqueOrThrow({ where: { id: ids.quote } })
          expect(persistedTimestampRow.quotedAt.toISOString()).toBe(emittedQuote.snapshot.quotedAt)
          expect(persistedTimestampRow.expiresAt.toISOString()).toBe(emittedQuote.snapshot.expiresAt)
          expect(persistedTimestampRow.expiresAt.getTime() - persistedTimestampRow.quotedAt.getTime()).toBe(900_000)

          const loadRealRow = async (): Promise<CommercialQuoteV3DecodeInput | null> => {
            const row = await tx.commercialQuote.findFirst({
              where: {
                id: ids.quote,
                organizationId: ids.organization,
                venueId: ids.venue,
                venue: { organizationId: ids.organization },
              },
              include: { catalogPublication: true, offerVersion: true, venue: true },
            })
            if (!row?.offerVersion || !row.venue) return null
            const catalogAuthority = decodeAndVerifyStoredCommercialCatalogV2({
              kind: 'CATALOG',
              rowSchemaVersion: row.catalogPublication.schemaVersion,
              snapshot: row.catalogPublication.snapshot,
              checksum: row.catalogPublication.checksum,
              rowContext: {
                kind: 'CATALOG',
                id: row.catalogPublication.id,
                schemaVersion: row.catalogPublication.schemaVersion,
                publishedAt: row.catalogPublication.publishedAt,
              },
            })
            const offerAuthority: CommercialQuoteV3Authorities['offer'] = {
              rowSchemaVersion: row.offerVersion.schemaVersion,
              snapshot: row.offerVersion.snapshot as unknown as CommercialOfferSnapshotV3,
              checksum: row.offerVersion.checksum,
              rowContext: {
                id: row.offerVersion.id,
                campaignCode: row.offerVersion.campaignCode,
                sourceRevision: row.offerVersion.sourceRevision,
                schemaVersion: row.offerVersion.schemaVersion,
                publishedAt: row.offerVersion.publishedAt,
              },
            }
            decodeAndVerifyStoredCommercialOfferV3(offerAuthority)
            return {
              rowSchemaVersion: row.schemaVersion,
              snapshot: row.snapshot,
              checksum: row.checksum,
              rowContext: {
                id: row.id,
                schemaVersion: row.schemaVersion,
                catalogPublicationId: row.catalogPublicationId,
                offerVersionId: row.offerVersionId ?? '',
                acquisitionContextId: row.acquisitionContextId,
                organizationId: row.organizationId,
                venueId: row.venueId,
                createdById: row.createdById,
                venueOrganizationId: row.venue.organizationId,
                market: row.market,
                currency: row.currency,
                quotedAt: row.quotedAt,
                expiresAt: row.expiresAt,
                listSubtotalMinor: row.listSubtotalMinor,
                discountMinor: row.discountMinor,
                subtotalMinor: row.subtotalMinor,
                taxMinor: row.taxMinor,
                totalMinor: row.totalMinor,
                renewalSubtotalMinor: row.renewalSubtotalMinor,
                renewalTaxMinor: row.renewalTaxMinor,
                renewalTotalMinor: row.renewalTotalMinor,
              },
              authorities: {
                catalog: catalogAuthority,
                offer: offerAuthority,
                acquisitionContext: null,
              },
            }
          }

          const input = {
            quoteId: ids.quote,
            organizationId: ids.organization,
            venueId: ids.venue,
            correlationId: `direct-acceptance-${suffix}`,
          }
          const alerts: unknown[] = []
          const storedService = createCommercialStoredQuoteV3Service({
            loadRowAndAuthorities: loadRealRow,
            recordPoisonedResolution: alert => alerts.push(alert),
          })
          const decoderInput = await loadRealRow()
          if (!decoderInput) throw new Error('COMMERCIAL_DIRECT_ACCEPTANCE_REAL_ROW_MISSING')
          expect(() => decodeAndVerifyStoredCommercialQuoteV3(decoderInput)).not.toThrow()
          await expect(storedService.loadVerified(input)).resolves.toMatchObject({
            snapshot: { quoteId: ids.quote },
            verified: true,
          })

          const realBoundaryValue = await loadRealRow()
          if (!realBoundaryValue) throw new Error('COMMERCIAL_DIRECT_ACCEPTANCE_REAL_ROW_MISSING')
          const poisonedSnapshot = clone(realBoundaryValue.snapshot) as CommercialQuoteSnapshotV3
          let decoderReached = false
          Object.defineProperty(poisonedSnapshot, 'schemaVersion', {
            enumerable: true,
            get: () => {
              decoderReached = true
              throw new Error('COMMERCIAL_DIRECT_ACCEPTANCE_DECODER_MUST_NOT_RUN')
            },
          })
          poisonedSnapshot.resolution.resolutionVersion = 3 as 2
          const poisonedService = createCommercialStoredQuoteV3Service({
            loadRowAndAuthorities: async () => ({
              ...realBoundaryValue,
              snapshot: poisonedSnapshot,
            }),
            recordPoisonedResolution: alert => alerts.push(alert),
          })
          await expect(poisonedService.loadVerified(input)).rejects.toMatchObject({
            statusCode: 409,
            code: 'COMMERCIAL_OFFER_RESOLUTION_VERSION_UNSUPPORTED',
          })
          expect(decoderReached).toBe(false)
          expect(alerts).toEqual([
            {
              quoteId: ids.quote,
              correlationId: input.correlationId,
              code: 'COMMERCIAL_OFFER_RESOLUTION_VERSION_POISONED_ROW',
            },
          ])

          throw expectedRollback
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBe(expectedRollback)

    await expect(prisma.commercialQuote.count({ where: { id: ids.quote } })).resolves.toBe(0)
    await expect(prisma.activityLog.count({ where: { entity: 'CommercialQuote', entityId: ids.quote } })).resolves.toBe(0)
  })

  it('serializes immutable Offer control, preserves global audit shape and fails closed after bounded lock retries', async () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 16)
    const staffId = `offer_control_staff_${suffix}`
    const offerDraftId = `offer_control_draft_${suffix}`
    const offerVersionId = `offer_control_offer_${suffix}`
    const offerCode = `OC_${suffix.toUpperCase()}`
    await prisma.staff.create({
      data: {
        id: staffId,
        email: `${staffId}@example.test`,
        firstName: 'Offer',
        lastName: 'Control',
      },
    })
    await prisma.commercialCampaignDraft.create({
      data: {
        id: offerDraftId,
        code: offerCode,
        name: 'Offer control disposable draft',
        revision: 1,
        offerSchemaVersion: 3,
        allowedRuleCodeGroups: Prisma.DbNull,
        stackingGroups: [],
        startsAt: new Date('2026-08-01T06:00:00.000Z'),
        endsAt: new Date('2026-09-01T06:00:00.000Z'),
        createdById: staffId,
        updatedById: staffId,
      },
    })
    const emittedOffer = emitCommercialOfferV3(stackedOfferSource(offerVersionId, offerCode))
    await prisma.commercialCampaignVersion.create({
      data: {
        id: offerVersionId,
        campaignCode: offerCode,
        sourceDraftId: offerDraftId,
        sourceRevision: 1,
        schemaVersion: 3,
        snapshot: emittedOffer.snapshot as unknown as Prisma.InputJsonValue,
        checksum: emittedOffer.checksum,
        reason: 'Offer control disposable authority',
        publishedById: staffId,
        publishedAt: new Date(emittedOffer.snapshot.publishedAt),
      },
    })

    const clients = Array.from({ length: 5 }, () => new PrismaClient({ datasources: { db: { url: targetUrl } } }))
    const releaseReaders = deferred()
    let releaseExhaustionReaders: ReturnType<typeof deferred> | null = null
    const readerLocked = Array.from({ length: 5 }, () => deferred())
    const holdReader = (index: number) =>
      clients[index].$transaction(
        async rawTx => {
          const tx = createPrismaCommercialOfferControlTransactionV3(rawTx)
          await tx.setLocalLockTimeout(1_000)
          const offer = await tx.lockOffer(offerVersionId, 'FOR_SHARE')
          if (!offer) throw new Error('COMMERCIAL_OFFER_CONTROL_READER_OFFER_MISSING')
          readerLocked[index].resolve()
          await releaseReaders.promise
          return resolveCommercialOfferControlStateV3(await tx.readLatestEvent(offerVersionId))
        },
        { ...COMMERCIAL_OFFER_CONTROL_V3_TRANSACTION_OPTIONS, timeout: 10_000 },
      )

    try {
      const firstReader = holdReader(0)
      const secondReader = holdReader(1)
      await within(Promise.all([readerLocked[0].promise, readerLocked[1].promise]))

      const service = createPrismaCommercialOfferControlV3Service(prisma)
      const actor = {
        staffId,
        permissions: ['commercial:publish'],
        ipAddress: '127.0.0.1',
        userAgent: 'offer-control-integration',
      }
      let writerSettled = false
      const writer = service
        .create(
          {
            offerVersionId,
            action: 'SUSPEND_NEW_CLAIMS',
            reason: 'Incident rehearsal',
            confirmedById: staffId,
            confirm: true,
          },
          actor,
        )
        .finally(() => {
          writerSettled = true
        })
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(writerSettled).toBe(false)
      releaseReaders.resolve()
      await expect(within(firstReader)).resolves.toBe('OPEN')
      await expect(within(secondReader)).resolves.toBe('OPEN')
      await expect(within(writer)).resolves.toMatchObject({
        revision: 1,
        action: 'SUSPEND_NEW_CLAIMS',
        state: 'SUSPEND_NEW_CLAIMS',
      })
      const persistedControlEvent = await prisma.commercialOfferControlEvent.findFirstOrThrow({
        where: { offerVersionId, revision: 1 },
        select: { id: true },
      })
      const controlOutbox = await prisma.commercialEventOutbox.findFirstOrThrow({
        where: {
          sourceType: 'OFFER_CONTROL_EVENT',
          sourceId: persistedControlEvent.id,
          sourceRevision: 1,
          eventType: 'COMMERCIAL_OFFER_CONTROL_CHANGED',
        },
        select: { organizationId: true, venueId: true, payload: true },
      })
      expect(controlOutbox).toEqual({
        organizationId: null,
        venueId: null,
        payload: {
          schemaVersion: 1,
          offerVersionId,
          offerSchemaVersion: 3,
          controlEventId: persistedControlEvent.id,
          controlAction: 'SUSPEND_NEW_CLAIMS',
          state: 'SUSPEND_NEW_CLAIMS',
        },
      })
      expect(JSON.stringify(controlOutbox.payload)).not.toContain('Incident rehearsal')

      const beforeRollback = {
        events: await prisma.commercialOfferControlEvent.count({ where: { offerVersionId } }),
        audits: await prisma.activityLog.count({ where: { entityId: offerVersionId } }),
        outboxes: await prisma.commercialEventOutbox.count({ where: { sourceType: 'OFFER_CONTROL_EVENT' } }),
      }
      const expectedRollback = new Error('COMMERCIAL_OFFER_CONTROL_EXPECTED_ROLLBACK')
      const rollbackService = createCommercialOfferControlV3Service({
        runInTransaction: (operation, options) =>
          prisma.$transaction(async rawTx => {
            await operation(createPrismaCommercialOfferControlTransactionV3(rawTx))
            throw expectedRollback
          }, options),
        writeFailedAudit: async () => {
          throw new Error('COMMERCIAL_OFFER_CONTROL_FAILURE_AUDIT_MUST_NOT_RUN')
        },
        randomId: randomUUID,
        sleep: async () => undefined,
      })
      await expect(
        rollbackService.create(
          {
            offerVersionId,
            action: 'RESUME',
            reason: 'Rollback rehearsal',
            confirmedById: staffId,
            confirm: true,
          },
          actor,
        ),
      ).rejects.toBe(expectedRollback)
      await expect(prisma.commercialOfferControlEvent.count({ where: { offerVersionId } })).resolves.toBe(beforeRollback.events)
      await expect(prisma.activityLog.count({ where: { entityId: offerVersionId } })).resolves.toBe(beforeRollback.audits)
      await expect(prisma.commercialEventOutbox.count({ where: { sourceType: 'OFFER_CONTROL_EVENT' } })).resolves.toBe(
        beforeRollback.outboxes,
      )

      const exhaustionRelease = deferred()
      releaseExhaustionReaders = exhaustionRelease
      const exhaustionLocked = Array.from({ length: 3 }, () => deferred())
      const exhaustionReaders = Array.from({ length: 3 }, (_, index) =>
        clients[index + 2].$transaction(
          async rawTx => {
            const tx = createPrismaCommercialOfferControlTransactionV3(rawTx)
            await tx.setLocalLockTimeout(1_000)
            const offer = await tx.lockOffer(offerVersionId, 'FOR_SHARE')
            if (!offer) throw new Error('COMMERCIAL_OFFER_CONTROL_READER_OFFER_MISSING')
            exhaustionLocked[index].resolve()
            await exhaustionRelease.promise
            return resolveCommercialOfferControlStateV3(await tx.readLatestEvent(offerVersionId))
          },
          { ...COMMERCIAL_OFFER_CONTROL_V3_TRANSACTION_OPTIONS, timeout: 25_000 },
        ),
      )
      await within(Promise.all(exhaustionLocked.map(lock => lock.promise)))
      const exhaustedWriter = service.create(
        {
          offerVersionId,
          action: 'SUSPEND_ALL_PENDING',
          reason: 'Sensitive reason must not leak',
          confirmedById: staffId,
          confirm: true,
        },
        actor,
      )
      await expect(within(exhaustedWriter, 20_000)).rejects.toMatchObject({
        code: 'COMMERCIAL_OFFER_CONTROL_UNAVAILABLE',
        details: { retryable: true, attempts: 3 },
      })
      exhaustionRelease.resolve()
      await expect(within(Promise.all(exhaustionReaders))).resolves.toEqual([
        'SUSPEND_NEW_CLAIMS',
        'SUSPEND_NEW_CLAIMS',
        'SUSPEND_NEW_CLAIMS',
      ])

      await expect(prisma.commercialOfferControlEvent.count({ where: { offerVersionId } })).resolves.toBe(1)
      const audits = await prisma.activityLog.findMany({
        where: {
          entity: 'CommercialCampaignVersion',
          entityId: offerVersionId,
          action: { in: ['COMMERCIAL_OFFER_CONTROL_CHANGED', 'COMMERCIAL_OFFER_CONTROL_FAILED'] },
        },
        orderBy: { createdAt: 'asc' },
      })
      expect(audits).toHaveLength(2)
      expect(
        audits.map(audit => ({
          staffId: audit.staffId,
          actorType: audit.actorType,
          organizationId: audit.organizationId,
          venueId: audit.venueId,
          action: audit.action,
        })),
      ).toEqual([
        {
          staffId,
          actorType: null,
          organizationId: null,
          venueId: null,
          action: 'COMMERCIAL_OFFER_CONTROL_CHANGED',
        },
        {
          staffId,
          actorType: null,
          organizationId: null,
          venueId: null,
          action: 'COMMERCIAL_OFFER_CONTROL_FAILED',
        },
      ])
      expect(JSON.stringify(audits.map(audit => audit.data))).not.toContain('Sensitive reason must not leak')
    } finally {
      releaseReaders.resolve()
      releaseExhaustionReaders?.resolve()
      await Promise.all(clients.map(client => client.$disconnect().catch(() => undefined)))
    }
  })

  it('creates a direct Quote under real locked authority and rolls back every rejected or partially persisted attempt', async () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 16)
    const ids = {
      staff: `direct_create_staff_${suffix}`,
      organization: `direct_create_org_${suffix}`,
      venue: `direct_create_venue_${suffix}`,
      catalogDraft: `direct_create_catalog_draft_${suffix}`,
      catalog: `direct_create_catalog_${suffix}`,
      catalogActivation: `direct_create_catalog_activation_${suffix}`,
      offerDraft: `direct_create_offer_draft_${suffix}`,
      offer: `direct_create_offer_${suffix}`,
      permissionSet: `direct_create_permission_set_${suffix}`,
      ownerRoleOverride: `direct_create_owner_override_${suffix}`,
      roleOverride: `direct_create_role_override_${suffix}`,
      concurrentQuote: `direct_create_concurrent_quote_${suffix}`,
      membershipLockedQuote: `direct_create_membership_locked_quote_${suffix}`,
      rollbackQuote: `direct_create_rollback_quote_${suffix}`,
    }
    const offerCode = `DC_${suffix.toUpperCase()}`

    const catalogSource = clone(catalogFixture) as CommercialCatalogSnapshotV2
    catalogSource.publicationId = ids.catalog
    const catalog = emitCommercialArtifactV2({
      kind: 'CATALOG',
      schemaVersion: 2,
      domainValue: catalogSource,
    })
    const emittedOffer = emitCommercialOfferV3(stackedOfferSource(ids.offer, offerCode))

    await prisma.$transaction(async tx => {
      await tx.staff.create({
        data: {
          id: ids.staff,
          email: `${ids.staff}@example.test`,
          firstName: 'Direct',
          lastName: 'Creator',
        },
      })
      await tx.organization.create({
        data: {
          id: ids.organization,
          name: 'Direct creation disposable organization',
          email: `${ids.organization}@example.test`,
          phone: '+525500000002',
        },
      })
      await tx.venue.create({
        data: {
          id: ids.venue,
          organizationId: ids.organization,
          name: 'Direct creation disposable venue',
          slug: `direct-creation-${suffix}`,
        },
      })
      await tx.staffVenue.create({
        data: {
          staffId: ids.staff,
          venueId: ids.venue,
          role: StaffRole.OWNER,
          active: true,
        },
      })
      await tx.commercialDraft.create({
        data: {
          id: ids.catalogDraft,
          sourceKey: ids.catalogDraft,
          name: 'Direct creation disposable catalog',
          revision: 1,
          createdById: ids.staff,
          updatedById: ids.staff,
        },
      })
      await tx.commercialPublication.create({
        data: {
          id: ids.catalog,
          sourceDraftId: ids.catalogDraft,
          sourceRevision: 1,
          schemaVersion: 2,
          snapshot: catalog.snapshot as unknown as Prisma.InputJsonValue,
          checksum: catalog.checksum,
          reason: 'Direct creation authority proof',
          publishedById: ids.staff,
          publishedAt: new Date(catalog.snapshot.publishedAt),
        },
      })
      await tx.commercialPublicationActivation.create({
        data: {
          id: ids.catalogActivation,
          environment: 'PRODUCTION',
          publicationId: ids.catalog,
          reason: 'Direct creation authority proof',
          updatedById: ids.staff,
        },
      })
      await tx.commercialCampaignDraft.create({
        data: {
          id: ids.offerDraft,
          code: offerCode,
          name: 'Direct creation disposable offer',
          revision: 1,
          offerSchemaVersion: 3,
          allowedRuleCodeGroups: Prisma.DbNull,
          stackingGroups: [],
          startsAt: new Date(emittedOffer.snapshot.claimStartsAt),
          endsAt: new Date(emittedOffer.snapshot.claimEndsAt),
          createdById: ids.staff,
          updatedById: ids.staff,
        },
      })
      await tx.commercialCampaignVersion.create({
        data: {
          id: ids.offer,
          campaignCode: offerCode,
          sourceDraftId: ids.offerDraft,
          sourceRevision: emittedOffer.snapshot.version,
          schemaVersion: 3,
          snapshot: emittedOffer.snapshot as unknown as Prisma.InputJsonValue,
          checksum: emittedOffer.checksum,
          reason: 'Direct creation authority proof',
          publishedById: ids.staff,
          publishedAt: new Date(emittedOffer.snapshot.publishedAt),
        },
      })
    })

    const input = {
      organizationId: ids.organization,
      venueId: ids.venue,
      actorId: ids.staff,
      offerVersionId: ids.offer,
      saasSelections: [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      hardwareSelections: [{ catalogKey: 'NEXGO_N62', quantity: 1 }],
      rateBlockers: [],
      correlationId: `direct-create-${suffix}`,
    }
    const service = createPrismaCommercialDirectQuoteV3Service(prisma)
    const created = await service.create(input)
    expect(created.snapshot.subject).toEqual({
      kind: 'VENUE',
      organizationId: ids.organization,
      venueId: ids.venue,
      actorId: ids.staff,
    })
    expect(created.snapshot.catalogPublicationId).toBe(ids.catalog)
    expect(created.snapshot.offerVersionId).toBe(ids.offer)
    expect(Date.parse(created.snapshot.expiresAt) - Date.parse(created.snapshot.quotedAt)).toBe(900_000)
    await expect(prisma.commercialQuote.count({ where: { id: created.id } })).resolves.toBe(1)
    await expect(
      prisma.activityLog.count({
        where: { action: 'COMMERCIAL_QUOTE_CREATED', entity: 'CommercialQuote', entityId: created.id },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.activityLog.findFirstOrThrow({
        where: { action: 'COMMERCIAL_QUOTE_CREATED', entity: 'CommercialQuote', entityId: created.id },
        select: { data: true },
      }),
    ).resolves.toMatchObject({ data: expect.objectContaining({ correlationId: input.correlationId }) })

    const roleAuthorityRead = deferred()
    const releaseRoleAuthority = deferred()
    const customizationClient = new PrismaClient({ datasources: { db: { url: targetUrl } } })
    const lockingService = createCommercialDirectQuoteV3Service({
      runInTransaction: (operation, options) =>
        prisma.$transaction(async rawTx => {
          const tx = createPrismaCommercialDirectQuoteV3Transaction(rawTx)
          return operation({
            ...tx,
            async lockRoleOverride(venueId, role) {
              const row = await tx.lockRoleOverride(venueId, role)
              roleAuthorityRead.resolve()
              await releaseRoleAuthority.promise
              return row
            },
          })
        }, options),
      randomId: () => ids.concurrentQuote,
      sleep: async () => undefined,
      retryDelayMilliseconds: () => 0,
    })
    try {
      const lockedQuote = lockingService.create(input)
      await within(roleAuthorityRead.promise)
      const customization = customizationClient.venueRolePermission.create({
        data: {
          id: ids.ownerRoleOverride,
          venueId: ids.venue,
          role: StaffRole.OWNER,
          permissions: [],
          deniedPermissions: ['billing:subscriptions:manage'],
          modifiedBy: ids.staff,
        },
      })
      await expect(within(customization)).resolves.toMatchObject({ id: ids.ownerRoleOverride })
      releaseRoleAuthority.resolve()
      await expect(within(lockedQuote)).resolves.toMatchObject({ id: ids.concurrentQuote })
    } finally {
      releaseRoleAuthority.resolve()
      await customizationClient.$disconnect().catch(() => undefined)
    }
    await prisma.venueRolePermission.delete({ where: { id: ids.ownerRoleOverride } })

    const membershipAuthorityRead = deferred()
    const releaseMembershipAuthority = deferred()
    const revocationClient = new PrismaClient({ datasources: { db: { url: targetUrl } } })
    const membershipLockingService = createCommercialDirectQuoteV3Service({
      runInTransaction: (operation, options) =>
        prisma.$transaction(async rawTx => {
          const tx = createPrismaCommercialDirectQuoteV3Transaction(rawTx)
          return operation({
            ...tx,
            async lockMembership(staffId, venueId) {
              const row = await tx.lockMembership(staffId, venueId)
              membershipAuthorityRead.resolve()
              await releaseMembershipAuthority.promise
              return row
            },
          })
        }, options),
      randomId: () => ids.membershipLockedQuote,
      sleep: async () => undefined,
      retryDelayMilliseconds: () => 0,
    })
    let revocationSettled = false
    try {
      const lockedQuote = membershipLockingService.create(input)
      await within(membershipAuthorityRead.promise)
      const revocation = revocationClient.staffVenue
        .update({
          where: { staffId_venueId: { staffId: ids.staff, venueId: ids.venue } },
          data: { active: false },
        })
        .finally(() => {
          revocationSettled = true
        })
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(revocationSettled).toBe(false)
      releaseMembershipAuthority.resolve()
      await expect(within(lockedQuote)).resolves.toMatchObject({ id: ids.membershipLockedQuote })
      await expect(within(revocation)).resolves.toMatchObject({ active: false })
    } finally {
      releaseMembershipAuthority.resolve()
      await revocationClient.$disconnect().catch(() => undefined)
    }
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: ids.staff, venueId: ids.venue } },
      data: { active: true },
    })

    const baseline = {
      quotes: await prisma.commercialQuote.count({ where: { venueId: ids.venue } }),
      audits: await prisma.activityLog.count({
        where: { action: 'COMMERCIAL_QUOTE_CREATED', venueId: ids.venue },
      }),
    }

    await prisma.permissionSet.create({
      data: {
        id: ids.permissionSet,
        venueId: ids.venue,
        name: `No billing ${suffix}`,
        permissions: ['orders:read'],
        createdBy: ids.staff,
      },
    })
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: ids.staff, venueId: ids.venue } },
      data: { permissionSetId: ids.permissionSet },
    })
    await expect(service.create(input)).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_V3_PERMISSION_REQUIRED',
    })
    await expect(prisma.commercialQuote.count({ where: { venueId: ids.venue } })).resolves.toBe(baseline.quotes)
    await expect(prisma.activityLog.count({ where: { action: 'COMMERCIAL_QUOTE_CREATED', venueId: ids.venue } })).resolves.toBe(
      baseline.audits,
    )

    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: ids.staff, venueId: ids.venue } },
      data: { permissionSetId: null, role: StaffRole.VIEWER },
    })
    await prisma.venueRolePermission.create({
      data: {
        id: ids.roleOverride,
        venueId: ids.venue,
        role: StaffRole.VIEWER,
        permissions: ['orders:read'],
        deniedPermissions: ['billing:subscriptions:manage'],
        modifiedBy: ids.staff,
      },
    })
    await expect(service.create(input)).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_V3_PERMISSION_REQUIRED',
    })
    await expect(prisma.commercialQuote.count({ where: { venueId: ids.venue } })).resolves.toBe(baseline.quotes)

    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: ids.staff, venueId: ids.venue } },
      data: { role: StaffRole.OWNER },
    })

    const acceptingStaffId = `direct_acceptor_staff_${suffix}`
    const otherAcceptingStaffId = `direct_other_acceptor_staff_${suffix}`
    for (const [staffId, firstName] of [
      [acceptingStaffId, 'Authorized'],
      [otherAcceptingStaffId, 'Other'],
    ] as const) {
      await prisma.staff.create({
        data: {
          id: staffId,
          email: `${staffId}@example.test`,
          firstName,
          lastName: 'Acceptor',
        },
      })
      await prisma.staffVenue.create({
        data: {
          staffId,
          venueId: ids.venue,
          role: StaffRole.OWNER,
          active: true,
        },
      })
    }

    const countConsentSideEffects = async () => ({
      stripeOperations: await prisma.commercialStripeOperation.count(),
      subscriptionEvents: await prisma.commercialSubscriptionEvent.count(),
      entitlements: await prisma.organizationEntitlement.count(),
      checkoutSessions: await prisma.checkoutSession.count(),
      terminalOrders: await prisma.terminalOrder.count(),
      featureSubscriptions: await prisma.venueFeature.count({ where: { stripeSubscriptionId: { not: null } } }),
    })
    const sideEffectsBefore = await countConsentSideEffects()
    const acceptanceService = createPrismaCommercialQuoteV3AcceptanceService(prisma)
    const acceptanceInput = {
      quoteId: created.id,
      organizationId: ids.organization,
      venueId: ids.venue,
      acceptedById: acceptingStaffId,
      idempotencyKey: `direct-acceptance-${suffix}`,
      correlationId: `direct-acceptance-correlation-${suffix}`,
    }
    const accepted = await acceptanceService.accept(acceptanceInput)
    expect(accepted).toMatchObject({
      quoteId: created.id,
      organizationId: ids.organization,
      venueId: ids.venue,
      acceptedById: acceptingStaffId,
      status: 'ACCEPTED',
      revision: 1,
    })
    expect(accepted.acceptedById).not.toBe(ids.staff)
    await expect(acceptanceService.accept(acceptanceInput)).resolves.toEqual(accepted)
    await expect(
      acceptanceService.accept({ ...acceptanceInput, idempotencyKey: `direct-acceptance-different-${suffix}` }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_ALREADY_ACCEPTED' })
    for (const idempotencyKey of [acceptanceInput.idempotencyKey, `direct-acceptance-other-actor-${suffix}`]) {
      await expect(
        acceptanceService.accept({
          ...acceptanceInput,
          acceptedById: otherAcceptingStaffId,
          idempotencyKey,
        }),
      ).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_ALREADY_ACCEPTED' })
    }
    await expect(countConsentSideEffects()).resolves.toEqual(sideEffectsBefore)
    await expect(
      prisma.activityLog.findFirstOrThrow({
        where: { action: 'COMMERCIAL_QUOTE_ACCEPTED', entityId: accepted.id },
        select: { staffId: true, actorStaffId: true, organizationId: true, venueId: true, data: true },
      }),
    ).resolves.toEqual({
      staffId: acceptingStaffId,
      actorStaffId: acceptingStaffId,
      organizationId: ids.organization,
      venueId: ids.venue,
      data: { quoteId: created.id, acceptedAt: accepted.acceptedAt.toISOString() },
    })

    const v2FinancialCalls = {
      existingAcceptance: 0,
      authority: 0,
      createAcceptance: 0,
      audit: 0,
    }
    const v2AcceptanceService = createCommercialQuoteAcceptanceService({
      assertCheckoutAllowed: () => assertCommercialV2CheckoutActive('ACTIVE'),
      now: () => new Date(),
      randomId: () => `v2-must-not-create-${suffix}`,
      runInTransaction: operation =>
        prisma.$transaction(async tx => {
          const boundary: CommercialQuoteAcceptanceTransaction = {
            async lockQuote(id) {
              const rows = await tx.$queryRaw<
                Array<{
                  id: string
                  organizationId: string | null
                  venueId: string | null
                  schemaVersion: number
                  offerVersionId: string | null
                  catalogPublicationId: string
                  campaignVersionId: string | null
                  expiresAt: Date
                }>
              >`
                SELECT "id", "organizationId", "venueId", "schemaVersion", "offerVersionId",
                       "catalogPublicationId", "campaignVersionId", "expiresAt"
                FROM "CommercialQuote"
                WHERE "id" = ${id}
                FOR UPDATE
              `
              return rows[0] ?? null
            },
            async findAcceptanceByQuoteId() {
              v2FinancialCalls.existingAcceptance += 1
              throw new Error('V2_EXISTING_ACCEPTANCE_MUST_NOT_RUN_FOR_V3')
            },
            async isQuoteAuthorityCurrent() {
              v2FinancialCalls.authority += 1
              throw new Error('V2_AUTHORITY_MUST_NOT_RUN_FOR_V3')
            },
            async createAcceptance() {
              v2FinancialCalls.createAcceptance += 1
              throw new Error('V2_ACCEPTANCE_MUST_NOT_RUN_FOR_V3')
            },
            async writeAudit() {
              v2FinancialCalls.audit += 1
              throw new Error('V2_AUDIT_MUST_NOT_RUN_FOR_V3')
            },
          }
          return operation(boundary)
        }),
    })
    const acceptancesBeforeV2Boundary = await prisma.commercialQuoteAcceptance.count()
    await expect(
      v2AcceptanceService.accept({
        quoteId: created.id,
        organizationId: ids.organization,
        venueId: ids.venue,
        acceptedById: acceptingStaffId,
        idempotencyKey: `v2-must-reject-v3-${suffix}`,
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_SCHEMA_UNSUPPORTED' })
    expect(v2FinancialCalls).toEqual({
      existingAcceptance: 0,
      authority: 0,
      createAcceptance: 0,
      audit: 0,
    })
    await expect(prisma.commercialQuoteAcceptance.count()).resolves.toBe(acceptancesBeforeV2Boundary)

    const acceptanceTriggers = await prisma.$queryRaw<Array<{ kind: string; relation: string; name: string }>>`
      WITH RECURSIVE acceptance_relations(oid) AS (
        SELECT 'public."CommercialQuoteAcceptance"'::regclass::oid
        UNION ALL
        SELECT inheritance.inhrelid
        FROM pg_inherits AS inheritance
        JOIN acceptance_relations AS parent ON parent.oid = inheritance.inhparent
      )
      SELECT 'TRIGGER' AS kind, relation.oid::regclass::text AS relation, trigger.tgname AS name
      FROM acceptance_relations AS target
      JOIN pg_class AS relation ON relation.oid = target.oid
      JOIN pg_trigger AS trigger ON trigger.tgrelid = target.oid
      WHERE NOT trigger.tgisinternal
      UNION ALL
      SELECT 'RULE' AS kind, relation.oid::regclass::text AS relation, rewrite.rulename AS name
      FROM acceptance_relations AS target
      JOIN pg_class AS relation ON relation.oid = target.oid
      JOIN pg_rewrite AS rewrite ON rewrite.ev_class = target.oid
      WHERE rewrite.rulename <> '_RETURN'
      ORDER BY kind, relation, name
    `
    expect(acceptanceTriggers).toEqual([])

    const sameKeyQuote = await service.create({ ...input, correlationId: `same-key-quote-${suffix}` })
    const firstQuoteLocked = deferred()
    const releaseFirstQuote = deferred()
    let lockSequence = 0
    let acceptanceInsertAttempts = 0
    const serializingAcceptanceService = createCommercialQuoteV3AcceptanceService({
      runInTransaction: (operation, options) =>
        prisma.$transaction(async rawTx => {
          const tx = createPrismaCommercialQuoteV3AcceptanceTransaction(rawTx)
          return operation({
            ...tx,
            async lockQuote(quoteId) {
              const row = await tx.lockQuote(quoteId)
              lockSequence += 1
              if (quoteId === sameKeyQuote.id && lockSequence === 1) {
                firstQuoteLocked.resolve()
                await releaseFirstQuote.promise
              }
              return row
            },
            async createAcceptance(createInput) {
              acceptanceInsertAttempts += 1
              return tx.createAcceptance(createInput)
            },
          })
        }, options),
      randomId: randomUUID,
      sleep: async () => undefined,
      retryDelayMilliseconds: () => 0,
      recordPoisonedResolution: () => undefined,
    })
    const sameKeyInput = {
      ...acceptanceInput,
      quoteId: sameKeyQuote.id,
      idempotencyKey: `same-key-${suffix}`,
      correlationId: `same-key-correlation-${suffix}`,
    }
    const firstSameKey = serializingAcceptanceService.accept(sameKeyInput)
    await within(firstQuoteLocked.promise)
    let secondSameKeySettled = false
    const secondSameKey = serializingAcceptanceService.accept(sameKeyInput).finally(() => {
      secondSameKeySettled = true
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(secondSameKeySettled).toBe(false)
    expect(acceptanceInsertAttempts).toBe(0)
    releaseFirstQuote.resolve()
    const [sameKeyFirstResult, sameKeySecondResult] = await within(Promise.all([firstSameKey, secondSameKey]))
    expect(sameKeySecondResult).toEqual(sameKeyFirstResult)
    expect(acceptanceInsertAttempts).toBe(1)

    const differentKeyQuote = await service.create({ ...input, correlationId: `different-key-quote-${suffix}` })
    const distinctResults = await Promise.allSettled([
      acceptanceService.accept({
        ...acceptanceInput,
        quoteId: differentKeyQuote.id,
        idempotencyKey: `different-key-a-${suffix}`,
      }),
      acceptanceService.accept({
        ...acceptanceInput,
        quoteId: differentKeyQuote.id,
        idempotencyKey: `different-key-b-${suffix}`,
      }),
    ])
    expect(distinctResults.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const distinctConflict = distinctResults.find(result => result.status === 'rejected')
    expect(distinctConflict).toMatchObject({ reason: { code: 'COMMERCIAL_QUOTE_ALREADY_ACCEPTED' } })

    const firstCollisionQuote = await service.create({ ...input, correlationId: `collision-a-${suffix}` })
    const secondCollisionQuote = await service.create({ ...input, correlationId: `collision-b-${suffix}` })
    const sharedCollisionKey = `cross-quote-collision-${suffix}`
    const collisionResults = await Promise.allSettled([
      acceptanceService.accept({
        ...acceptanceInput,
        quoteId: firstCollisionQuote.id,
        idempotencyKey: sharedCollisionKey,
      }),
      acceptanceService.accept({
        ...acceptanceInput,
        quoteId: secondCollisionQuote.id,
        idempotencyKey: sharedCollisionKey,
      }),
    ])
    expect(collisionResults.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(collisionResults.find(result => result.status === 'rejected')).toMatchObject({
      reason: { code: 'COMMERCIAL_QUOTE_ACCEPTANCE_IDEMPOTENCY_KEY_CONFLICT' },
    })

    const foreignOrganizationId = `direct_acceptance_foreign_org_${suffix}`
    const foreignVenueId = `direct_acceptance_foreign_venue_${suffix}`
    const foreignStaffId = `direct_acceptance_foreign_staff_${suffix}`
    await prisma.$transaction(async tx => {
      await tx.staff.create({
        data: {
          id: foreignStaffId,
          email: `${foreignStaffId}@example.test`,
          firstName: 'Foreign',
          lastName: 'Acceptor',
        },
      })
      await tx.organization.create({
        data: {
          id: foreignOrganizationId,
          name: 'Foreign disposable organization',
          email: `${foreignOrganizationId}@example.test`,
          phone: '+525500000003',
        },
      })
      await tx.venue.create({
        data: {
          id: foreignVenueId,
          organizationId: foreignOrganizationId,
          name: 'Foreign disposable venue',
          slug: `direct-acceptance-foreign-${suffix}`,
        },
      })
      await tx.staffVenue.create({
        data: { staffId: foreignStaffId, venueId: foreignVenueId, role: StaffRole.OWNER, active: true },
      })
    })
    const foreignQuote = await service.create({
      ...input,
      organizationId: foreignOrganizationId,
      venueId: foreignVenueId,
      actorId: foreignStaffId,
      correlationId: `foreign-quote-${suffix}`,
    })
    let foreignCollision: unknown
    try {
      await acceptanceService.accept({
        quoteId: foreignQuote.id,
        organizationId: foreignOrganizationId,
        venueId: foreignVenueId,
        acceptedById: foreignStaffId,
        idempotencyKey: sharedCollisionKey,
        correlationId: `foreign-collision-${suffix}`,
      })
    } catch (error) {
      foreignCollision = error
    }
    expect(foreignCollision).toMatchObject({ code: 'COMMERCIAL_QUOTE_ACCEPTANCE_IDEMPOTENCY_KEY_CONFLICT' })
    expect(foreignCollision).toBeInstanceOf(Error)
    const foreignError = foreignCollision as Error & { details?: unknown }
    const foreignIdentifiers = new RegExp(`${ids.organization}|${accepted.id}`)
    expect(foreignError.message).not.toMatch(foreignIdentifiers)
    expect(JSON.stringify(foreignError.details ?? null)).not.toMatch(foreignIdentifiers)
    expect(foreignError.stack ?? '').not.toMatch(foreignIdentifiers)

    const permissionQuote = await service.create({ ...input, correlationId: `permission-quote-${suffix}` })
    const acceptancePermissionSetId = `direct_acceptance_permission_set_${suffix}`
    await prisma.permissionSet.create({
      data: {
        id: acceptancePermissionSetId,
        venueId: ids.venue,
        name: `Acceptance no billing ${suffix}`,
        permissions: ['orders:read'],
        createdBy: ids.staff,
      },
    })
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: acceptingStaffId, venueId: ids.venue } },
      data: { permissionSetId: acceptancePermissionSetId },
    })
    await expect(
      acceptanceService.accept({
        ...acceptanceInput,
        quoteId: permissionQuote.id,
        idempotencyKey: `permission-acceptance-${suffix}`,
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_V3_PERMISSION_REQUIRED' })
    await expect(prisma.commercialQuoteAcceptance.count({ where: { quoteId: permissionQuote.id } })).resolves.toBe(0)
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: acceptingStaffId, venueId: ids.venue } },
      data: { permissionSetId: null },
    })

    const rollbackAcceptanceQuote = await service.create({ ...input, correlationId: `rollback-acceptance-quote-${suffix}` })
    const expectedAcceptanceAuditFailure = new Error('COMMERCIAL_QUOTE_V3_ACCEPTANCE_EXPECTED_AUDIT_FAILURE')
    const rollbackAcceptanceService = createCommercialQuoteV3AcceptanceService({
      runInTransaction: (operation, options) =>
        prisma.$transaction(async rawTx => {
          const tx = createPrismaCommercialQuoteV3AcceptanceTransaction(rawTx)
          return operation({
            ...tx,
            writeAudit: async () => {
              throw expectedAcceptanceAuditFailure
            },
          })
        }, options),
      randomId: randomUUID,
      sleep: async () => undefined,
      retryDelayMilliseconds: () => 0,
      recordPoisonedResolution: () => undefined,
    })
    await expect(
      rollbackAcceptanceService.accept({
        ...acceptanceInput,
        quoteId: rollbackAcceptanceQuote.id,
        idempotencyKey: `rollback-acceptance-${suffix}`,
      }),
    ).rejects.toBe(expectedAcceptanceAuditFailure)
    await expect(prisma.commercialQuoteAcceptance.count({ where: { quoteId: rollbackAcceptanceQuote.id } })).resolves.toBe(0)

    const performanceCatalogId = `direct_acceptance_perf_catalog_${suffix}`
    const performanceCatalogDraftId = `direct_acceptance_perf_catalog_draft_${suffix}`
    const performanceOfferId = `direct_acceptance_perf_offer_${suffix}`
    const performanceOfferDraftId = `direct_acceptance_perf_offer_draft_${suffix}`
    const performanceQuoteIdPrefix = `direct_acceptance_perf_quote_${suffix}`
    const performanceProductCodes = Array.from({ length: 50 }, (_, index) => `PERF_${index.toString().padStart(2, '0')}`)
    const performanceCatalogSource = clone(catalogFixture) as CommercialCatalogSnapshotV2
    const posProduct = performanceCatalogSource.products.find(product => product.code === 'POS')
    const freeProduct = performanceCatalogSource.products.find(product => product.code === 'FREE')
    const tableProduct = performanceCatalogSource.products.find(product => product.code === 'TABLE_SERVICE_MODULE')
    const kitchenProduct = performanceCatalogSource.products.find(product => product.code === 'KITCHEN_DISPLAY_MODULE')
    if (!posProduct || !freeProduct || !tableProduct || !kitchenProduct) {
      throw new Error('COMMERCIAL_QUOTE_V3_PERFORMANCE_PRODUCTS_MISSING')
    }
    const performanceBindings = [
      posProduct.capabilityBindings[0],
      freeProduct.capabilityBindings[0],
      tableProduct.capabilityBindings[0],
      kitchenProduct.capabilityBindings[0],
    ]
    performanceCatalogSource.publicationId = performanceCatalogId
    performanceCatalogSource.products = performanceProductCodes.map((productCode, index) => ({
      ...clone(posProduct),
      code: productCode,
      slug: `performance-${index.toString().padStart(2, '0')}`,
      name: `Performance ${index.toString().padStart(2, '0')}`,
      sortOrder: index + 1,
      capabilityBindings: [clone(performanceBindings[index % performanceBindings.length])],
      prices: [
        {
          ...clone(posProduct.prices[0]),
          code: `${productCode}_MONTHLY`,
          amount: '100.00',
        },
      ],
    }))
    performanceCatalogSource.bundles = []
    const performanceCatalog = emitCommercialArtifactV2({
      kind: 'CATALOG',
      schemaVersion: 2,
      domainValue: performanceCatalogSource,
    })
    const performanceClockRows = await prisma.$queryRaw<Array<{ now: Date }>>`
      SELECT date_trunc('milliseconds', clock_timestamp()) AS "now"
    `
    const performanceClock = performanceClockRows[0]?.now
    if (!performanceClock) throw new Error('COMMERCIAL_QUOTE_V3_PERFORMANCE_CLOCK_MISSING')
    const performanceRules: CommercialCampaignRuleV2[] = Array.from({ length: 100 }, (_, index) => {
      const groupIndex = Math.floor(index / 10)
      return {
        code: `PERF_RULE_${index.toString().padStart(3, '0')}`,
        type: 'PERCENT_OFF',
        priority: 10_000 - index,
        target: {
          productCodes: performanceProductCodes.slice(groupIndex * 5, groupIndex * 5 + 5) as [string, ...string[]],
        },
        cycles: 3,
        percentBasisPoints: 1,
      }
    })
    const performanceOfferSource: CommercialOfferSnapshotV3 = {
      schemaVersion: 3,
      contractVersion: '3.0.0',
      campaignVersionId: performanceOfferId,
      campaignCode: `PERF_${suffix.toUpperCase()}`,
      version: 1,
      status: 'ACTIVE',
      publishedAt: new Date(performanceClock.getTime() - 86_400_000).toISOString(),
      claimStartsAt: new Date(performanceClock.getTime() - 3_600_000).toISOString(),
      claimEndsAt: new Date(performanceClock.getTime() + 86_400_000).toISOString(),
      benefits: [
        {
          benefitCode: 'PERF_SAAS_STACK',
          kind: 'SAAS_PRICE',
          rules: performanceRules,
          stackingGroups: Array.from({ length: 10 }, (_, groupIndex) => ({
            code: `PERF_EXACT_STACK_${groupIndex.toString().padStart(2, '0')}`,
            steps: performanceRules
              .slice(groupIndex * 10, groupIndex * 10 + 10)
              .map((rule, index) => ({ position: index + 1, ruleCode: rule.code })),
          })),
        },
      ],
    }
    const performanceEmittedOffer = emitCommercialOfferV3(performanceOfferSource)
    const performanceOffer: CommercialQuoteV3Authorities['offer'] = {
      rowSchemaVersion: 3,
      snapshot: performanceEmittedOffer.snapshot,
      checksum: performanceEmittedOffer.checksum,
      rowContext: {
        id: performanceOfferId,
        campaignCode: performanceEmittedOffer.snapshot.campaignCode,
        sourceRevision: 1,
        schemaVersion: 3,
        publishedAt: new Date(performanceEmittedOffer.snapshot.publishedAt),
      },
    }
    const performanceAuthorities: CommercialQuoteV3Authorities = {
      catalog: performanceCatalog,
      offer: performanceOffer,
      acquisitionContext: null,
    }
    const performanceEvaluation = evaluateCommercialQuoteV3({
      authorities: performanceAuthorities,
      saasSelections: performanceProductCodes.map(productCode => ({
        targetType: 'PRODUCT' as const,
        targetCode: productCode,
        priceCode: `${productCode}_MONTHLY`,
        quantity: 1,
      })),
      hardwareSelections: [],
      rateBlockers: [],
      resolvedAt: performanceClock,
    })
    const buildPerformanceQuote = (quoteId: string) =>
      buildCommercialQuoteV3({
        quoteId,
        subject: { kind: 'VENUE', organizationId: ids.organization, venueId: ids.venue, actorId: ids.staff },
        acquisitionContextId: null,
        derivedFromPreview: null,
        quotedAt: performanceClock,
        expiresAt: new Date(performanceClock.getTime() + 15 * 60_000),
        evaluation: performanceEvaluation,
        authorities: performanceAuthorities,
      })
    const performanceQuote = buildPerformanceQuote(`${performanceQuoteIdPrefix}_shape`)
    expect(performanceQuote.snapshot.saasLines).toHaveLength(50)
    expect(performanceQuote.snapshot.saasLines.every(line => line.appliedOfferSteps.length === 10)).toBe(true)
    expect(performanceQuote.snapshot.resolution.applied).toHaveLength(500)
    expect(performanceQuote.snapshot.resolution.exclusions).toHaveLength(0)
    const warmupCount = 5
    // At 100 samples nearest-rank p99 is the second-slowest observation, so
    // the absolute maximum can independently trigger the INCONCLUSIVE band.
    const sampleSize = 100
    const performanceQuoteIds = Array.from(
      { length: warmupCount + sampleSize },
      (_value, index) => `${performanceQuoteIdPrefix}_${index.toString().padStart(2, '0')}`,
    )

    await prisma.$transaction(async tx => {
      await tx.commercialDraft.create({
        data: {
          id: performanceCatalogDraftId,
          sourceKey: performanceCatalogDraftId,
          name: 'Direct acceptance performance catalog',
          revision: 1,
          createdById: ids.staff,
          updatedById: ids.staff,
        },
      })
      await tx.commercialPublication.create({
        data: {
          id: performanceCatalogId,
          sourceDraftId: performanceCatalogDraftId,
          sourceRevision: 1,
          schemaVersion: 2,
          snapshot: performanceCatalog.snapshot as unknown as Prisma.InputJsonValue,
          checksum: performanceCatalog.checksum,
          reason: 'Direct acceptance performance proof',
          publishedById: ids.staff,
          publishedAt: new Date(performanceCatalog.snapshot.publishedAt),
        },
      })
      await tx.commercialCampaignDraft.create({
        data: {
          id: performanceOfferDraftId,
          code: performanceEmittedOffer.snapshot.campaignCode,
          name: 'Direct acceptance performance offer',
          revision: 1,
          offerSchemaVersion: 3,
          allowedRuleCodeGroups: Prisma.DbNull,
          stackingGroups: [],
          startsAt: new Date(performanceEmittedOffer.snapshot.claimStartsAt),
          endsAt: new Date(performanceEmittedOffer.snapshot.claimEndsAt),
          createdById: ids.staff,
          updatedById: ids.staff,
        },
      })
      await tx.commercialCampaignVersion.create({
        data: {
          id: performanceOfferId,
          campaignCode: performanceEmittedOffer.snapshot.campaignCode,
          sourceDraftId: performanceOfferDraftId,
          sourceRevision: 1,
          schemaVersion: 3,
          snapshot: performanceEmittedOffer.snapshot as unknown as Prisma.InputJsonValue,
          checksum: performanceEmittedOffer.checksum,
          reason: 'Direct acceptance performance proof',
          publishedById: ids.staff,
          publishedAt: new Date(performanceEmittedOffer.snapshot.publishedAt),
        },
      })
    })
    for (const quoteId of performanceQuoteIds) {
      await prisma.$transaction(async tx => {
        await persistCommercialQuoteV3(
          buildPerformanceQuote(quoteId),
          {
            loadAuthorities: async expected =>
              expected.catalogPublicationId === performanceCatalogId &&
              expected.offerVersionId === performanceOfferId &&
              expected.organizationId === ids.organization &&
              expected.venueId === ids.venue
                ? performanceAuthorities
                : null,
            commercialQuote: { create: createInput => tx.commercialQuote.create(createInput) },
            activityLog: { create: createInput => tx.activityLog.create(createInput) },
          },
          { correlationId: `performance-quote-${suffix}-${quoteId.slice(-2)}` },
        )
      })
    }

    const loadPerformanceDecodeInput = async (quoteId: string): Promise<CommercialQuoteV3DecodeInput | null> => {
      const row = await prisma.commercialQuote.findUnique({ where: { id: quoteId }, include: { venue: true } })
      if (!row?.venue || row.offerVersionId === null) return null
      return {
        rowSchemaVersion: row.schemaVersion,
        snapshot: row.snapshot,
        checksum: row.checksum,
        rowContext: {
          id: row.id,
          schemaVersion: row.schemaVersion,
          catalogPublicationId: row.catalogPublicationId,
          offerVersionId: row.offerVersionId,
          acquisitionContextId: row.acquisitionContextId,
          organizationId: row.organizationId,
          venueId: row.venueId,
          createdById: row.createdById,
          venueOrganizationId: row.venue.organizationId,
          market: row.market,
          currency: row.currency,
          quotedAt: row.quotedAt,
          expiresAt: row.expiresAt,
          listSubtotalMinor: row.listSubtotalMinor,
          discountMinor: row.discountMinor,
          subtotalMinor: row.subtotalMinor,
          taxMinor: row.taxMinor,
          totalMinor: row.totalMinor,
          renewalSubtotalMinor: row.renewalSubtotalMinor,
          renewalTaxMinor: row.renewalTaxMinor,
          renewalTotalMinor: row.renewalTotalMinor,
        },
        authorities: performanceAuthorities,
      }
    }
    const performanceStoredService = createCommercialStoredQuoteV3Service({
      loadRowAndAuthorities: input => loadPerformanceDecodeInput(input.quoteId),
      recordPoisonedResolution: () => undefined,
    })
    expect(performanceQuoteIds).toHaveLength(warmupCount + sampleSize)
    const performanceAcceptanceInput = (quoteId: string, index: number) => ({
      ...acceptanceInput,
      quoteId,
      idempotencyKey: `performance-acceptance-${suffix}-${index.toString().padStart(2, '0')}`,
      correlationId: `performance-acceptance-${suffix}-${index.toString().padStart(2, '0')}`,
    })
    const performanceAcceptanceIds: string[] = []
    for (let index = 0; index < warmupCount; index += 1) {
      const acceptanceInputForIteration = performanceAcceptanceInput(performanceQuoteIds[index], index)
      await performanceStoredService.loadVerified(acceptanceInputForIteration)
      performanceAcceptanceIds.push((await acceptanceService.accept(acceptanceInputForIteration)).id)
    }
    const replaySamples: number[] = []
    const transactionSamples: number[] = []
    for (let index = 0; index < sampleSize; index += 1) {
      const absoluteIndex = warmupCount + index
      const acceptanceInputForIteration = performanceAcceptanceInput(
        performanceQuoteIds[absoluteIndex],
        absoluteIndex,
      )
      const replayStartedAt = performance.now()
      await performanceStoredService.loadVerified(acceptanceInputForIteration)
      replaySamples.push(performance.now() - replayStartedAt)

      const transactionStartedAt = performance.now()
      const acceptedPerformanceQuote = await acceptanceService.accept(acceptanceInputForIteration)
      transactionSamples.push(performance.now() - transactionStartedAt)
      performanceAcceptanceIds.push(acceptedPerformanceQuote.id)
    }
    await expect(
      prisma.commercialQuoteAcceptance.count({ where: { quoteId: { in: performanceQuoteIds } } }),
    ).resolves.toBe(warmupCount + sampleSize)
    await expect(
      prisma.activityLog.count({
        where: { action: 'COMMERCIAL_QUOTE_ACCEPTED', entityId: { in: performanceAcceptanceIds } },
      }),
    ).resolves.toBe(warmupCount + sampleSize)
    const replayMetrics = {
      p50: percentile(replaySamples, 50),
      p95: percentile(replaySamples, 95),
      p99: percentile(replaySamples, 99),
      max: Math.max(...replaySamples),
    }
    const transactionMetrics = {
      p50: percentile(transactionSamples, 50),
      p95: percentile(transactionSamples, 95),
      p99: percentile(transactionSamples, 99),
      max: Math.max(...transactionSamples),
    }
    const thresholdsMs = {
      replayP99: 2_000,
      replayAbsolute: 4_000,
      transactionP99: 4_000,
      transactionAbsolute: 4_500,
    }
    const verdict = performanceVerdict(replayMetrics, transactionMetrics, thresholdsMs)
    expect(
      performanceVerdict(
        { p99: thresholdsMs.replayP99, max: thresholdsMs.replayP99 + 1 },
        { p99: thresholdsMs.transactionP99, max: thresholdsMs.transactionP99 },
        thresholdsMs,
      ),
    ).toBe('INCONCLUSIVE')
    expect(
      performanceVerdict(
        { p99: thresholdsMs.replayP99 + 1, max: thresholdsMs.replayP99 + 1 },
        { p99: thresholdsMs.transactionP99, max: thresholdsMs.transactionP99 },
        thresholdsMs,
      ),
    ).toBe('FAIL')
    const performanceReceipt = {
      schemaVersion: 1,
      sourceFingerprint: process.env.COMMERCIAL_QUOTE_V3_SOURCE_FINGERPRINT ?? null,
      sampleSize,
      warmupCount,
      runner: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? 'unknown' },
      quote: { lines: 50, stackStepsPerLine: 10, rules: 100, applied: 500, exclusions: 0 },
      transactionPath: 'FIRST_WRITE_ACCEPTANCE_WITH_AUDIT',
      thresholdsMs,
      replayMs: replayMetrics,
      transactionMs: transactionMetrics,
      verdict,
    }
    console.info('COMMERCIAL_QUOTE_V3_ACCEPTANCE_PERFORMANCE', JSON.stringify(performanceReceipt))
    const performanceEvidencePath = process.env.COMMERCIAL_QUOTE_V3_PERFORMANCE_EVIDENCE_PATH
    if (performanceEvidencePath) {
      if (
        path.basename(performanceEvidencePath) !== 'quote-v3-direct-acceptance-performance-receipt.json' ||
        !/^[0-9a-f]{16}$/.test(performanceReceipt.sourceFingerprint ?? '')
      ) {
        throw new Error('COMMERCIAL_QUOTE_V3_PERFORMANCE_EVIDENCE_TARGET_INVALID')
      }
      writeFileSync(performanceEvidencePath, `${JSON.stringify(performanceReceipt, null, 2)}\n`, 'utf8')
    }
    expect(verdict).toBe('PASS')

    const suspendedAcceptanceQuote = await service.create({ ...input, correlationId: `suspended-acceptance-quote-${suffix}` })
    const expectedAuditFailure = new Error('COMMERCIAL_DIRECT_QUOTE_V3_EXPECTED_AUDIT_FAILURE')
    const rollbackService = createCommercialDirectQuoteV3Service({
      runInTransaction: (operation, options) =>
        prisma.$transaction(async rawTx => {
          const tx = createPrismaCommercialDirectQuoteV3Transaction(rawTx)
          return operation({
            ...tx,
            activityLog: {
              create: async () => {
                throw expectedAuditFailure
              },
            },
          })
        }, options),
      randomId: () => ids.rollbackQuote,
      sleep: async () => undefined,
      retryDelayMilliseconds: () => 0,
    })
    await expect(rollbackService.create(input)).rejects.toBe(expectedAuditFailure)
    await expect(prisma.commercialQuote.count({ where: { id: ids.rollbackQuote } })).resolves.toBe(0)
    await expect(prisma.activityLog.count({ where: { entity: 'CommercialQuote', entityId: ids.rollbackQuote } })).resolves.toBe(0)

    const quotesBeforeSuspension = await prisma.commercialQuote.count({ where: { venueId: ids.venue } })
    const quoteAuditsBeforeSuspension = await prisma.activityLog.count({
      where: { action: 'COMMERCIAL_QUOTE_CREATED', venueId: ids.venue },
    })
    await prisma.commercialOfferControlEvent.create({
      data: {
        offerVersionId: ids.offer,
        offerSchemaVersion: 3,
        revision: 1,
        action: 'SUSPEND_ALL_PENDING',
        reason: 'Direct quote suspension proof',
        confirmedById: ids.staff,
      },
    })
    await expect(service.create(input)).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_PENDING_SUSPENDED' })
    await expect(
      acceptanceService.accept({
        ...acceptanceInput,
        quoteId: suspendedAcceptanceQuote.id,
        idempotencyKey: `suspended-acceptance-${suffix}`,
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_PENDING_SUSPENDED' })
    await expect(prisma.commercialQuoteAcceptance.count({ where: { quoteId: suspendedAcceptanceQuote.id } })).resolves.toBe(0)
    await expect(prisma.commercialQuote.count({ where: { venueId: ids.venue } })).resolves.toBe(quotesBeforeSuspension)
    await expect(prisma.activityLog.count({ where: { action: 'COMMERCIAL_QUOTE_CREATED', venueId: ids.venue } })).resolves.toBe(
      quoteAuditsBeforeSuspension,
    )

    const q3aClassification = await prisma.$transaction(async tx => {
      const [allowed, prohibited, explicit] = await Promise.all([
        countAllowedCommercialOfferV3Q3AReferences(tx),
        countProhibitedCommercialOfferV3Q3AReferences(tx),
        Promise.all([
          tx.commercialOfferControlEvent.count({ where: { offerVersion: { schemaVersion: 3 } } }),
          tx.commercialQuote.count({
            where: {
              schemaVersion: 3,
              offerVersionId: { not: null },
              offerSchemaVersion: 3,
              campaignVersionId: null,
              acquisitionContextId: null,
              organizationId: { not: null },
              venueId: { not: null },
              createdById: { not: null },
              commercialQuotePreviewBridge: { is: null },
            },
          }),
          tx.commercialQuoteAcceptance.count({
            where: {
              quote: {
                schemaVersion: 3,
                offerVersionId: { not: null },
                offerSchemaVersion: 3,
                campaignVersionId: null,
                acquisitionContextId: null,
                organizationId: { not: null },
                venueId: { not: null },
                createdById: { not: null },
                commercialQuotePreviewBridge: { is: null },
              },
            },
          }),
        ]),
      ])
      return { allowed, prohibited, explicit }
    })
    expect(q3aClassification.allowed).toEqual({
      offerControlEvents: q3aClassification.explicit[0],
      directQuotes: q3aClassification.explicit[1],
      directQuoteAcceptances: q3aClassification.explicit[2],
    })
    expect(q3aClassification.allowed.offerControlEvents).toBeGreaterThan(0)
    expect(q3aClassification.allowed.directQuotes).toBeGreaterThan(0)
    expect(q3aClassification.allowed.directQuoteAcceptances).toBeGreaterThan(0)
    expect(q3aClassification.prohibited).toEqual({
      campaignActivations: 0,
      campaignClaims: 0,
      acquisitionContexts: 0,
      legacyCampaignLinkedQuotes: 0,
      invalidOfferQuoteShapes: 0,
      previewBridges: 0,
      stripeOperations: 0,
      subscriptionEvents: 0,
    })
  })
})
