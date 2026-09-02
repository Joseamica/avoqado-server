import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { getSocketManager } from '@/communication/sockets'
import { decodeAndVerifyCommercialArtifact } from './commercialArtifactCodecRegistry.service'
import { CommercialArtifactCodecError } from './commercialArtifactCodecRegistry.service'
import { catalogDecodeInput, verifyFutureCatalogRow } from './commercialCatalogFallbackBoundary.service'
import { invalidateCommercialCatalogCache } from './commercialRead.service'
import {
  verifyCommercialCatalogActivationChain,
  type CommercialCatalogAuthorityChainDecision,
  type CommercialCatalogAuthorityPointer,
} from './commercialCatalogAuthority.service'
import type { CommercialCatalogActivationOutboxRecord, CommercialCatalogPersistedRow } from '@/types/commercialCodec'

const MAX_CLAIM = 100
const CLAIM_LEASE_MS = 60_000
const MAX_ATTEMPTS = 8
const PAYLOAD_KEYS = ['eventId', 'type', 'publicationId', 'previousPublicationId', 'schemaVersion', 'checksum', 'occurredAt'] as const

export type CommercialPublicationEventTypeV1 = 'PUBLICATION_CREATED' | 'PUBLICATION_ACTIVATED' | 'PUBLICATION_ROLLED_BACK'

export interface CommercialPublicationEventV1 {
  eventId: string
  type: CommercialPublicationEventTypeV1
  publicationId: string
  previousPublicationId: string | null
  schemaVersion: number
  checksum: string
  occurredAt: string
}

export interface ClaimedCommercialOutboxRow {
  id: string
  eventType: CommercialPublicationEventTypeV1
  publicationId: string
  previousPublicationId: string | null
  payloadVersion: number
  payload: unknown
  dedupeKey: string
  attempts: number
  claimExpiresAt: Date
}

export interface CommercialOutboxActivationGraph {
  pointer: CommercialCatalogAuthorityPointer | null
  activationEvents: readonly CommercialCatalogActivationOutboxRecord[]
}

export interface CommercialOutboxHead {
  publicationId: string
  schemaVersion: number
  checksum: string
}

export interface CommercialOutboxClaimedRevisionDecision {
  publication: CommercialCatalogPersistedRow
  head: CommercialOutboxHead
}

export interface CommercialOutboxDependencies {
  claim(workerId: string, limit: number, claimedAt: Date, claimExpiresAt: Date): Promise<ClaimedCommercialOutboxRow[]>
  loadActivationGraph(): Promise<CommercialOutboxActivationGraph>
  proveActivationChain(graph: CommercialOutboxActivationGraph): CommercialCatalogAuthorityChainDecision
  verifyClaimedRevision(input: {
    row: ClaimedCommercialOutboxRow
    event: CommercialPublicationEventV1
    graph: CommercialOutboxActivationGraph
    decision: CommercialCatalogAuthorityChainDecision
    eventsByRevision: ReadonlyMap<number, CommercialCatalogActivationOutboxRecord>
  }): CommercialOutboxClaimedRevisionDecision
  loadPublication(publicationId: string): Promise<CommercialCatalogPersistedRow | null>
  verifyPublication(publication: CommercialCatalogPersistedRow): void
  verifyFuturePublication(publication: CommercialCatalogPersistedRow): void
  deliver(input: { event: CommercialPublicationEventV1; head: CommercialOutboxHead }): Promise<void>
  telemetry(event: CommercialPublicationEventV1): Promise<void>
  alertFutureSchema(event: CommercialPublicationEventV1): Promise<void>
  acknowledge(row: ClaimedCommercialOutboxRow, workerId: string, deliveredAt: Date): Promise<boolean>
  fail(
    row: ClaimedCommercialOutboxRow,
    workerId: string,
    input: { terminal: boolean; nextAttemptAt: Date; lastError: string },
  ): Promise<void>
  now(): Date
}

function exactObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseCommercialPublicationOutboxEvent(row: ClaimedCommercialOutboxRow): CommercialPublicationEventV1 {
  if (row.payloadVersion !== 1 || !exactObject(row.payload)) throw new Error('COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED')
  if (
    Object.keys(row.payload).length !== PAYLOAD_KEYS.length ||
    !PAYLOAD_KEYS.every(key => Object.prototype.hasOwnProperty.call(row.payload, key))
  ) {
    throw new Error('COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED')
  }
  const value = row.payload
  if (
    value.eventId !== row.dedupeKey ||
    value.type !== row.eventType ||
    value.publicationId !== row.publicationId ||
    value.previousPublicationId !== row.previousPublicationId ||
    !Number.isSafeInteger(value.schemaVersion) ||
    (value.schemaVersion as number) < 1 ||
    typeof value.checksum !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.checksum) ||
    typeof value.occurredAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.occurredAt) ||
    Number.isNaN(Date.parse(value.occurredAt))
  ) {
    throw new Error('COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED')
  }
  return value as unknown as CommercialPublicationEventV1
}

function stableError(error: unknown): string {
  if (error instanceof CommercialArtifactCodecError && error.code === 'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED') {
    return 'COMMERCIAL_OUTBOX_CONTRACT_FUTURE'
  }
  if (error instanceof Error) {
    if (
      error.message === 'COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED' ||
      error.message === 'COMMERCIAL_OUTBOX_SCHEMA_FUTURE' ||
      error.message === 'COMMERCIAL_OUTBOX_CONTRACT_FUTURE' ||
      error.message === 'COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE' ||
      error.message === 'COMMERCIAL_OUTBOX_CLAIM_LOST'
    ) {
      return error.message
    }
  }
  return 'COMMERCIAL_OUTBOX_DELIVERY_FAILED'
}

function activationRevision(dedupeKey: string, publicationId: string): number | null {
  const match = /^commercial:activation:([1-9][0-9]*):(.*)$/.exec(dedupeKey)
  if (!match || match[2] !== publicationId) return null
  const revision = Number(match[1])
  return Number.isSafeInteger(revision) ? revision : null
}

export function indexCommercialActivationEvents(
  events: readonly CommercialCatalogActivationOutboxRecord[],
): ReadonlyMap<number, CommercialCatalogActivationOutboxRecord> {
  const indexed = new Map<number, CommercialCatalogActivationOutboxRecord>()
  for (const event of events) {
    const revision = activationRevision(event.dedupeKey, event.publicationId)
    if (revision !== null) indexed.set(revision, event)
  }
  return indexed
}

export function verifyCommercialClaimedActivationRevision(input: {
  row: ClaimedCommercialOutboxRow
  event: CommercialPublicationEventV1
  graph: CommercialOutboxActivationGraph
  decision: CommercialCatalogAuthorityChainDecision
  eventsByRevision: ReadonlyMap<number, CommercialCatalogActivationOutboxRecord>
}): CommercialOutboxClaimedRevisionDecision {
  const revision = activationRevision(input.row.dedupeKey, input.row.publicationId)
  const stored = revision === null ? undefined : input.eventsByRevision.get(revision)
  if (!stored || !input.graph.pointer || stored.id !== input.row.id) throw new Error('COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE')
  const storedEvent = parseCommercialPublicationOutboxEvent(stored as unknown as ClaimedCommercialOutboxRow)
  if (
    stored.eventType !== input.row.eventType ||
    stored.publicationId !== input.row.publicationId ||
    stored.previousPublicationId !== input.row.previousPublicationId ||
    stored.payloadVersion !== input.row.payloadVersion ||
    stored.dedupeKey !== input.row.dedupeKey ||
    storedEvent.eventId !== input.event.eventId ||
    storedEvent.type !== input.event.type ||
    storedEvent.publicationId !== input.event.publicationId ||
    storedEvent.previousPublicationId !== input.event.previousPublicationId ||
    storedEvent.schemaVersion !== input.event.schemaVersion ||
    storedEvent.checksum !== input.event.checksum ||
    storedEvent.occurredAt !== input.event.occurredAt
  ) {
    throw new Error('COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE')
  }
  const head = input.decision.pointer.publication
  return {
    publication: stored.publication,
    head: { publicationId: head.id, schemaVersion: head.schemaVersion, checksum: head.checksum },
  }
}

