import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import { createHash } from 'node:crypto'
import socketManager from '../../communication/sockets'
import prisma from '../../utils/prismaClient'
import type { CatalogPublicationOperation } from '../../types/master-catalog'
import type {
  CatalogPublicationOutboxPayloadV1,
  CatalogPublicationPriceChangeV1,
  CatalogPublicationSocketProductV1,
} from './catalogPublication.types'

const CLAIM_LEASE_MS = 30_000
const MAX_ATTEMPTS = 8
const MAX_CLAIM = 100

interface ClaimedOutboxRow {
  id: string
  organizationId: string
  batchId: string
  venueId: string
  venueSequence: bigint
  eventKind: string
  payloadVersion: number
  payload: unknown
  dedupeKey: string
  status: 'PENDING'
  attempts: number
  claimedBy: string
  claimExpiresAt: Date
}

interface CatalogPublicationBroadcaster {
  broadcastMenuItemUpdated: (venueId: string, payload: Record<string, unknown>) => void
  broadcastProductPriceChanged: (venueId: string, payload: Record<string, unknown>) => void
  broadcastMenuUpdated: (venueId: string, payload: Record<string, unknown>) => void
}

interface CatalogPublicationOutboxProductRow {
  id: string
  venueId: string
  name: string
  sku: string
  categoryId: string
  price: Prisma.Decimal
  active: boolean
  imageUrl: string | null
  description: string | null
  category: { name: string }
  modifierGroups: Array<{ groupId: string }>
}

export interface CatalogPublicationEventV1 {
  eventId: string
  organizationId: string
  publicationBatchId: string
  venueId: string
  venueSequence: string
  eventKind: string
  payloadVersion: 1
  payload: unknown
}

