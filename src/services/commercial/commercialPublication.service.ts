import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/errors/AppError'
import type { CommercialDraftView, CommercialPublisherActor } from '@/types/commercial'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import { buildCommercialCatalogV2, type CommercialCatalogBuildInputV2 } from './commercialCatalogV2Builder.service'
import {
  assertEmittedCommercialCatalogV2,
  decodeAndVerifyStoredCommercialCatalog,
  type CatalogV2Result,
  type VerifiedStoredCommercialCatalog,
} from './commercialArtifactCodecRegistry.service'
import { commercialActivityLogData, type CommercialAuditInput } from './commercialAudit.service'
import { env } from '@/config/env'
import { validateCommercialCatalogOfferCompatibilityV3 } from './offers/commercialCatalogOfferCompatibility.service'
import { loadEligibleCommercialOffersV3 } from './offers/commercialOfferEligibility.service'
import { createCommercialEligibleOfferWriterSnapshotRunner } from './offers/commercialEligibleOfferWriterSnapshot.service'
import type { VerifiedStoredCommercialOfferV3 } from '@/types/commercialOfferV3'
import { createCommercialWriterTransactionRunner } from './commercialWriterTransaction.service'
import { runWithCommercialCompatibilityObservation } from './offers/commercialCompatibilityObservability.service'

const PREVIEW_TTL_MS = 15 * 60 * 1000

interface CommercialPreviewTokenPayload {
  version: 1
  draftId: string
  draftRevision: number
  publicationId: string
  publishedAt: string
  checksum: string
  actorStaffId: string
  expiresAt: string
}

export interface CommercialPublicationRecord {
  id: string
  schemaVersion: number
  checksum: string
  snapshot: unknown
  publishedAt: Date
}

interface CommercialPublicationTransaction {
  getDraftForPublication(id: string): Promise<CommercialDraftView | null>
  getEligibleOffers(now: Date): Promise<readonly VerifiedStoredCommercialOfferV3[]>
  createPublicationIfAbsent(input: {
    id: string
    sourceDraftId: string
    sourceRevision: number
    artifact: CatalogV2Result
    reason: string
    publishedById: string
    publishedAt: Date
  }): Promise<{ publication: CommercialPublicationRecord; created: boolean }>
  writeAudit(input: CommercialAuditInput): Promise<void>
  enqueue(input: {
    eventType: 'PUBLICATION_CREATED'
    publicationId: string
    schemaVersion: 2
    checksum: string
    occurredAt: Date
  }): Promise<void>
}

export interface CommercialPublicationServiceDependencies {
  getDraft(id: string): Promise<CommercialDraftView | null>
  getActivePublication(): Promise<CommercialPublicationRecord | null>
  now(): Date
  randomId(): string
  signingSecret: string
  buildCatalog?: (input: CommercialCatalogBuildInputV2) => CatalogV2Result
  runInTransaction<T>(operation: (tx: CommercialPublicationTransaction) => Promise<T>): Promise<T>
  runWithEligibleOffers<T>(
    now: Date,
    operation: (tx: CommercialPublicationTransaction, offers: readonly VerifiedStoredCommercialOfferV3[]) => Promise<T>,
  ): Promise<T>
}

export interface CommercialPublicationPreview {
  previewToken: string
  checksum: string
  expiresAt: string
  snapshot: CommercialCatalogSnapshotV2
  diff: {
    fromPublicationId: string | null
    addedProductCodes: string[]
    removedProductCodes: string[]
    changedProductCodes: string[]
    addedBundleCodes: string[]
    removedBundleCodes: string[]
    changedBundleCodes: string[]
    productOrderChanged: boolean
    bundleOrderChanged: boolean
  }
}

export interface PublishCommercialDraftInput {
  draftId: string
  expectedRevision: number
  previewToken: string
  checksum: string
  reason: string
  confirm: true
}

function requirePublisher(actor: CommercialPublisherActor): void {
  if (!actor.permissions.includes('commercial:publish') && !actor.permissions.includes('*')) {
    throw new ForbiddenError('No tienes permiso para publicar el catálogo comercial.', 'COMMERCIAL_PUBLISH_FORBIDDEN')
  }
}