export const prismaCommercialOutboxDependencies: CommercialOutboxDependencies = {
  now: () => new Date(),
  claim: (workerId, limit, claimedAt, claimExpiresAt) =>
    prisma.$transaction(tx =>
      tx.$queryRaw<ClaimedCommercialOutboxRow[]>(Prisma.sql`
        WITH candidates AS (
          SELECT candidate.id
          FROM "CommercialPublicationOutbox" AS candidate
          WHERE (
            candidate.status = 'PENDING'
            AND candidate."nextAttemptAt" <= ${utcTs(claimedAt)}
          ) OR (
            candidate.status = 'CLAIMED'
            AND candidate."claimExpiresAt" <= ${utcTs(claimedAt)}
          )
          ORDER BY candidate."createdAt" ASC, candidate.id ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "CommercialPublicationOutbox" AS outbox
        SET status = 'CLAIMED',
            "claimedBy" = ${workerId},
            "claimedAt" = ${utcTs(claimedAt)},
            "claimExpiresAt" = ${utcTs(claimExpiresAt)},
            attempts = outbox.attempts + 1,
            "updatedAt" = CURRENT_TIMESTAMP
        FROM candidates
        WHERE outbox.id = candidates.id
        RETURNING outbox.id, outbox."eventType", outbox."publicationId", outbox."previousPublicationId",
                  outbox."payloadVersion", outbox.payload, outbox."dedupeKey", outbox.attempts,
                  outbox."claimExpiresAt"
      `),
    ),
  loadActivationGraph: () =>
    prisma.$transaction(
      async tx => {
        const pointer = (await tx.commercialPublicationActivation.findUnique({
          where: { environment: 'PRODUCTION' },
          include: { publication: true },
        })) as CommercialCatalogAuthorityPointer | null
        if (!pointer) return { pointer: null, activationEvents: [] }
        const activationEvents = (await tx.commercialPublicationOutbox.findMany({
          where: { eventType: { in: ['PUBLICATION_ACTIVATED', 'PUBLICATION_ROLLED_BACK'] } },
          include: { publication: true, previousPublication: true },
        })) as CommercialCatalogActivationOutboxRecord[]
        return { pointer, activationEvents }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 30_000,
      },
    ),
  proveActivationChain(graph) {
    if (!graph.pointer) throw new Error('COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE')
    return verifyCommercialCatalogActivationChain({
      pointer: graph.pointer,
      activationEvents: graph.activationEvents,
    })
  },
  verifyClaimedRevision: verifyCommercialClaimedActivationRevision,
  loadPublication: publicationId =>
    prisma.commercialPublication.findUnique({
      where: { id: publicationId },
      select: { id: true, schemaVersion: true, snapshot: true, checksum: true, publishedAt: true },
    }),
  verifyPublication(publication) {
    const decoded = decodeAndVerifyCommercialArtifact(catalogDecodeInput(publication))
    if (decoded.kind !== 'CATALOG') throw new Error('COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED')
  },
  verifyFuturePublication: verifyFutureCatalogRow,
  async deliver({ head }) {
    // Both side effects are intentionally idempotent invalidations. A repeated
    // delivery never applies commercial data or calculates money.
    invalidateCommercialCatalogCache()
    getSocketManager().getServer()?.emit('commercial:catalog-invalidated', {
      publicationId: head.publicationId,
      schemaVersion: head.schemaVersion,
      checksum: head.checksum,
    })
  },
  async telemetry(event) {
    logger.info('Commercial outbox publication-created document verified', {
      event: 'COMMERCIAL_OUTBOX_PUBLICATION_CREATED_VERIFIED',
      artifactKind: 'CATALOG',
      schemaVersion: event.schemaVersion,
      code: 'COMMERCIAL_OUTBOX_DELIVERED',
    })
  },
  async alertFutureSchema(event) {
    logger.warn('Commercial outbox future document schema deferred', {
      event: 'COMMERCIAL_OUTBOX_FUTURE_SCHEMA_DEFERRED',
      artifactKind: 'CATALOG',
      schemaVersion: event.schemaVersion,
      code: 'COMMERCIAL_OUTBOX_SCHEMA_FUTURE',
    })
  },
  acknowledge: (row, workerId, deliveredAt) =>
    prisma.$transaction(async tx => {
      const updated = await tx.commercialPublicationOutbox.updateMany({
        where: {
          id: row.id,
          status: 'CLAIMED',
          claimedBy: workerId,
          claimExpiresAt: row.claimExpiresAt,
          attempts: row.attempts,
        },
        data: {
          status: 'DELIVERED',
          deliveredAt,
          claimedBy: null,
          claimedAt: null,
          claimExpiresAt: null,
          lastError: null,
        },
      })
      return updated.count === 1
    }),
  fail: (row, workerId, input) =>
    prisma.$transaction(async tx => {
      await tx.commercialPublicationOutbox.updateMany({
        where: {
          id: row.id,
          status: 'CLAIMED',
          claimedBy: workerId,
          claimExpiresAt: row.claimExpiresAt,
          attempts: row.attempts,
        },
        data: {
          status: input.terminal ? 'FAILED' : 'PENDING',
          nextAttemptAt: input.nextAttemptAt,
          claimedBy: null,
          claimedAt: null,
          claimExpiresAt: null,
          lastError: input.lastError,
        },
      })
    }),
}

