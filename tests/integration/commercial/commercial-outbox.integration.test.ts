import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import catalogFixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import prisma from '@/utils/prismaClient'
import {
  createCommercialOutboxService,
  prismaCommercialOutboxDependencies,
  type CommercialPublicationEventV1,
} from '@/services/commercial/commercialOutbox.service'
import {
  createCommercialOutboxRecoveryService,
  prismaCommercialOutboxRecoveryDependencies,
} from '@/services/commercial/commercialOutboxRecovery.service'
import { createCommercialDraft } from '@/services/commercial/commercialDraft.service'
import {
  createCommercialPublicationService,
  prismaCommercialPublicationDependencies,
} from '@/services/commercial/commercialPublication.service'
import {
  createCommercialActivationService,
  prismaCommercialActivationDependencies,
} from '@/services/commercial/commercialActivation.service'
import { readVerifiedActiveCatalog } from '@/services/commercial/commercialCatalogAuthority.service'
import { commercialReleasePreflightService } from '@/services/commercial/commercialReleasePreflight.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import { buildValidCommercialDraft } from '../../__helpers__/commercialDraft'

const mockStripeSdkInitialization = jest.fn()
const mockCommercialCheckoutEntrypoint = jest.fn()
const mockCommercialGatewayEntrypoint = jest.fn()

jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn((...args: unknown[]) => {
    mockStripeSdkInitialization(...args)
    return {}
  }),
}))
jest.mock('@/services/commercial/commercialStripeCheckoutFacade.service', () => ({
  commercialStripeCheckoutService: { createCheckout: mockCommercialCheckoutEntrypoint },
}))
jest.mock('@/services/commercial/commercialStripeGateway.service', () => ({
  commercialStripeGateway: { createCheckoutSession: mockCommercialGatewayEntrypoint },
}))

const NOW = new Date('2026-08-22T12:00:00.000Z')
const SIGNING_SECRET = 'outbox-integration-secret-that-is-at-least-32-bytes'

function buildDraftInput() {
  const input = buildValidCommercialDraft()
  return {
    name: input.name,
    description: input.description,
    products: input.products,
    pricebooks: input.pricebooks,
    prices: input.prices,
    bundles: input.bundles,
    bundleItems: input.bundleItems,
    featureBindings: input.featureBindings,
  }
}

function payload(input: {
  eventId: string
  publicationId: string
  checksum: string
  type?: CommercialPublicationEventV1['type']
}): Prisma.InputJsonObject {
  return {
    eventId: input.eventId,
    type: input.type ?? 'PUBLICATION_ACTIVATED',
    publicationId: input.publicationId,
    previousPublicationId: null,
    schemaVersion: 1,
    checksum: input.checksum,
    occurredAt: NOW.toISOString(),
  }
}

async function createPublicationFixture(label: string, checksumOverride?: string) {
  const suffix = `${label}_${randomUUID()}`
  const publicationId = `publication_${suffix}`
  const snapshot = {
    ...catalogFixture,
    publicationId,
    publishedAt: NOW.toISOString(),
  } as CommercialCatalogSnapshotV1
  const publicationChecksum = hashCanonicalJsonV1('commercial-catalog-snapshot-v1', snapshot)
  const actor = await prisma.staff.create({
    data: {
      id: `staff_${suffix}`,
      email: `${suffix}@commercial-outbox.example.test`,
      firstName: 'Commercial',
      lastName: 'Outbox',
    },
  })
  const draft = await prisma.commercialDraft.create({
    data: {
      name: `Outbox ${suffix}`,
      createdById: actor.id,
      updatedById: actor.id,
    },
  })
  const publication = await prisma.commercialPublication.create({
    data: {
      id: publicationId,
      sourceDraftId: draft.id,
      sourceRevision: draft.revision,
      schemaVersion: 1,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      checksum: checksumOverride ?? publicationChecksum,
      reason: 'Fixture de integración del outbox comercial',
      publishedById: actor.id,
      publishedAt: NOW,
    },
  })
  return publication
}

async function enqueue(publication: { id: string; checksum: string }, label: string, data: Prisma.InputJsonObject | null = null) {
  const eventId = `${label}:${randomUUID()}`
  return prisma.commercialPublicationOutbox.create({
    data: {
      eventType: 'PUBLICATION_ACTIVATED',
      publicationId: publication.id,
      payloadVersion: 1,
      payload: data ?? payload({ eventId, publicationId: publication.id, checksum: publication.checksum }),
      dedupeKey: eventId,
      nextAttemptAt: NOW,
    },
  })
}