function requireSigningSecret(secret: string): void {
  if (secret.length < 32) throw new Error('COMMERCIAL_PREVIEW_SIGNING_SECRET must contain at least 32 characters')
}

function encodePreview(payload: CommercialPreviewTokenPayload, secret: string): string {
  requireSigningSecret(secret)
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded, 'ascii').digest('base64url')
  return `${encoded}.${signature}`
}

function decodePreview(token: string, secret: string): CommercialPreviewTokenPayload | null {
  requireSigningSecret(secret)
  const pieces = token.split('.')
  if (pieces.length !== 2) return null
  const [encoded, supplied] = pieces
  const expected = createHmac('sha256', secret).update(encoded, 'ascii').digest()
  let suppliedBytes: Buffer
  try {
    suppliedBytes = Buffer.from(supplied, 'base64url')
  } catch {
    return null
  }
  if (suppliedBytes.length !== expected.length || !timingSafeEqual(suppliedBytes, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<CommercialPreviewTokenPayload>
    if (
      payload.version !== 1 ||
      typeof payload.draftId !== 'string' ||
      !Number.isInteger(payload.draftRevision) ||
      typeof payload.publicationId !== 'string' ||
      typeof payload.publishedAt !== 'string' ||
      typeof payload.checksum !== 'string' ||
      !/^[0-9a-f]{64}$/.test(payload.checksum) ||
      typeof payload.actorStaffId !== 'string' ||
      typeof payload.expiresAt !== 'string'
    ) {
      return null
    }
    return payload as CommercialPreviewTokenPayload
  } catch {
    return null
  }
}

interface CommercialPublicationDiffEntry {
  code: string
  crossVersion: string
  v2Exact: string | null
}

export interface CommercialPublicationDiffView {
  publicationId: string
  schemaVersion: 1 | 2
  productOrder: string[]
  bundleOrder: string[]
  products: CommercialPublicationDiffEntry[]
  bundles: CommercialPublicationDiffEntry[]
}

function catalogPriceKey(ownerType: 'PRODUCT' | 'BUNDLE', ownerCode: string, priceCode: string): string {
  return `${ownerType}:${ownerCode}:${priceCode}`
}

function exactCatalogPriceAmount(
  amountsByPrice: Map<string, bigint>,
  ownerType: 'PRODUCT' | 'BUNDLE',
  ownerCode: string,
  priceCode: string,
): string {
  const amountMinor = amountsByPrice.get(catalogPriceKey(ownerType, ownerCode, priceCode))
  if (amountMinor === undefined) {
    throw new ConflictError('La publicación no coincide con su proyección monetaria.', 'COMMERCIAL_PUBLICATION_INTEGRITY_INVALID')
  }
  return amountMinor.toString()
}

export function extractCommercialPublicationDiffView(artifact: VerifiedStoredCommercialCatalog): CommercialPublicationDiffView {
  const amountsByPrice = new Map(
    artifact.money.prices.map(price => [catalogPriceKey(price.ownerType, price.ownerCode, price.priceCode), price.amountMinor]),
  )
  if (artifact.schemaVersion === 1) {
    const snapshot = artifact.snapshot
    return {
      publicationId: snapshot.publicationId,
      schemaVersion: 1,
      productOrder: snapshot.products.map(product => product.code),
      bundleOrder: snapshot.bundles.map(bundle => bundle.code),
      products: snapshot.products.map(product => ({
        code: product.code,
        crossVersion: JSON.stringify({
          code: product.code,
          slug: product.slug,
          kind: product.kind,
          name: product.name,
          description: product.description,
          salesMode: product.salesMode,
          capabilityCodes: [...product.capabilityCodes].sort(),
          prices: product.prices.map(price => ({
            code: price.code,
            billingUnit: price.billingUnit,
            amountMinor: exactCatalogPriceAmount(amountsByPrice, 'PRODUCT', product.code, price.code),
            currency: price.currency,
            taxBehavior: price.taxBehavior,
            taxRateBasisPoints: price.taxRateBasisPoints,
          })),
          ...(product.limits ? { limits: product.limits } : {}),
        }),
        v2Exact: null,
      })),
      bundles: snapshot.bundles.map(bundle => ({
        code: bundle.code,
        crossVersion: JSON.stringify({
          code: bundle.code,
          slug: bundle.slug,
          name: bundle.name,
          description: bundle.description,
          itemProductCodes: [...bundle.itemProductCodes],
          prices: bundle.prices.map(price => ({
            code: price.code,
            billingUnit: price.billingUnit,
            amountMinor: exactCatalogPriceAmount(amountsByPrice, 'BUNDLE', bundle.code, price.code),
            currency: price.currency,
            taxBehavior: price.taxBehavior,
            taxRateBasisPoints: price.taxRateBasisPoints,
          })),
        }),
        v2Exact: null,
      })),
    }
  }

  const snapshot = artifact.snapshot
  return {
    publicationId: snapshot.publicationId,
    schemaVersion: 2,
    productOrder: snapshot.products.map(product => product.code),
    bundleOrder: snapshot.bundles.map(bundle => bundle.code),
    products: snapshot.products.map(product => {
      const crossVersion = {
        code: product.code,
        slug: product.slug,
        kind: product.kind,
        name: product.name,
        description: product.description,
        salesMode: product.salesMode,
        capabilityCodes: product.capabilityBindings.map(binding => binding.capabilityCode).sort(),
        prices: product.prices.map(price => ({
          code: price.code,
          billingUnit: price.billingUnit,
          amountMinor: exactCatalogPriceAmount(amountsByPrice, 'PRODUCT', product.code, price.code),
          currency: price.currency,
          taxBehavior: price.taxBehavior,
          taxRateBasisPoints: price.taxRateBasisPoints,
        })),
        ...(product.limits ? { limits: product.limits } : {}),
      }
      return {
        code: product.code,
        crossVersion: JSON.stringify(crossVersion),
        v2Exact: JSON.stringify({
          ...crossVersion,
          sortOrder: product.sortOrder,
          capabilityBindings: product.capabilityBindings,
        }),
      }
    }),
    bundles: snapshot.bundles.map(bundle => {
      const crossVersion = {
        code: bundle.code,
        slug: bundle.slug,
        name: bundle.name,
        description: bundle.description,
        itemProductCodes: bundle.items.map(item => item.productCode),
        prices: bundle.prices.map(price => ({
          code: price.code,
          billingUnit: price.billingUnit,
          amountMinor: exactCatalogPriceAmount(amountsByPrice, 'BUNDLE', bundle.code, price.code),
          currency: price.currency,
          taxBehavior: price.taxBehavior,
          taxRateBasisPoints: price.taxRateBasisPoints,
        })),
      }
      return {
        code: bundle.code,
        crossVersion: JSON.stringify(crossVersion),
        v2Exact: JSON.stringify({ ...crossVersion, sortOrder: bundle.sortOrder, items: bundle.items }),
      }
    }),
  }
}

function diffEntryMap(view: CommercialPublicationDiffView, kind: 'PRODUCT' | 'BUNDLE', compareV2Exactly: boolean): Map<string, string> {
  const entries = kind === 'PRODUCT' ? view.products : view.bundles
  return new Map(entries.map(entry => [entry.code, compareV2Exactly ? entry.v2Exact! : entry.crossVersion]))
}

function safeDiff(
  current: VerifiedStoredCommercialCatalog | null,
  next: VerifiedStoredCommercialCatalog,
): CommercialPublicationPreview['diff'] {
  const currentView = current ? extractCommercialPublicationDiffView(current) : null
  const nextView = extractCommercialPublicationDiffView(next)
  const compareV2Exactly = currentView?.schemaVersion === 2 && nextView.schemaVersion === 2
  const previous = currentView ? diffEntryMap(currentView, 'PRODUCT', compareV2Exactly) : new Map<string, string>()
  const upcoming = diffEntryMap(nextView, 'PRODUCT', compareV2Exactly)
  const previousBundles = currentView ? diffEntryMap(currentView, 'BUNDLE', compareV2Exactly) : new Map<string, string>()
  const upcomingBundles = diffEntryMap(nextView, 'BUNDLE', compareV2Exactly)
  return {
    fromPublicationId: currentView?.publicationId ?? null,
    addedProductCodes: [...upcoming.keys()].filter(code => !previous.has(code)).sort(),
    removedProductCodes: [...previous.keys()].filter(code => !upcoming.has(code)).sort(),
    changedProductCodes: [...upcoming.keys()].filter(code => previous.has(code) && previous.get(code) !== upcoming.get(code)).sort(),
    addedBundleCodes: [...upcomingBundles.keys()].filter(code => !previousBundles.has(code)).sort(),
    removedBundleCodes: [...previousBundles.keys()].filter(code => !upcomingBundles.has(code)).sort(),
    changedBundleCodes: [...upcomingBundles.keys()]
      .filter(code => previousBundles.has(code) && previousBundles.get(code) !== upcomingBundles.get(code))
      .sort(),
    productOrderChanged: currentView !== null && JSON.stringify(currentView.productOrder) !== JSON.stringify(nextView.productOrder),
    bundleOrderChanged: currentView !== null && JSON.stringify(currentView.bundleOrder) !== JSON.stringify(nextView.bundleOrder),
  }
}

function decodePublication(record: CommercialPublicationRecord): VerifiedStoredCommercialCatalog {
  return decodeAndVerifyStoredCommercialCatalog({
    kind: 'CATALOG',
    rowSchemaVersion: record.schemaVersion,
    snapshot: record.snapshot,
    checksum: record.checksum,
    rowContext: {
      kind: 'CATALOG',
      id: record.id,
      schemaVersion: record.schemaVersion,
      publishedAt: record.publishedAt,
    },
  })
}

function decodeEmittedPublication(artifact: CatalogV2Result): VerifiedStoredCommercialCatalog {
  return decodePublication({
    id: artifact.snapshot.publicationId,
    schemaVersion: artifact.schemaVersion,
    checksum: artifact.checksum,
    snapshot: artifact.snapshot,
    publishedAt: new Date(artifact.snapshot.publishedAt),
  })
}

const prismaCommercialPublicationWriterTransaction = createCommercialWriterTransactionRunner({ host: prisma })

function createPrismaCommercialPublicationTransaction(prismaTx: Prisma.TransactionClient): CommercialPublicationTransaction {
  return {
    async getDraftForPublication(id) {
      const locked = await prismaTx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "CommercialDraft"
        WHERE "id" = ${id}
        FOR UPDATE
      `
      if (locked.length === 0) return null
      const { getCommercialDraftGraphFromTx } = await import('./commercialDraft.service')
      return getCommercialDraftGraphFromTx(prismaTx, id)
    },
    getEligibleOffers: now => loadEligibleCommercialOffersV3(prismaTx, now),
    async createPublicationIfAbsent(input) {
      assertEmittedCommercialCatalogV2(input.artifact)
      const inserted = await prismaTx.commercialPublication.createMany({
        data: [
          {
            id: input.id,
            sourceDraftId: input.sourceDraftId,
            sourceRevision: input.sourceRevision,
            schemaVersion: 2,
            snapshot: input.artifact.snapshot as unknown as Prisma.InputJsonValue,
            checksum: input.artifact.checksum,
            reason: input.reason,
            publishedById: input.publishedById,
            publishedAt: input.publishedAt,
          },
        ],
        skipDuplicates: true,
      })
      const publication = await prismaTx.commercialPublication.findUnique({ where: { checksum: input.artifact.checksum } })
      if (!publication) {
        throw new ConflictError('La confirmación idempotente no encontró la publicación esperada.', 'COMMERCIAL_PUBLICATION_CONFLICT')
      }
      return { publication, created: inserted.count === 1 }
    },
    async writeAudit(input) {
      await prismaTx.activityLog.create({ data: commercialActivityLogData(input) })
    },
    async enqueue(input) {
      await prismaTx.commercialPublicationOutbox.create({
        data: {
          eventType: input.eventType,
          publicationId: input.publicationId,
          payloadVersion: 1,
          dedupeKey: `commercial:publication:${input.publicationId}:created`,
          payload: {
            eventId: `commercial:publication:${input.publicationId}:created`,
            type: input.eventType,
            publicationId: input.publicationId,
            previousPublicationId: null,
            schemaVersion: input.schemaVersion,
            checksum: input.checksum,
            occurredAt: input.occurredAt.toISOString(),
          },
        },
      })
    },
  }
}

const prismaCommercialPublicationEligibilityRunner = createCommercialEligibleOfferWriterSnapshotRunner({
  reader: prisma,
  runSerialized: <T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>) =>
    prismaCommercialPublicationWriterTransaction.run(operation),
})

export const prismaCommercialPublicationDependencies: CommercialPublicationServiceDependencies = {
  getDraft: async id => {
    const { getCommercialDraft } = await import('./commercialDraft.service')
    return getCommercialDraft(id)
  },
  getActivePublication: async () => {
    const activation = await prisma.commercialPublicationActivation.findUnique({
      where: { environment: 'PRODUCTION' },
      include: { publication: true },
    })
    return activation?.publication ?? null
  },
  now: () => new Date(),
  randomId: () => randomUUID(),
  signingSecret: env.COMMERCIAL_PREVIEW_SIGNING_SECRET,
  runInTransaction: operation =>
    prismaCommercialPublicationWriterTransaction.run(prismaTx => operation(createPrismaCommercialPublicationTransaction(prismaTx))),
  runWithEligibleOffers: (now, operation) =>
    prismaCommercialPublicationEligibilityRunner.run(now, (prismaTx, offers) =>
      operation(createPrismaCommercialPublicationTransaction(prismaTx), offers),
    ),
}

export function createCommercialPublicationService(dependencies: CommercialPublicationServiceDependencies) {
  const buildCatalog = dependencies.buildCatalog ?? buildCommercialCatalogV2
  return {
    async previewCommercialPublication(
      draftId: string,
      expectedRevision: number,
      actor: CommercialPublisherActor,
    ): Promise<CommercialPublicationPreview> {
      requirePublisher(actor)
      const draft = await dependencies.getDraft(draftId)
      if (!draft) throw new NotFoundError('Borrador comercial no encontrado.')
      if (draft.revision !== expectedRevision) {
        throw new ConflictError('La revisión del borrador cambió.', 'COMMERCIAL_DRAFT_CONFLICT')
      }
      const publishedAt = dependencies.now()
      const publicationId = dependencies.randomId()
      const built = buildCatalog({ draft, publicationId, publishedAt })
      assertEmittedCommercialCatalogV2(built)
      const expiresAt = new Date(publishedAt.getTime() + PREVIEW_TTL_MS)
      const previewToken = encodePreview(
        {
          version: 1,
          draftId,
          draftRevision: expectedRevision,
          publicationId,
          publishedAt: publishedAt.toISOString(),
          checksum: built.checksum,
          actorStaffId: actor.staffId,
          expiresAt: expiresAt.toISOString(),
        },
        dependencies.signingSecret,
      )
      const current = await dependencies.getActivePublication()
      const candidate = decodeEmittedPublication(built)
      const active = current ? decodePublication(current) : null
      return {
        previewToken,
        checksum: built.checksum,
        expiresAt: expiresAt.toISOString(),
        snapshot: built.snapshot,
        diff: safeDiff(active, candidate),
      }
    },

    async publishCommercialDraft(
      input: PublishCommercialDraftInput,
      actor: CommercialPublisherActor,
    ): Promise<CommercialPublicationRecord> {
      requirePublisher(actor)
      if (input.confirm !== true) throw new ValidationError('Confirma explícitamente la publicación.')
      const reason = input.reason.trim()
      if (reason.length < 3 || reason.length > 500) throw new ValidationError('Se requiere un motivo de publicación.')
      const token = decodePreview(input.previewToken, dependencies.signingSecret)
      if (!token) throw new ConflictError('El preview no es válido.', 'COMMERCIAL_PREVIEW_INVALID')
      const now = dependencies.now()
      if (Date.parse(token.expiresAt) <= now.getTime()) {
        throw new ConflictError('El preview expiró; genera uno nuevo.', 'COMMERCIAL_PREVIEW_EXPIRED')
      }
      if (
        token.draftId !== input.draftId ||
        token.draftRevision !== input.expectedRevision ||
        token.checksum !== input.checksum ||
        token.actorStaffId !== actor.staffId
      ) {
        throw new ConflictError('El preview no corresponde a esta publicación.', 'COMMERCIAL_PREVIEW_INVALID')
      }
      const publishedAt = new Date(token.publishedAt)
      const auditActor = { ...actor, reason }
      const publishInTransaction = async (
        tx: CommercialPublicationTransaction,
        preparedEligibleOffers: readonly VerifiedStoredCommercialOfferV3[],
      ): Promise<CommercialPublicationRecord> => {
        const draft = await tx.getDraftForPublication(input.draftId)
        if (!draft) throw new NotFoundError('Borrador comercial no encontrado.')
        if (draft.revision !== input.expectedRevision) {
          throw new ConflictError('La revisión del borrador cambió.', 'COMMERCIAL_DRAFT_CONFLICT')
        }
        const built = buildCatalog({ draft, publicationId: token.publicationId, publishedAt })
        assertEmittedCommercialCatalogV2(built)
        if (built.checksum !== token.checksum) {
          throw new ConflictError('El contenido del preview ya no coincide.', 'COMMERCIAL_PREVIEW_INVALID')
        }
        for (const offer of preparedEligibleOffers) {
          validateCommercialCatalogOfferCompatibilityV3({
            catalog: built.snapshot,
            offer: offer.snapshot,
            resolvedAt: offer.snapshot.claimStartsAt,
          })
        }
        const result = await tx.createPublicationIfAbsent({
          id: token.publicationId,
          sourceDraftId: input.draftId,
          sourceRevision: input.expectedRevision,
          artifact: built,
          reason,
          publishedById: actor.staffId,
          publishedAt,
        })
        const stored = decodePublication(result.publication)
        if (
          stored.schemaVersion !== built.schemaVersion ||
          stored.checksum !== built.checksum ||
          stored.snapshot.publicationId !== built.snapshot.publicationId ||
          stored.snapshot.publishedAt !== built.snapshot.publishedAt
        ) {
          throw new ConflictError(
            'La publicación persistida no coincide con el artefacto emitido.',
            'COMMERCIAL_PUBLICATION_INTEGRITY_INVALID',
          )
        }
        if (!result.created) return result.publication
        await tx.writeAudit({
          action: 'COMMERCIAL_PUBLICATION_CREATED',
          entity: 'CommercialPublication',
          entityId: result.publication.id,
          actor: auditActor,
          after: {
            draftId: input.draftId,
            sourceRevision: input.expectedRevision,
            checksum: token.checksum,
            schemaVersion: built.schemaVersion,
          },
        })
        await tx.enqueue({
          eventType: 'PUBLICATION_CREATED',
          publicationId: result.publication.id,
          schemaVersion: built.schemaVersion,
          checksum: result.publication.checksum,
          occurredAt: publishedAt,
        })
        return result.publication
      }
      return runWithCommercialCompatibilityObservation('CATALOG_PUBLISH', () =>
        dependencies.runWithEligibleOffers(now, publishInTransaction),
      )
    },
  }
}

const commercialPublicationService = createCommercialPublicationService(prismaCommercialPublicationDependencies)
export const previewCommercialPublication = commercialPublicationService.previewCommercialPublication
export const publishCommercialDraft = commercialPublicationService.publishCommercialDraft