export function createCommercialOutboxService(overrides: Partial<CommercialOutboxDependencies> = {}) {
  const dependencies = { ...prismaCommercialOutboxDependencies, ...overrides }
  return {
    async sweepOnce(input: { workerId: string; limit?: number }): Promise<{ claimed: number; delivered: number; failed: number }> {
      const limit = Math.max(1, Math.min(MAX_CLAIM, input.limit ?? MAX_CLAIM))
      const claimedAt = dependencies.now()
      const claimExpiresAt = new Date(claimedAt.getTime() + CLAIM_LEASE_MS)
      const claimed = await dependencies.claim(input.workerId, limit, claimedAt, claimExpiresAt)
      let activationAuthority:
        | {
            graph: CommercialOutboxActivationGraph
            decision: CommercialCatalogAuthorityChainDecision
            eventsByRevision: ReadonlyMap<number, CommercialCatalogActivationOutboxRecord>
          }
        | Error
        | null = null
      if (claimed.some(row => row.eventType === 'PUBLICATION_ACTIVATED' || row.eventType === 'PUBLICATION_ROLLED_BACK')) {
        try {
          const graph = await dependencies.loadActivationGraph()
          const decision = dependencies.proveActivationChain(graph)
          activationAuthority = { graph, decision, eventsByRevision: indexCommercialActivationEvents(graph.activationEvents) }
        } catch {
          activationAuthority = new Error('COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE')
        }
      }
      let delivered = 0
      let failed = 0
      for (const row of claimed) {
        try {
          const event = parseCommercialPublicationOutboxEvent(row)
          if (event.schemaVersion > 2) {
            await dependencies.alertFutureSchema(event)
            throw new Error('COMMERCIAL_OUTBOX_SCHEMA_FUTURE')
          }
          let publication: CommercialCatalogPersistedRow | null
          let head: CommercialOutboxHead | null = null
          if (event.type === 'PUBLICATION_CREATED') {
            publication = await dependencies.loadPublication(event.publicationId)
          } else {
            if (!activationAuthority || activationAuthority instanceof Error) {
              throw new Error('COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE')
            }
            const verified = dependencies.verifyClaimedRevision({
              row,
              event,
              graph: activationAuthority.graph,
              decision: activationAuthority.decision,
              eventsByRevision: activationAuthority.eventsByRevision,
            })
            publication = verified.publication
            head = verified.head
          }
          if (
            !publication ||
            publication.id !== event.publicationId ||
            publication.schemaVersion !== event.schemaVersion ||
            publication.checksum !== event.checksum
          ) {
            throw new Error('COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED')
          }
          try {
            dependencies.verifyPublication(publication)
          } catch (verificationError) {
            if (
              verificationError instanceof CommercialArtifactCodecError &&
              verificationError.code === 'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED'
            ) {
              try {
                dependencies.verifyFuturePublication(publication)
              } catch {
                throw new Error('COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED')
              }
              throw new Error('COMMERCIAL_OUTBOX_CONTRACT_FUTURE')
            }
            throw new Error('COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED')
          }
          if (event.type === 'PUBLICATION_CREATED') await dependencies.telemetry(event)
          else await dependencies.deliver({ event, head: head! })
          const acknowledged = await dependencies.acknowledge(row, input.workerId, dependencies.now())
          if (!acknowledged) throw new Error('COMMERCIAL_OUTBOX_CLAIM_LOST')
          delivered += 1
        } catch (caught) {
          failed += 1
          const errorCode = stableError(caught)
          if (errorCode === 'COMMERCIAL_OUTBOX_CLAIM_LOST') continue
          const poison = errorCode === 'COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED'
          const terminal = poison || row.attempts >= MAX_ATTEMPTS
          const backoffSeconds = Math.min(300, 2 ** Math.min(row.attempts, 8))
          await dependencies.fail(row, input.workerId, {
            terminal,
            nextAttemptAt: new Date(dependencies.now().getTime() + backoffSeconds * 1000),
            lastError: errorCode,
          })
        }
      }
      return { claimed: claimed.length, delivered, failed }
    },
  }
}

export const commercialOutboxService = createCommercialOutboxService()