async function enqueueVerifiedActivation(
  publication: { id: string; checksum: string; schemaVersion: number; publishedById: string },
  label: string,
) {
  const eventId = `commercial:activation:1:${publication.id}`
  await prisma.commercialPublicationActivation.create({
    data: {
      environment: 'PRODUCTION',
      publicationId: publication.id,
      revision: 1,
      reason: `Activate ${label} integration fixture`,
      updatedById: publication.publishedById,
    },
  })
  return prisma.commercialPublicationOutbox.create({
    data: {
      eventType: 'PUBLICATION_ACTIVATED',
      publicationId: publication.id,
      previousPublicationId: null,
      payloadVersion: 1,
      payload: payload({ eventId, publicationId: publication.id, checksum: publication.checksum }),
      dedupeKey: eventId,
      nextAttemptAt: NOW,
    },
  })
}

describe('CommercialPublicationOutbox — PostgreSQL claim and recovery', () => {
  beforeEach(async () => {
    // This suite runs against an intentionally reusable synthetic database. The
    // worker is global by design, so stale pending fixtures from another suite
    // would otherwise be the oldest eligible rows and make assertions ambiguous.
    await prisma.commercialPublicationOutbox.deleteMany()
    await prisma.commercialPublicationActivation.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('distributes concurrent claims without overlap and reclaims an expired lease', async () => {
    const publication = await createPublicationFixture('claim')
    const rows = await Promise.all(Array.from({ length: 4 }, (_, index) => enqueue(publication, `claim-${index}`)))
    const expiresAt = new Date(NOW.getTime() + 60_000)

    const [workerA, workerB] = await Promise.all([
      prismaCommercialOutboxDependencies.claim('worker-a', 2, NOW, expiresAt),
      prismaCommercialOutboxDependencies.claim('worker-b', 2, NOW, expiresAt),
    ])

    expect(workerA).toHaveLength(2)
    expect(workerB).toHaveLength(2)
    const claimedIds = [...workerA, ...workerB].map(row => row.id)
    expect(new Set(claimedIds).size).toBe(4)
    expect(new Set(claimedIds)).toEqual(new Set(rows.map(row => row.id)))

    const expired = workerA[0]
    await prisma.commercialPublicationOutbox.update({
      where: { id: expired.id },
      data: { claimExpiresAt: new Date(NOW.getTime() - 1) },
    })
    const reclaimed = await prismaCommercialOutboxDependencies.claim('worker-recovery', 1, NOW, new Date(NOW.getTime() + 120_000))

    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]).toMatchObject({ id: expired.id, attempts: 2 })
  })

  it('persists transient backoff and then acknowledges a retried event with an exact CAS', async () => {
    const publication = await createPublicationFixture('retry')
    const row = await enqueueVerifiedActivation(publication, 'retry')
    const deliver = jest.fn().mockRejectedValueOnce(new Error('temporary transport failure')).mockResolvedValueOnce(undefined)
    const service = createCommercialOutboxService({
      deliver,
      now: () => NOW,
    })

    await expect(service.sweepOnce({ workerId: 'retry-worker', limit: 1 })).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      failed: 1,
    })
    await expect(prisma.commercialPublicationOutbox.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({
      status: 'PENDING',
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + 2_000),
      lastError: 'COMMERCIAL_OUTBOX_DELIVERY_FAILED',
    })

    await prisma.commercialPublicationOutbox.update({ where: { id: row.id }, data: { nextAttemptAt: NOW } })
    await expect(service.sweepOnce({ workerId: 'retry-worker', limit: 1 })).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      failed: 0,
    })
    await expect(prisma.commercialPublicationOutbox.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({
      status: 'DELIVERED',
      attempts: 2,
      claimedBy: null,
      claimExpiresAt: null,
      lastError: null,
    })
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('dead-letters a poison payload in PostgreSQL without delivering it', async () => {
    const publication = await createPublicationFixture('poison')
    const row = await enqueue(publication, 'poison', { unsupported: true })
    const deliver = jest.fn()
    const service = createCommercialOutboxService({ deliver, now: () => NOW })

    await expect(service.sweepOnce({ workerId: 'poison-worker', limit: 1 })).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      failed: 1,
    })
    expect(deliver).not.toHaveBeenCalled()
    await expect(prisma.commercialPublicationOutbox.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({
      status: 'FAILED',
      attempts: 1,
      claimedBy: null,
      claimExpiresAt: null,
      lastError: 'COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED',
    })
  })

  it('inspects and requeues a failed authoritative event without exposing its payload', async () => {
    const publication = await createPublicationFixture('recovery')
    const row = await enqueueVerifiedActivation(publication, 'recovery')
    await prisma.commercialPublicationOutbox.update({
      where: { id: row.id },
      data: {
        status: 'FAILED',
        attempts: 8,
        lastError: 'COMMERCIAL_OUTBOX_DELIVERY_FAILED',
      },
    })
    const service = createCommercialOutboxRecoveryService({
      ...prismaCommercialOutboxRecoveryDependencies,
      now: () => NOW,
    })

    const inspected = await service.getFailed(row.id)
    expect(inspected).toMatchObject({
      id: row.id,
      status: 'FAILED',
      attempts: 8,
      lastErrorCode: 'COMMERCIAL_OUTBOX_DELIVERY_FAILED',
      leaseActive: false,
    })
    expect(inspected).not.toHaveProperty('payload')
    expect(inspected).not.toHaveProperty('lastError')

    await expect(
      service.requeueFailed(
        row.id,
        {
          observedAttempts: 8,
          observedLastErrorCode: 'COMMERCIAL_OUTBOX_DELIVERY_FAILED',
          reason: 'Retry after verifying the current catalog authority',
          confirm: true,
        },
        {
          staffId: publication.publishedById,
          reason: 'Retry after verifying the current catalog authority',
          permissions: ['commercial:publish'],
        },
      ),
    ).resolves.toEqual({ id: row.id, status: 'PENDING', attempts: 0, nextAttemptAt: NOW })

    await expect(prisma.commercialPublicationOutbox.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: NOW,
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
      lastError: null,
    })
    await expect(
      prisma.activityLog.count({
        where: {
          staffId: publication.publishedById,
          action: 'COMMERCIAL_OUTBOX_FAILURE_REQUEUED',
          entity: 'CommercialPublicationOutbox',
          entityId: row.id,
        },
      }),
    ).resolves.toBe(1)
  })

  it('emergency-reactivates the exact historical v1 member after a verified v2 cutover', async () => {
    const historicalPublication = await createPublicationFixture('emergency')
    await enqueueVerifiedActivation(historicalPublication, 'emergency')
    const actor = {
      staffId: historicalPublication.publishedById,
      reason: 'Exercise verified emergency reactivation',
      permissions: ['commercial:publish'],
    }
    const draft = await createCommercialDraft(buildDraftInput(), { staffId: actor.staffId, reason: actor.reason })
    const v2PublicationId = `publication_v2_emergency_${randomUUID()}`
    const publicationService = createCommercialPublicationService({
      ...prismaCommercialPublicationDependencies,
      getActivePublication: async () => null,
      now: () => new Date('2026-08-22T13:00:00.000Z'),
      randomId: () => v2PublicationId,
      signingSecret: SIGNING_SECRET,
    })
    const preview = await publicationService.previewCommercialPublication(draft.id, draft.revision, actor)
    await publicationService.publishCommercialDraft(
      {
        draftId: draft.id,
        expectedRevision: draft.revision,
        previewToken: preview.previewToken,
        checksum: preview.checksum,
        reason: actor.reason,
        confirm: true,
      },
      actor,
    )
    const activationService = createCommercialActivationService({
      ...prismaCommercialActivationDependencies,
      now: () => new Date('2026-08-22T14:00:00.000Z'),
    })

    await expect(
      activationService.activateCommercialPublication(
        {
          publicationId: v2PublicationId,
          expectedActivationRevision: 1,
          reason: 'Activate verified v2 before emergency exercise',
          confirm: true,
        },
        actor,
      ),
    ).resolves.toEqual({
      publicationId: v2PublicationId,
      previousPublicationId: historicalPublication.id,
      revision: 2,
    })
    await expect(
      activationService.emergencyReactivateCommercialPublicationV1(
        {
          publicationId: historicalPublication.id,
          expectedActivationRevision: 2,
          reason: 'Emergency rollback to the proved historical v1 publication',
          confirm: true,
        },
        actor,
      ),
    ).resolves.toEqual({
      publicationId: historicalPublication.id,
      previousPublicationId: v2PublicationId,
      revision: 3,
      emergency: true,
    })
    await expect(prisma.commercialPublicationActivation.findUnique({ where: { environment: 'PRODUCTION' } })).resolves.toMatchObject({
      publicationId: historicalPublication.id,
      revision: 3,
    })
    await expect(
      prisma.commercialPublicationOutbox.findUnique({
        where: { dedupeKey: `commercial:activation:3:${historicalPublication.id}` },
      }),
    ).resolves.toMatchObject({
      eventType: 'PUBLICATION_ROLLED_BACK',
      publicationId: historicalPublication.id,
      previousPublicationId: v2PublicationId,
    })
    await expect(
      prisma.activityLog.count({
        where: {
          staffId: actor.staffId,
          action: 'COMMERCIAL_PUBLICATION_V1_EMERGENCY_REACTIVATED',
          entity: 'CommercialPublicationActivation',
          entityId: 'PRODUCTION',
        },
      }),
    ).resolves.toBe(1)
  })

  it('serves a valid active catalog directly but blocks release when its unused historical row is corrupt', async () => {
    const corruptChecksum = randomUUID().split('-').join('').repeat(2)
    const historical = await createPublicationFixture('preflight-corrupt-history', corruptChecksum)
    const active = await createPublicationFixture('preflight-valid-active')
    const firstDedupe = `commercial:activation:1:${historical.id}`
    const secondDedupe = `commercial:activation:2:${active.id}`
    const firstOccurredAt = new Date('2026-08-22T15:00:00.000Z')
    const secondOccurredAt = new Date('2026-08-22T15:01:00.000Z')

    await prisma.$transaction([
      prisma.commercialPublicationActivation.create({
        data: {
          environment: 'PRODUCTION',
          publicationId: active.id,
          revision: 2,
          reason: 'Synthetic active head with unused corrupt history',
          updatedById: active.publishedById,
        },
      }),
      prisma.commercialPublicationOutbox.create({
        data: {
          eventType: 'PUBLICATION_ACTIVATED',
          publicationId: historical.id,
          previousPublicationId: null,
          payloadVersion: 1,
          payload: {
            eventId: firstDedupe,
            type: 'PUBLICATION_ACTIVATED',
            publicationId: historical.id,
            previousPublicationId: null,
            schemaVersion: 1,
            checksum: historical.checksum,
            occurredAt: firstOccurredAt.toISOString(),
          },
          dedupeKey: firstDedupe,
          nextAttemptAt: NOW,
          createdAt: firstOccurredAt,
        },
      }),
      prisma.commercialPublicationOutbox.create({
        data: {
          eventType: 'PUBLICATION_ACTIVATED',
          publicationId: active.id,
          previousPublicationId: historical.id,
          payloadVersion: 1,
          payload: {
            eventId: secondDedupe,
            type: 'PUBLICATION_ACTIVATED',
            publicationId: active.id,
            previousPublicationId: historical.id,
            schemaVersion: 1,
            checksum: active.checksum,
            occurredAt: secondOccurredAt.toISOString(),
          },
          dedupeKey: secondDedupe,
          nextAttemptAt: NOW,
          createdAt: secondOccurredAt,
        },
      }),
    ])

    await expect(readVerifiedActiveCatalog()).resolves.toMatchObject({
      catalog: { kind: 'CATALOG', schemaVersion: 1, checksum: active.checksum },
      fallback: null,
    })
    await expect(commercialReleasePreflightService.run()).rejects.toMatchObject({
      code: 'COMMERCIAL_RELEASE_PREFLIGHT_FAILED',
      reason: 'CATALOG_HISTORY_AUTHORITY_INVALID',
    })
  })

  it('keeps Stripe SDK, checkout and gateway entrypoints at exactly zero throughout C3 integration flows', () => {
    expect(mockStripeSdkInitialization).toHaveBeenCalledTimes(0)
    expect(mockCommercialCheckoutEntrypoint).toHaveBeenCalledTimes(0)
    expect(mockCommercialGatewayEntrypoint).toHaveBeenCalledTimes(0)
  })
})
