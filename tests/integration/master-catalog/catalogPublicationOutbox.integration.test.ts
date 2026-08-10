/** Prepared PostgreSQL proof for venue-ordered, at-least-once outbox delivery. */
import type { CatalogCommandContext } from '@/types/master-catalog'
import {
  assertDisposableCatalogPublicationDatabase,
  cleanupCatalogPublicationFixture,
  createCatalogPublicationFixture,
  createCatalogPublicationIntegrationHarness,
  type CatalogPublicationFixture,
  type CatalogPublicationIntegrationHarness,
} from './catalogPublicationIntegrationHarness'

jest.unmock('@/utils/prismaClient')
jest.unmock('@/services/master-catalog/catalogAudit.service')
jest.setTimeout(60_000)

let harness: CatalogPublicationIntegrationHarness | null = null
const fixtures: CatalogPublicationFixture[] = []
let createPreview: typeof import('@/services/master-catalog/catalogPublicationPreview.service').createCatalogPublicationPreviewService
let createConfirmation: typeof import('@/services/master-catalog/catalogPublicationConfirmation.service').createCatalogPublicationConfirmationService
let createOutbox: typeof import('@/services/master-catalog/catalogPublicationOutbox.service').createCatalogPublicationOutboxService

function h(): CatalogPublicationIntegrationHarness {
  if (!harness) throw new Error('Outbox harness was not initialized')
  return harness
}

function context(fixture: CatalogPublicationFixture): CatalogCommandContext {
  return {
    organizationId: fixture.organizationId,
    actor: { type: 'HUMAN', staffId: fixture.staffId, impersonating: false },
    orgRole: 'OWNER',
  }
}

async function publish(fixture: CatalogPublicationFixture, suffix: string): Promise<string> {
  const key = `outbox-${suffix}-${fixture.key}`
  const preview = await createPreview({ prisma: h().primary as never }).preview(context(fixture), {
    operation: 'CATALOG_FIELDS_PUBLISH',
    idempotencyKey: key,
    targets: [{ catalogItemId: fixture.catalogItemId, venueId: fixture.venueId, productId: fixture.productId }],
  })
  await createConfirmation({ prisma: h().primary as never }).confirm(context(fixture), {
    publicationBatchId: preview.publicationBatchId,
    previewToken: preview.previewToken,
    idempotencyKey: key,
    confirm: true,
  })
  return preview.publicationBatchId
}

beforeAll(async () => {
  assertDisposableCatalogPublicationDatabase()
  harness = await createCatalogPublicationIntegrationHarness('outbox')
  ;({ createCatalogPublicationPreviewService: createPreview } = await import('@/services/master-catalog/catalogPublicationPreview.service'))
  ;({ createCatalogPublicationConfirmationService: createConfirmation } = await import(
    '@/services/master-catalog/catalogPublicationConfirmation.service'
  ))
  ;({ createCatalogPublicationOutboxService: createOutbox } = await import('@/services/master-catalog/catalogPublicationOutbox.service'))
  // WHY: Focused reruns share this disposable database. Quarantine only stale global-worker residue before creating this suite's fixtures.
  await h().primary.catalogPublicationOutbox.updateMany({
    where: { status: 'PENDING' },
    data: { nextAttemptAt: new Date('2200-01-01T00:00:00.000Z') },
  })
})

afterAll(async () => {
  try {
    if (harness) {
      for (const fixture of fixtures) await cleanupCatalogPublicationFixture(harness.primary, fixture)
    }
  } finally {
    await harness?.disconnect()
  }
})

async function newFixture(suffix: string): Promise<CatalogPublicationFixture> {
  const fixture = await createCatalogPublicationFixture(h().primary, `outbox-${suffix}`)
  fixtures.push(fixture)
  return fixture
}