interface OutboxDependencies {
  prisma: typeof prisma
  emit: (event: CatalogPublicationEventV1) => Promise<void>
  now: () => Date
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sequenceId(organizationId: string, venueId: string): string {
  return `catalog-seq-${createHash('sha256').update(`${organizationId}\u0000${venueId}`).digest('hex').slice(0, 24)}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function boundedString(value: unknown, maxBytes = 256, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.trim().length > 0) && Buffer.byteLength(value, 'utf8') <= maxBytes
}

function nullableText(value: unknown, maxBytes: number): value is string | null {
  return value === null || boundedString(value, maxBytes, true)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function idArray(value: unknown, max: number): value is string[] {
  if (!Array.isArray(value) || value.length > max) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !boundedString(value[index])) return false
  }
  return new Set(value).size === value.length
}

export function serializeCatalogPublicationEventsV1(
  products: CatalogPublicationSocketProductV1[],
  priceChanges: CatalogPublicationPriceChangeV1[] = [],
): CatalogPublicationOutboxPayloadV1 {
  const productIds = products.map(product => product.productId)
  return {
    schemaVersion: 1,
    menuItems: products.map(product => ({
      itemId: product.productId,
      itemName: product.productName,
      sku: product.sku,
      categoryId: product.categoryId,
      categoryName: product.categoryName,
      price: product.price,
      available: product.available,
      imageUrl: product.imageUrl,
      description: product.description,
      modifierGroupIds: product.modifierGroupIds,
    })),
    menu: {
      updateType: 'PARTIAL_UPDATE',
      productIds,
      categoryIds: [...new Set(products.map(product => product.categoryId))].sort(ordinal),
      reason: 'CATEGORY_UPDATED',
    },
    priceChanges: priceChanges.map(change => {
      const priceChange = change.newPrice - change.oldPrice
      return {
        ...change,
        priceChange,
        // WHY: The live serializer contract forbids Infinity/NaN JSON when an
        // item gains its first non-zero price.
        priceChangePercent: change.oldPrice === 0 ? null : (priceChange / change.oldPrice) * 100,
      }
    }),
  }
}

function isPayloadV1(value: unknown): value is CatalogPublicationOutboxPayloadV1 {
  if (!isPlainObject(value) || !exactKeys(value, ['schemaVersion', 'menuItems', 'menu', 'priceChanges'])) return false
  if (value.schemaVersion !== 1 || !Array.isArray(value.menuItems) || !Array.isArray(value.priceChanges)) return false
  if (value.menuItems.length === 0 || value.menuItems.length > 10_000 || value.priceChanges.length > 10_000 || !isPlainObject(value.menu))
    return false
  if (!exactKeys(value.menu, ['updateType', 'productIds', 'categoryIds', 'reason'])) return false
  if (
    value.menu.updateType !== 'PARTIAL_UPDATE' ||
    value.menu.reason !== 'CATEGORY_UPDATED' ||
    !idArray(value.menu.productIds, 10_000) ||
    !idArray(value.menu.categoryIds, 10_000)
  ) {
    return false
  }
  for (let index = 0; index < value.menuItems.length; index += 1) {
    const item = value.menuItems[index]
    if (
      !(index in value.menuItems) ||
      !isPlainObject(item) ||
      !exactKeys(item, [
        'itemId',
        'itemName',
        'sku',
        'categoryId',
        'categoryName',
        'price',
        'available',
        'imageUrl',
        'description',
        'modifierGroupIds',
      ]) ||
      ![item.itemId, item.sku, item.categoryId].every(part => boundedString(part)) ||
      !boundedString(item.itemName, 4_096) ||
      !boundedString(item.categoryName, 4_096) ||
      !finiteNumber(item.price) ||
      typeof item.available !== 'boolean' ||
      !nullableText(item.imageUrl, 8_192) ||
      !nullableText(item.description, 32_768) ||
      !idArray(item.modifierGroupIds, 1_000)
    )
      return false
  }
  const items = value.menuItems as CatalogPublicationOutboxPayloadV1['menuItems']
  const productIds = items.map(item => item.itemId)
  const categoryIds = [...new Set(items.map(item => item.categoryId))].sort(ordinal)
  if (canonicalArray(value.menu.productIds, productIds) === false || canonicalArray(value.menu.categoryIds, categoryIds) === false)
    return false
  const itemById = new Map(items.map(item => [item.itemId, item]))
  for (let index = 0; index < value.priceChanges.length; index += 1) {
    const change = value.priceChanges[index]
    if (
      !(index in value.priceChanges) ||
      !isPlainObject(change) ||
      !exactKeys(change, [
        'productId',
        'productName',
        'sku',
        'oldPrice',
        'newPrice',
        'priceChange',
        'priceChangePercent',
        'categoryId',
        'categoryName',
      ]) ||
      ![change.productId, change.sku, change.categoryId].every(part => boundedString(part)) ||
      !boundedString(change.productName, 4_096) ||
      !boundedString(change.categoryName, 4_096) ||
      ![change.oldPrice, change.newPrice, change.priceChange].every(finiteNumber) ||
      !(change.priceChangePercent === null || finiteNumber(change.priceChangePercent))
    )
      return false
    const item = itemById.get(change.productId as string)
    const expectedDelta = (change.newPrice as number) - (change.oldPrice as number)
    const expectedPercent = change.oldPrice === 0 ? null : (expectedDelta / (change.oldPrice as number)) * 100
    if (
      !item ||
      item.itemName !== change.productName ||
      item.sku !== change.sku ||
      item.categoryId !== change.categoryId ||
      item.categoryName !== change.categoryName ||
      change.priceChange !== expectedDelta ||
      change.priceChangePercent !== expectedPercent
    )
      return false
  }
  return true
}

function canonicalArray(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

export async function enqueueCatalogPublicationOutboxTx(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    publicationBatchId: string
    operation: CatalogPublicationOperation
    targets: Array<{ venueId: string; productId: string }>
    randomId?: () => string
    now?: Date
  },
): Promise<void> {
  const uniqueTargets = [...new Map(input.targets.map(target => [`${target.venueId}\u0000${target.productId}`, target])).values()]
  const venueIds = [...new Set(uniqueTargets.map(target => target.venueId))].sort(ordinal)
  if (venueIds.length === 0) return
  const randomId = input.randomId ?? cuid
  const now = input.now ?? new Date()
  const requested = venueIds.map(
    venueId => Prisma.sql`(${sequenceId(input.organizationId, venueId)}, ${input.organizationId}, ${venueId}, 1::bigint)`,
  )
  // WHY: Sequence issuance locks/upserts every affected venue in ordinal order;
  // retries reuse outbox IDs and never mint a later event ahead of an earlier one.
  const sequences = await tx.$queryRaw<Array<{ venueId: string; venueSequence: bigint }>>(Prisma.sql`
    INSERT INTO "CatalogVenueEventSequence" (id, "organizationId", "venueId", "lastIssuedSequence", "createdAt", "updatedAt")
    VALUES ${Prisma.join(requested)}
    ON CONFLICT ("organizationId", "venueId") DO UPDATE
      SET "lastIssuedSequence" = "CatalogVenueEventSequence"."lastIssuedSequence" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "venueId", "lastIssuedSequence" AS "venueSequence"
  `)
  const sequenceByVenue = new Map(sequences.map(row => [row.venueId, row.venueSequence]))
  const products: CatalogPublicationOutboxProductRow[] = []
  for (let index = 0; index < uniqueTargets.length; index += 500) {
    const targetChunk = uniqueTargets.slice(index, index + 500)
    const chunkProducts: CatalogPublicationOutboxProductRow[] = await tx.product.findMany({
      where: { OR: targetChunk.map(target => ({ id: target.productId, venueId: target.venueId })), deletedAt: null },
      select: {
        id: true,
        venueId: true,
        name: true,
        sku: true,
        categoryId: true,
        price: true,
        active: true,
        imageUrl: true,
        description: true,
        category: { select: { name: true } },
        modifierGroups: { select: { groupId: true } },
      },
      orderBy: { id: 'asc' },
    })
    products.push(...chunkProducts)
  }
  if (products.length !== uniqueTargets.length) throw new Error('CATALOG_OUTBOX_PRODUCT_SET_INVALID')
  const payloadByVenue = new Map(
    venueIds.map(venueId => {
      const venueProducts = products
        .filter(product => product.venueId === venueId)
        .map(product => ({
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          categoryId: product.categoryId,
          categoryName: product.category.name,
          price: Number(product.price.toString()),
          available: product.active,
          imageUrl: product.imageUrl,
          description: product.description,
          modifierGroupIds: product.modifierGroups.map(group => group.groupId),
        }))
      return [venueId, serializeCatalogPublicationEventsV1(venueProducts)]
    }),
  )
  await tx.catalogPublicationOutbox.createMany({
    data: venueIds.map(venueId => ({
      id: randomId(),
      organizationId: input.organizationId,
      batchId: input.publicationBatchId,
      venueId,
      venueSequence: sequenceByVenue.get(venueId) as bigint,
      eventKind: 'CATALOG_PUBLICATION_SERIALIZERS_V1',
      payloadVersion: 1,
      payload: payloadByVenue.get(venueId) as unknown as Prisma.InputJsonObject,
      dedupeKey: `catalog-publication:${input.publicationBatchId}:${venueId}:refetch:v1`,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    })),
  })
}

export async function deliverCatalogPublicationEventV1(
  event: CatalogPublicationEventV1,
  broadcaster: CatalogPublicationBroadcaster,
): Promise<void> {
  if (event.eventKind !== 'CATALOG_PUBLICATION_SERIALIZERS_V1' || event.payloadVersion !== 1 || !isPayloadV1(event.payload)) {
    throw new Error('CATALOG_OUTBOX_PAYLOAD_UNSUPPORTED')
  }
  const metadata = {
    eventId: event.eventId,
    publicationBatchId: event.publicationBatchId,
    venueSequence: event.venueSequence,
  }
  for (const item of event.payload.menuItems) broadcaster.broadcastMenuItemUpdated(event.venueId, { ...item, metadata })
  for (const change of event.payload.priceChanges) {
    broadcaster.broadcastProductPriceChanged(event.venueId, { ...change, metadata })
  }
  broadcaster.broadcastMenuUpdated(event.venueId, { ...event.payload.menu, metadata })
}

async function defaultEmit(event: CatalogPublicationEventV1): Promise<void> {
  // WHY: Delivery uses the same supported serializers as legacy Product writes;
  // failure happens after APPLIED and therefore only retries this eventId.
  const broadcaster = socketManager.getBroadcastingService()
  if (!broadcaster) throw new Error('CATALOG_OUTBOX_SOCKET_UNAVAILABLE')
  await deliverCatalogPublicationEventV1(event, broadcaster as unknown as CatalogPublicationBroadcaster)
}

const defaults: OutboxDependencies = { prisma, emit: defaultEmit, now: () => new Date() }

function safeError(error: unknown): string {
  return (error instanceof Error && error.name ? error.name : 'DeliveryError').slice(0, 256)
}

function event(row: ClaimedOutboxRow): CatalogPublicationEventV1 {
  if (row.payloadVersion !== 1 || row.eventKind !== 'CATALOG_PUBLICATION_SERIALIZERS_V1' || !isPayloadV1(row.payload)) {
    throw new Error('CATALOG_OUTBOX_PAYLOAD_UNSUPPORTED')
  }
  return {
    eventId: row.id,
    organizationId: row.organizationId,
    publicationBatchId: row.batchId,
    venueId: row.venueId,
    venueSequence: row.venueSequence.toString(),
    eventKind: row.eventKind,
    payloadVersion: row.payloadVersion,
    payload: row.payload,
  }
}

export function createCatalogPublicationOutboxService(overrides: Partial<OutboxDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides }
  return {
    async sweepOnce(input: { workerId: string; limit?: number }): Promise<{ claimed: number; delivered: number; failed: number }> {
      const limit = Math.max(1, Math.min(MAX_CLAIM, input.limit ?? MAX_CLAIM))
      const claimedAt = dependencies.now()
      const claimExpiresAt = new Date(claimedAt.getTime() + CLAIM_LEASE_MS)
      const claimed = await dependencies.prisma.$transaction(async tx => {
        // WHY: NOT EXISTS enforces venue order while SKIP LOCKED gives workers
        // disjoint claims; one venue can expose only its earliest undelivered row.
        return tx.$queryRaw<ClaimedOutboxRow[]>(Prisma.sql`
          WITH candidates AS (
            SELECT candidate.id
            FROM "CatalogPublicationOutbox" AS candidate
            WHERE candidate.status = 'PENDING'
              AND candidate."nextAttemptAt" <= ${claimedAt}
              AND (candidate."claimExpiresAt" IS NULL OR candidate."claimExpiresAt" <= ${claimedAt})
              AND NOT EXISTS (
                SELECT 1 FROM "CatalogPublicationOutbox" AS earlier
                WHERE earlier."organizationId" = candidate."organizationId"
                  AND earlier."venueId" = candidate."venueId"
                  AND earlier."venueSequence" < candidate."venueSequence"
                  AND earlier.status <> 'DELIVERED'
              )
            ORDER BY candidate."venueId" ASC, candidate."venueSequence" ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          UPDATE "CatalogPublicationOutbox" AS outbox
          SET "claimedBy" = ${input.workerId}, "claimedAt" = ${claimedAt}, "claimExpiresAt" = ${claimExpiresAt},
              attempts = outbox.attempts + 1, "updatedAt" = CURRENT_TIMESTAMP
          FROM candidates
          WHERE outbox.id = candidates.id
          RETURNING outbox.*
        `)
      })

      let delivered = 0
      let failed = 0
      for (const row of claimed) {
        try {
          await dependencies.emit(event(row))
        } catch (error) {
          failed += 1
          const dead = row.attempts >= MAX_ATTEMPTS
          const backoffSeconds = Math.min(300, 2 ** Math.min(row.attempts, 8))
          await dependencies.prisma.$transaction(tx =>
            tx.catalogPublicationOutbox.updateMany({
              where: {
                id: row.id,
                status: 'PENDING',
                claimedBy: input.workerId,
                claimExpiresAt: row.claimExpiresAt,
                attempts: row.attempts,
              },
              data: {
                status: dead ? 'DEAD_LETTER' : 'PENDING',
                nextAttemptAt: new Date(dependencies.now().getTime() + backoffSeconds * 1_000),
                claimedBy: null,
                claimedAt: null,
                claimExpiresAt: null,
                lastError: safeError(error),
              },
            }),
          )
          continue
        }
        const acknowledged = await dependencies.prisma.$transaction(tx =>
          tx.catalogPublicationOutbox.updateMany({
            where: {
              id: row.id,
              status: 'PENDING',
              claimedBy: input.workerId,
              claimExpiresAt: row.claimExpiresAt,
              attempts: row.attempts,
            },
            data: {
              status: 'DELIVERED',
              deliveredAt: dependencies.now(),
              claimedBy: null,
              claimedAt: null,
              claimExpiresAt: null,
              lastError: null,
            },
          }),
        )
        if (acknowledged.count !== 1) throw new Error('CATALOG_OUTBOX_CLAIM_LOST')
        delivered += 1
      }
      return { claimed: claimed.length, delivered, failed }
    },
  }
}

export const catalogPublicationOutboxService = createCatalogPublicationOutboxService()
