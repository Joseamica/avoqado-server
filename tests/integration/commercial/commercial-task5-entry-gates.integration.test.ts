import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { createCommercialActivationService, prismaCommercialActivationDependencies } from '@/services/commercial/commercialActivation.service'
import { commercialCampaignDraftService } from '@/services/commercial/commercialCampaignDraft.service'
import { createCommercialDraft } from '@/services/commercial/commercialDraft.service'
import { buildInitialCommercialDraftV1 } from '@/services/commercial/commercialInitialCatalog'
import {
  createCommercialPublicationService,
  prismaCommercialPublicationDependencies,
} from '@/services/commercial/commercialPublication.service'
import { validateCommercialCatalogOfferCompatibilityV3 } from '@/services/commercial/offers/commercialCatalogOfferCompatibility.service'
import {
  COMMERCIAL_OFFER_V3_ELIGIBILITY_SQL,
  assertCommercialOfferEligibilitySnapshotUnchangedV3,
  loadEligibleCommercialOffersV3,
  prepareEligibleCommercialOffersV3,
} from '@/services/commercial/offers/commercialOfferEligibility.service'
import { commercialOfferDraftService } from '@/services/commercial/offers/commercialOfferDraft.service'
import { commercialOfferPublicationService } from '@/services/commercial/offers/commercialOfferPublication.service'
import { createCommercialEligibleOfferWriterSnapshotRunner } from '@/services/commercial/offers/commercialEligibleOfferWriterSnapshot.service'
import {
  COMMERCIAL_WRITER_ADVISORY_LOCK_KEY,
  createCommercialWriterTransactionRunner,
  type CommercialWriterTransactionRunner,
} from '@/services/commercial/commercialWriterTransaction.service'
import type { CommercialCatalogSnapshotV2, CommercialCampaignRuleV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'

const fixtureKey = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`
const staffId = `commercial_task5_staff_${fixtureKey}`
const draftId = `commercial_task5_draft_${fixtureKey}`
const campaignCode = `TASK5_${fixtureKey.replace(/[^A-Za-z0-9]/g, '').slice(-24).toUpperCase()}`
const eligibilityNow = new Date('2098-06-01T00:00:00.000Z')
const eligibilityIndexName = 'CommercialCampaignVersion_offer_v3_eligibility_idx'
const publisher = {
  staffId,
  reason: 'Disposable Task 5 entry-gate proof',
  permissions: ['commercial:publish'],
}

let writerOne: PrismaClient
let writerTwo: PrismaClient
let blocker: PrismaClient
let observer: PrismaClient

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function disposableDatabaseUrl(applicationName: string): string {
  const raw = process.env.TEST_DATABASE_URL
  if (!raw?.trim()) throw new Error('COMMERCIAL_TASK5_TEST_DATABASE_URL_REQUIRED')
  const parsed = new URL(raw)
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !/test/i.test(parsed.pathname)) {
    throw new Error('COMMERCIAL_TASK5_DISPOSABLE_DATABASE_REQUIRED')
  }
  parsed.searchParams.set('application_name', applicationName)
  return parsed.toString()
}

function client(applicationName: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: disposableDatabaseUrl(applicationName) } } })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function waitForAdvisoryWaiter(applicationName: string): Promise<void> {
  const deadline = Date.now() + 3_000
  let observed: Array<{ waitEventType: string | null; waitEvent: string | null; query: string }> = []
  while (Date.now() < deadline) {
    observed = await observer.$queryRawUnsafe(
      `SELECT wait_event_type AS "waitEventType", wait_event AS "waitEvent", query
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = $1
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'
         AND query LIKE '%pg_advisory_xact_lock%'`,
      applicationName,
    )
    if (observed.length > 0) return
    await delay(10)
  }
  throw new Error(`COMMERCIAL_TASK5_ADVISORY_WAITER_NOT_OBSERVED:${JSON.stringify(observed)}`)
}

function offerSource(index: number): CommercialOfferSnapshotV3 {
  const source = clone(offerFixture) as CommercialOfferSnapshotV3
  const claimStartsAt = '2098-01-01T00:00:00.000Z'
  const claimEndsAt = new Date(Date.UTC(2099, 0, index + 1)).toISOString()
  source.campaignVersionId = `commercial_task5_offer_${fixtureKey}_${String(index).padStart(2, '0')}`
  source.campaignCode = campaignCode
  source.version = index + 1
  source.publishedAt = '2098-01-01T00:00:00.000Z'
  source.claimStartsAt = claimStartsAt
  source.claimEndsAt = claimEndsAt
  for (const benefit of source.benefits) {
    if (benefit.kind === 'HARDWARE_FIXED_PRICE' || benefit.kind === 'HARDWARE_PERCENT_OFF') {
      benefit.benefitStartsAt = claimStartsAt
      benefit.benefitEndsAt = claimEndsAt
    }
  }
  return source
}

function controlledEligibilityReader(
  client: PrismaClient,
  afterRead: (readNumber: number) => Promise<void>,
) {
  let readNumber = 0
  return {
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
      const rows = await client.$queryRawUnsafe<T>(query, ...values)
      readNumber += 1
      await afterRead(readNumber)
      return rows
    },
  }
}

async function publishOffer(
  index: number,
  rules?: readonly CommercialCampaignRuleV2[],
  windowYear = 2098,
): Promise<string> {
  const suffix = fixtureKey.replace(/[^A-Za-z0-9]/g, '').slice(-16).toUpperCase()
  const code = `TASK5_OFFER_${String(index).padStart(2, '0')}_${suffix}`
  const claimStartsAt = `${windowYear}-01-01T00:00:00.000Z`
  const claimEndsAt =
    windowYear === 2098
      ? new Date(Date.UTC(2099, 0, index + 1)).toISOString()
      : `${windowYear}-12-31T23:59:59.999Z`
  const draft = await commercialCampaignDraftService.createDraft(
    {
      code,
      name: `Task 5 eligibility offer ${index}`,
      startsAt: claimStartsAt,
      endsAt: claimEndsAt,
      stackingGroups: [],
      rules: rules
        ? clone(rules)
        : [
            {
              code: 'POS_PERCENT_1',
              type: 'PERCENT_OFF',
              priority: 100,
              target: { productCodes: ['POS'] },
              percentBasisPoints: 1,
              cycles: 1,
            },
          ],
    },
    { staffId, reason: publisher.reason },
  )
  const promoted = await commercialOfferDraftService.promoteDraft(draft.id, [], draft.revision, {
    staffId,
    reason: publisher.reason,
  })
  const published = await commercialOfferPublicationService.publish(
    {
      draftId: draft.id,
      expectedDraftRevision: promoted.revision,
      reason: publisher.reason,
      confirm: true,
    },
    publisher,
  )
  return published.snapshot.campaignVersionId
}

function percentile95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right)
  return ordered[Math.ceil(ordered.length * 0.95) - 1]
}

function worstCaseCatalog(): CommercialCatalogSnapshotV2 {
  const catalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
  const template = clone(catalog.products[0])
  catalog.publicationId = `commercial-task5-benchmark-${fixtureKey}`
  catalog.products = Array.from({ length: 500 }, (_, index) => ({
    ...clone(template),
    code: `TASK5_PLAN_${String(index).padStart(3, '0')}`,
    slug: `task5-plan-${String(index).padStart(3, '0')}`,
    name: `Task 5 plan ${index}`,
    sortOrder: index,
    prices: [
      {
        ...clone(template.prices[0]),
        code: `TASK5_PRICE_${String(index).padStart(3, '0')}`,
      },
    ],
  }))
  catalog.bundles = []
  return catalog
}

function worstCaseOffers(): CommercialOfferSnapshotV3[] {
  const productCodes = Array.from({ length: 500 }, (_, index) => `TASK5_PLAN_${String(index).padStart(3, '0')}`)
  const signatures: number[][] = []
  for (let first = 0; first < 5; first += 1) {
    for (let second = 0; second < 5; second += 1) {
      for (let third = 0; third < 5; third += 1) {
        for (let fourth = 0; fourth < 5; fourth += 1) {
          if ((first + second + third + fourth) % 5 !== 0) signatures.push([first, second, third, fourth])
        }
      }
    }
  }
  if (signatures.length !== productCodes.length) throw new Error('COMMERCIAL_TASK5_SIGNATURE_FIXTURE_INVALID')
  const targetsByRule = Array.from({ length: 100 }, () => [] as string[])
  signatures.forEach((signature, identityIndex) => {
    signature.forEach((value, groupIndex) => targetsByRule[groupIndex * 5 + value].push(productCodes[identityIndex]))
  })

  return Array.from({ length: 32 }, (_, offerIndex) => {
    const offer = offerSource(offerIndex)
    const benefit = offer.benefits.find(item => item.kind === 'SAAS_PRICE')
    if (!benefit || benefit.kind !== 'SAAS_PRICE') throw new Error('COMMERCIAL_TASK5_SAAS_BENEFIT_REQUIRED')
    benefit.stackingGroups = []
    benefit.rules = Array.from({ length: 100 }, (_, ruleIndex): CommercialCampaignRuleV2 => ({
      code: `TASK5_RULE_${String(ruleIndex).padStart(3, '0')}`,
      type: 'PERCENT_OFF',
      priority: 100 - ruleIndex,
      target: {
        productCodes: (targetsByRule[ruleIndex].length > 0
          ? targetsByRule[ruleIndex]
          : [`TASK5_UNMATCHED_${String(ruleIndex).padStart(3, '0')}`]) as [string, ...string[]],
      },
      percentBasisPoints: 1,
      cycles: 1,
    }))
    return offer
  })
}

describe('Commercial Task 5 entry gates on disposable PostgreSQL', () => {
  beforeAll(async () => {
    writerOne = client(`commercial-task5-writer-one-${fixtureKey}`)
    writerTwo = client(`commercial-task5-writer-two-${fixtureKey}`)
    blocker = client(`commercial-task5-blocker-${fixtureKey}`)
    observer = client(`commercial-task5-observer-${fixtureKey}`)
    await writerOne.staff.create({
      data: {
        id: staffId,
        email: `${staffId}@example.test`,
        firstName: 'Commercial',
        lastName: 'Task Five',
      },
    })
    await writerOne.commercialCampaignDraft.create({
      data: {
        id: draftId,
        code: campaignCode,
        name: 'Task 5 disposable eligibility fixture',
        status: 'ACTIVE',
        revision: 33,
        offerSchemaVersion: 3,
        allowedRuleCodeGroups: Prisma.DbNull,
        stackingGroups: [],
        startsAt: new Date('2098-01-01T00:00:00.000Z'),
        endsAt: new Date('2100-01-01T00:00:00.000Z'),
        createdById: staffId,
        updatedById: staffId,
      },
    })
    const initialCatalog = buildInitialCommercialDraftV1()
    const catalogDraft = await createCommercialDraft(initialCatalog.draft, { staffId, reason: publisher.reason })
    const publicationService = createCommercialPublicationService({
      ...prismaCommercialPublicationDependencies,
      now: () => new Date('2097-12-31T23:58:00.000Z'),
      randomId: () => `commercial_task5_catalog_${fixtureKey}`,
    })
    const preview = await publicationService.previewCommercialPublication(catalogDraft.id, catalogDraft.revision, publisher)
    const publication = await publicationService.publishCommercialDraft(
      {
        draftId: catalogDraft.id,
        expectedRevision: catalogDraft.revision,
        previewToken: preview.previewToken,
        checksum: preview.checksum,
        reason: publisher.reason,
        confirm: true,
      },
      publisher,
    )
    const activationService = createCommercialActivationService({
      ...prismaCommercialActivationDependencies,
      now: () => new Date('2097-12-31T23:59:00.000Z'),
    })
    await activationService.activateCommercialPublication(
      {
        publicationId: publication.id,
        expectedActivationRevision: 0,
        reason: publisher.reason,
        confirm: true,
      },
      publisher,
    )
  })

  afterAll(async () => {
    await Promise.all([writerOne.$disconnect(), writerTwo.$disconnect(), blocker.$disconnect(), observer.$disconnect()])
  })

  it('serializes compatible operations through the real transaction-scoped advisory lock', async () => {
    const firstRunner = createCommercialWriterTransactionRunner({ host: writerOne })
    const secondRunner = createCommercialWriterTransactionRunner({ host: writerTwo })
    const events: string[] = []
    let firstEntered!: () => void
    let releaseFirst!: () => void
    const entered = new Promise<void>(resolve => (firstEntered = resolve))
    const release = new Promise<void>(resolve => (releaseFirst = resolve))

    const first = firstRunner.run(async () => {
      events.push('first:start')
      firstEntered()
      await release
      events.push('first:end')
      return 'first'
    })
    await entered
    const second = secondRunner.run(async () => {
      events.push('second:start')
      events.push('second:end')
      return 'second'
    })

    await waitForAdvisoryWaiter(`commercial-task5-writer-two-${fixtureKey}`)
    expect(events).toEqual(['first:start'])
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('pins READ COMMITTED even when the database session default is REPEATABLE READ', async () => {
    const raw = disposableDatabaseUrl(`commercial-task5-isolation-${fixtureKey}`)
    const parsed = new URL(raw)
    parsed.searchParams.set('connection_limit', '1')
    const isolationClient = new PrismaClient({ datasources: { db: { url: parsed.toString() } } })
    try {
      await isolationClient.$executeRawUnsafe('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      const runner = createCommercialWriterTransactionRunner({ host: isolationClient })

      await expect(
        runner.run(async tx => {
          const rows = await tx.$queryRawUnsafe<Array<{ transactionIsolation: string }>>(
            'SELECT current_setting(\'transaction_isolation\') AS "transactionIsolation"',
          )
          return rows[0]?.transactionIsolation
        }),
      ).resolves.toBe('read committed')
    } finally {
      await isolationClient.$disconnect()
    }
  })

  it('allows only one incompatible compare-and-set writer to confirm after serialization', async () => {
    const firstRunner = createCommercialWriterTransactionRunner({ host: writerOne })
    const secondRunner = createCommercialWriterTransactionRunner({ host: writerTwo })
    const confirm = (runner: CommercialWriterTransactionRunner<Prisma.TransactionClient>) =>
      runner.run(async tx => {
        const changed = await tx.commercialCampaignDraft.updateMany({
          where: { id: draftId, revision: 33 },
          data: { revision: 34 },
        })
        if (changed.count !== 1) throw new Error('COMMERCIAL_TASK5_EXPECTED_REVISION_CONFLICT')
        return 'confirmed'
      })

    const outcomes = await Promise.allSettled([confirm(firstRunner), confirm(secondRunner)])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: 'COMMERCIAL_TASK5_EXPECTED_REVISION_CONFLICT' }),
    })
    await expect(writerOne.commercialCampaignDraft.findUniqueOrThrow({ where: { id: draftId } })).resolves.toMatchObject({
      revision: 34,
    })
  })

  it('releases the real advisory lock on rollback so the next writer can commit', async () => {
    const firstRunner = createCommercialWriterTransactionRunner({ host: writerOne })
    const secondRunner = createCommercialWriterTransactionRunner({ host: writerTwo })
    const rollback = new Error('TASK5_EXPECTED_ROLLBACK')

    await expect(firstRunner.run(async () => Promise.reject(rollback))).rejects.toBe(rollback)
    await expect(secondRunner.run(async () => 'committed-after-rollback')).resolves.toBe('committed-after-rollback')
  })

  it('returns the stable retryable 409 after two real PostgreSQL lock timeouts', async () => {
    const runner = createCommercialWriterTransactionRunner({ host: writerOne, sleep: async () => undefined, random: () => 0 })
    let lockHeld!: () => void
    let releaseBlocker!: () => void
    const held = new Promise<void>(resolve => (lockHeld = resolve))
    const release = new Promise<void>(resolve => (releaseBlocker = resolve))
    const blockingTransaction = blocker.$transaction(
      async tx => {
        await tx.$queryRawUnsafe(
          'SELECT pg_advisory_xact_lock($1::bigint)::text AS lock_result',
          COMMERCIAL_WRITER_ADVISORY_LOCK_KEY.toString(),
        )
        lockHeld()
        await release
      },
      { timeout: 10_000 },
    )
    await held

    try {
      await expect(runner.run(async () => 'must-not-run')).rejects.toMatchObject({
        statusCode: 409,
        code: 'COMMERCIAL_WRITER_LOCK_TIMEOUT',
        details: { retryable: true, attempts: 2 },
      })
    } finally {
      releaseBlocker()
      await blockingTransaction
    }
  })

  it('reprepares once after real PostgreSQL eligibility drift and runs domain work only with the refreshed snapshot', async () => {
    const now = new Date('2096-06-01T00:00:00.000Z')
    const serialized = createCommercialWriterTransactionRunner({ host: writerOne })
    let firstPrepared!: () => void
    let releaseFirstPreparation!: () => void
    const prepared = new Promise<void>(resolve => (firstPrepared = resolve))
    const release = new Promise<void>(resolve => (releaseFirstPreparation = resolve))
    let preparationReads = 0
    let domainCalls = 0

    const runner = createCommercialEligibleOfferWriterSnapshotRunner<Prisma.TransactionClient>({
      reader: controlledEligibilityReader(writerOne, async readNumber => {
        preparationReads += 1
        if (readNumber !== 1) return
        firstPrepared()
        await release
      }),
      runSerialized: operation => serialized.run(operation),
    })
    const result = runner.run(now, async (_tx, offers) => {
      domainCalls += 1
      return offers.map(offer => offer.snapshot.campaignVersionId)
    })

    await prepared
    const insertedId = await publishOffer(101, undefined, 2096)
    releaseFirstPreparation()

    await expect(result).resolves.toEqual([insertedId])
    expect(preparationReads).toBe(2)
    expect(domainCalls).toBe(1)
  })

  it('returns the stable retryable 409 before domain work after two real PostgreSQL eligibility drifts', async () => {
    const now = new Date('2097-06-01T00:00:00.000Z')
    const serialized = createCommercialWriterTransactionRunner({ host: writerOne })
    let firstPrepared!: () => void
    let releaseFirstPreparation!: () => void
    let secondPrepared!: () => void
    let releaseSecondPreparation!: () => void
    const firstReady = new Promise<void>(resolve => (firstPrepared = resolve))
    const firstRelease = new Promise<void>(resolve => (releaseFirstPreparation = resolve))
    const secondReady = new Promise<void>(resolve => (secondPrepared = resolve))
    const secondRelease = new Promise<void>(resolve => (releaseSecondPreparation = resolve))
    let preparationReads = 0
    let domainCalls = 0

    const runner = createCommercialEligibleOfferWriterSnapshotRunner<Prisma.TransactionClient>({
      reader: controlledEligibilityReader(writerOne, async readNumber => {
        preparationReads += 1
        if (readNumber === 1) {
          firstPrepared()
          await firstRelease
        } else if (readNumber === 2) {
          secondPrepared()
          await secondRelease
        }
      }),
      runSerialized: operation => serialized.run(operation),
    })
    const result = runner.run(now, async () => {
      domainCalls += 1
      return 'must-not-run'
    })
    await firstReady
    await publishOffer(201, undefined, 2097)
    releaseFirstPreparation()
    await secondReady
    await publishOffer(202, undefined, 2097)
    releaseSecondPreparation()

    await expect(result).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_OFFER_ELIGIBILITY_CHANGED',
      details: { retryable: true, attempts: 2 },
    })
    expect(preparationReads).toBe(2)
    expect(domainCalls).toBe(0)
  })

  it('uses the partial eligibility index and verifies all 32 eligible rows', async () => {
    const benchmarkOffers = worstCaseOffers()
    for (let index = 0; index < 32; index += 1) {
      const benefit = benchmarkOffers[index].benefits.find(item => item.kind === 'SAAS_PRICE')
      if (!benefit || benefit.kind !== 'SAAS_PRICE') throw new Error('COMMERCIAL_TASK5_SAAS_BENEFIT_REQUIRED')
      await publishOffer(index, benefit.rules)
    }

    const eligible = await loadEligibleCommercialOffersV3(writerOne, eligibilityNow)
    expect(eligible).toHaveLength(32)
    expect(eligible.every(offer => offer.verified && offer.snapshot.status === 'ACTIVE')).toBe(true)

    const explain = await writerOne.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
      return tx.$queryRawUnsafe(
        `EXPLAIN (FORMAT JSON) ${COMMERCIAL_OFFER_V3_ELIGIBILITY_SQL.replace(/;\s*$/, '')}`,
        eligibilityNow.toISOString(),
      )
    })
    expect(JSON.stringify(explain)).toContain(eligibilityIndexName)

  })

  it('keeps fingerprint verification plus the 500-by-32 validation path at p95 no greater than 500 ms under the lock', async () => {
    const runner = createCommercialWriterTransactionRunner({ host: writerOne })
    const catalog = worstCaseCatalog()
    const samples: number[] = []
    const fingerprintSamples: number[] = []
    const compatibilitySamples: number[] = []

    for (let sample = 0; sample < 20; sample += 1) {
      const prepared = await prepareEligibleCommercialOffersV3(writerOne, eligibilityNow)
      const duration = await runner.run(async tx => {
        const startedAt = performance.now()
        await assertCommercialOfferEligibilitySnapshotUnchangedV3(tx, prepared)
        const fingerprintFinishedAt = performance.now()
        expect(prepared.offers).toHaveLength(32)
        for (const eligibleOffer of prepared.offers) {
          validateCommercialCatalogOfferCompatibilityV3({
            catalog,
            offer: eligibleOffer.snapshot,
            resolvedAt: '2098-06-01T00:00:00.000Z',
          })
        }
        const compatibilityFinishedAt = performance.now()
        fingerprintSamples.push(fingerprintFinishedAt - startedAt)
        compatibilitySamples.push(compatibilityFinishedAt - fingerprintFinishedAt)
        return compatibilityFinishedAt - startedAt
      })
      samples.push(duration)
    }

    const p95 = percentile95(samples)
    console.info(
      `Commercial Task 5 pair validation p95=${p95.toFixed(2)}ms fingerprintP95=${percentile95(fingerprintSamples).toFixed(2)}ms compatibilityP95=${percentile95(compatibilitySamples).toFixed(2)}ms samples=${samples.length}`,
    )
    expect(p95).toBeLessThanOrEqual(500)
  })

  it('fails closed on eligible row 33; observability is covered by the focused unit boundary', async () => {
    await publishOffer(32)
    await expect(loadEligibleCommercialOffersV3(writerOne, eligibilityNow)).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED',
    })
  })
})