describe('CatalogPublicationOutbox — real claim and CAS', () => {
  it('delivers one venue strictly by durable sequence even when claim limit is larger', async () => {
    const fixture = await newFixture('ordering')
    const firstBatch = await publish(fixture, 'first')
    const secondBatch = await publish(fixture, 'second')
    const emitted: Array<{ eventId: string; venueSequence: string }> = []
    const sweepAt = new Date(Date.now() + 60_000)
    const outbox = createOutbox({
      prisma: h().primary as never,
      emit: async event => {
        emitted.push({ eventId: event.eventId, venueSequence: event.venueSequence })
      },
      now: () => sweepAt,
    })

    const pending = await h().primary.catalogPublicationOutbox.findMany({
      where: { organizationId: fixture.organizationId, venueId: fixture.venueId },
      select: { batchId: true, status: true, nextAttemptAt: true, claimExpiresAt: true, venueSequence: true },
      orderBy: { venueSequence: 'asc' },
    })
    expect(pending.map(row => ({ ...row, nextAttemptAt: row.nextAttemptAt.getTime() <= sweepAt.getTime() }))).toEqual([
      { batchId: firstBatch, status: 'PENDING', nextAttemptAt: true, claimExpiresAt: null, venueSequence: 1n },
      { batchId: secondBatch, status: 'PENDING', nextAttemptAt: true, claimExpiresAt: null, venueSequence: 2n },
    ])

    await expect(outbox.sweepOnce({ workerId: 'ordered-worker', limit: 100 })).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      failed: 0,
    })
    await expect(outbox.sweepOnce({ workerId: 'ordered-worker', limit: 100 })).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      failed: 0,
    })
    expect(emitted.map(event => event.venueSequence)).toEqual(['1', '2'])
    expect(
      await h().primary.catalogPublicationOutbox.findMany({
        where: { batchId: { in: [firstBatch, secondBatch] } },
        select: { status: true, claimedBy: true, venueSequence: true },
        orderBy: { venueSequence: 'asc' },
      }),
    ).toEqual([
      { status: 'DELIVERED', claimedBy: null, venueSequence: 1n },
      { status: 'DELIVERED', claimedBy: null, venueSequence: 2n },
    ])
  })

  it('lets two workers race one row but only one claim and acknowledge it', async () => {
    const fixture = await newFixture('claim-race')
    await publish(fixture, 'only')
    const emitted: string[] = []
    const now = new Date(Date.now() + 60_000)
    let deliveryStarted!: () => void
    let releaseDelivery!: () => void
    const claimedLeaseVisible = new Promise<void>(resolve => (deliveryStarted = resolve))
    const deliveryReleased = new Promise<void>(resolve => (releaseDelivery = resolve))
    const first = createOutbox({
      prisma: h().writerOne as never,
      emit: async event => {
        emitted.push(event.eventId)
        deliveryStarted()
        await deliveryReleased
      },
      now: () => now,
    })
    const second = createOutbox({
      prisma: h().writerTwo as never,
      emit: async event => {
        emitted.push(event.eventId)
      },
      now: () => now,
    })

    const firstSweep = first.sweepOnce({ workerId: 'worker-a', limit: 1 })
    await claimedLeaseVisible
    // WHY: emit runs after the claim transaction committed. Holding it here
    // proves the second pool sees the live lease and cannot claim the same row.
    try {
      await expect(second.sweepOnce({ workerId: 'worker-b', limit: 1 })).resolves.toEqual({
        claimed: 0,
        delivered: 0,
        failed: 0,
      })
    } finally {
      releaseDelivery()
    }
    await expect(firstSweep).resolves.toEqual({ claimed: 1, delivered: 1, failed: 0 })
    expect(emitted).toHaveLength(1)
  })

  it('keeps APPLIED durable when delivery fails, then retries the same eventId', async () => {
    const fixture = await newFixture('retry')
    const batchId = await publish(fixture, 'retry')
    const emitted: string[] = []
    let fail = true
    const now = new Date(Date.now() + 60_000)
    const outbox = createOutbox({
      prisma: h().primary as never,
      emit: async event => {
        emitted.push(event.eventId)
        if (fail) throw new Error('socket unavailable with secret details')
      },
      now: () => now,
    })

    await expect(outbox.sweepOnce({ workerId: 'retry-worker', limit: 1 })).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      failed: 1,
    })
    const failed = await h().primary.catalogPublicationOutbox.findFirstOrThrow({ where: { batchId } })
    expect(failed).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'Error' })
    expect(await h().primary.catalogPublicationBatch.findUniqueOrThrow({ where: { id: batchId } })).toMatchObject({ state: 'APPLIED' })
    await h().primary.catalogPublicationOutbox.update({ where: { id: failed.id }, data: { nextAttemptAt: now } })
    fail = false
    await expect(outbox.sweepOnce({ workerId: 'retry-worker', limit: 1 })).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      failed: 0,
    })
    expect(emitted).toEqual([failed.id, failed.id])
  })

  it('dead-letters a future payload version without invoking a broadcaster', async () => {
    const fixture = await newFixture('future-payload')
    const batchId = await publish(fixture, 'future')
    const row = await h().primary.catalogPublicationOutbox.findFirstOrThrow({ where: { batchId } })
    await h().primary.catalogPublicationOutbox.update({
      where: { id: row.id },
      data: { payloadVersion: 2, attempts: 7, nextAttemptAt: new Date(Date.now() + 30_000) },
    })
    const emit = jest.fn()
    const outbox = createOutbox({
      prisma: h().primary as never,
      emit,
      now: () => new Date(Date.now() + 60_000),
    })

    await expect(outbox.sweepOnce({ workerId: 'future-worker', limit: 1 })).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      failed: 1,
    })
    expect(emit).not.toHaveBeenCalled()
    await expect(h().primary.catalogPublicationOutbox.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({
      status: 'DEAD_LETTER',
      attempts: 8,
      claimedBy: null,
      lastError: 'Error',
    })
  })
})
