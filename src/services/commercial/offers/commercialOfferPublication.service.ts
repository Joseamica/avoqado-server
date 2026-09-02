import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'

import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/errors/AppError'
import { decodeAndVerifyStoredCommercialCatalogV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { createCommercialWriterTransactionRunner } from '@/services/commercial/commercialWriterTransaction.service'
import type { CommercialPublisherActor } from '@/types/commercial'
import type { CommercialCatalogPersistedRow } from '@/types/commercialCodec'
import type {
  CommercialBenefitV3,
  CommercialOfferDraftViewV3,
  EmittedCommercialOfferV3,
  VerifiedStoredCommercialOfferV3,
} from '@/types/commercialOfferV3'
import prisma from '@/utils/prismaClient'

import { loadCommercialOfferDraftGraphV3 } from './commercialOfferDraftGraph.service'
import { validateCommercialCatalogOfferCompatibilityV3 } from './commercialCatalogOfferCompatibility.service'
import { createHardwareSkuSnapshotV3 } from './hardwareSkuSnapshot.service'
import { decodeAndVerifyStoredCommercialOfferV3, emitCommercialOfferV3 } from './commercialOfferV3.service'
import { runWithCommercialCompatibilityObservation } from './commercialCompatibilityObservability.service'

export interface CommercialOfferVersionRecord {
  id: string
  campaignCode: string
  sourceDraftId: string
  sourceRevision: number
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

interface CommercialOfferPublicationAudit {
  action: 'COMMERCIAL_OFFER_V3_PUBLISHED'
  entityId: string
  actor: CommercialPublisherActor
  data: Record<string, unknown>
}

export interface CommercialOfferPublicationTransaction {
  lockDraft(id: string): Promise<CommercialOfferDraftViewV3 | null>
  getProductionCatalog(): Promise<CommercialCatalogPersistedRow | null>
  findVersionBySourceRevision(draftId: string, revision: number): Promise<CommercialOfferVersionRecord | null>
  createVersion(input: {
    sourceDraftId: string
    sourceRevision: number
    emitted: EmittedCommercialOfferV3
    reason: string
    publishedById: string
    publishedAt: Date
  }): Promise<CommercialOfferVersionRecord>
  writeAudit(input: CommercialOfferPublicationAudit): Promise<void>
}

export interface CommercialOfferPublicationDependencies {
  now(): Date
  randomId(): string
  runInTransaction<T>(operation: (tx: CommercialOfferPublicationTransaction) => Promise<T>): Promise<T>
}

export interface PublishCommercialOfferV3Input {
  draftId: string
  expectedDraftRevision: number
  reason: string
  confirm: true
}

function requirePublisher(actor: CommercialPublisherActor): void {
  if (!actor.permissions.includes('commercial:publish') && !actor.permissions.includes('*')) {
    throw new ForbiddenError('No tienes permiso para publicar ofertas.', 'COMMERCIAL_OFFER_PUBLISH_FORBIDDEN')
  }
}

function verifyStored(row: CommercialOfferVersionRecord): VerifiedStoredCommercialOfferV3 {
  return decodeAndVerifyStoredCommercialOfferV3({
    rowSchemaVersion: row.schemaVersion,
    snapshot: row.snapshot,
    checksum: row.checksum,
    rowContext: {
      id: row.id,
      campaignCode: row.campaignCode,
      sourceRevision: row.sourceRevision,
      schemaVersion: row.schemaVersion,
      publishedAt: row.publishedAt,
    },
  })
}

function requireProductionCatalog(row: CommercialCatalogPersistedRow | null) {
  if (!row || row.schemaVersion !== 2) {
    throw new ConflictError(
      'Activa primero un catálogo comercial v2 en producción.',
      'COMMERCIAL_OFFER_PRODUCTION_CATALOG_REQUIRED',
    )
  }
  try {
    return decodeAndVerifyStoredCommercialCatalogV2({
      kind: 'CATALOG',
      rowSchemaVersion: row.schemaVersion,
      snapshot: row.snapshot,
      checksum: row.checksum,
      rowContext: {
        kind: 'CATALOG',
        id: row.id,
        schemaVersion: row.schemaVersion,
        publishedAt: row.publishedAt,
      },
    })
  } catch {
    throw new ConflictError('El catálogo de producción no superó su verificación.', 'COMMERCIAL_OFFER_PRODUCTION_CATALOG_INVALID')
  }
}

async function validateAgainstProductionCatalog(
  tx: CommercialOfferPublicationTransaction,
  offer: EmittedCommercialOfferV3 | VerifiedStoredCommercialOfferV3,
): Promise<void> {
  const catalog = requireProductionCatalog(await tx.getProductionCatalog())
  validateCommercialCatalogOfferCompatibilityV3({
    catalog: catalog.snapshot,
    offer: offer.snapshot,
    resolvedAt: offer.snapshot.claimStartsAt,
  })
}

export function buildCommercialOfferV3FromDraft(
  draft: CommercialOfferDraftViewV3,
  context: { campaignVersionId: string; publishedAt: Date },
): EmittedCommercialOfferV3 {
  if (draft.offerSchemaVersion !== 3 || draft.status !== 'ACTIVE') {
    throw new ConflictError('El borrador no es una oferta v3 publicable.', 'COMMERCIAL_OFFER_DRAFT_SCHEMA_UNSUPPORTED')
  }
  if (draft.offerBenefits.some(benefit => benefit.kind === 'PAYMENTS_RATE_SCHEDULE')) {
    throw new ConflictError(
      'La autoridad inmutable de tasas todavía no está disponible.',
      'COMMERCIAL_OFFER_RATE_SCHEDULE_AUTHORITY_UNAVAILABLE',
    )
  }
  const benefits: CommercialBenefitV3[] = draft.offerBenefits.map(benefit => {
    if (benefit.kind === 'HARDWARE_PERCENT_OFF') {
      return {
        benefitCode: benefit.benefitCode,
        kind: benefit.kind,
        skuSnapshot: createHardwareSkuSnapshotV3(benefit.hardwareCatalogKey),
        percentBasisPoints: benefit.percentBasisPoints,
        quantityLimit: benefit.quantityLimit,
        benefitStartsAt: benefit.benefitStartsAt,
        benefitEndsAt: benefit.benefitEndsAt,
      }
    }
    if (benefit.kind === 'HARDWARE_FIXED_PRICE') {
      return {
        benefitCode: benefit.benefitCode,
        kind: benefit.kind,
        skuSnapshot: createHardwareSkuSnapshotV3(benefit.hardwareCatalogKey),
        unitAmountMinor: benefit.unitAmountMinor,
        quantityLimit: benefit.quantityLimit,
        benefitStartsAt: benefit.benefitStartsAt,
        benefitEndsAt: benefit.benefitEndsAt,
      }
    }
    throw new ConflictError(
      'La autoridad inmutable de tasas todavía no está disponible.',
      'COMMERCIAL_OFFER_RATE_SCHEDULE_AUTHORITY_UNAVAILABLE',
    )
  })
  if (draft.rules.length > 0) {
    benefits.push({
      benefitCode: 'SAAS_PRICE',
      kind: 'SAAS_PRICE',
      // The draft graph has already passed the canonical Campaign v2 validator.
      // The immutable Offer validator revalidates this projection before hashing.
      stackingGroups: draft.stackingGroups as unknown as Extract<CommercialBenefitV3, { kind: 'SAAS_PRICE' }>['stackingGroups'],
      rules: draft.rules as unknown as Extract<CommercialBenefitV3, { kind: 'SAAS_PRICE' }>['rules'],
    })
  }
  benefits.sort((left, right) => (left.benefitCode < right.benefitCode ? -1 : left.benefitCode > right.benefitCode ? 1 : 0))
  return emitCommercialOfferV3({
    schemaVersion: 3,
    contractVersion: '3.0.0',
    campaignVersionId: context.campaignVersionId,
    campaignCode: draft.code,
    version: draft.revision,
    status: draft.status,
    publishedAt: context.publishedAt.toISOString(),
    claimStartsAt: draft.startsAt,
    claimEndsAt: draft.endsAt,
    benefits,
  })
}

export function createCommercialOfferPublicationService(dependencies: CommercialOfferPublicationDependencies) {
  return {
    async publish(input: PublishCommercialOfferV3Input, actor: CommercialPublisherActor): Promise<VerifiedStoredCommercialOfferV3> {
      requirePublisher(actor)
      if (
        input.confirm !== true ||
        !Number.isInteger(input.expectedDraftRevision) ||
        input.expectedDraftRevision < 1 ||
        input.expectedDraftRevision > 2_147_483_647
      ) {
        throw new ValidationError('Confirma una revisión válida de oferta.')
      }
      const reason = input.reason.trim()
      if (reason.length < 3 || reason.length > 500) throw new ValidationError('Se requiere un motivo de publicación.')
      return runWithCommercialCompatibilityObservation('OFFER_PUBLISH', () => dependencies.runInTransaction(async tx => {
        const draft = await tx.lockDraft(input.draftId)
        if (!draft) throw new NotFoundError('Borrador de oferta no encontrado.')
        if (draft.offerSchemaVersion !== 3) {
          throw new ConflictError('El borrador no pertenece a Offer v3.', 'COMMERCIAL_OFFER_DRAFT_SCHEMA_UNSUPPORTED')
        }
        if (draft.revision !== input.expectedDraftRevision) {
          throw new ConflictError('La revisión del borrador de oferta cambió.', 'COMMERCIAL_OFFER_DRAFT_CONFLICT')
        }
        const existing = await tx.findVersionBySourceRevision(draft.id, draft.revision)
        if (existing) {
          const verified = verifyStored(existing)
          await validateAgainstProductionCatalog(tx, verified)
          return verified
        }

        const publishedAt = dependencies.now()
        const emitted = buildCommercialOfferV3FromDraft(draft, {
          campaignVersionId: dependencies.randomId(),
          publishedAt,
        })
        await validateAgainstProductionCatalog(tx, emitted)
        const created = await tx.createVersion({
          sourceDraftId: draft.id,
          sourceRevision: draft.revision,
          emitted,
          reason,
          publishedById: actor.staffId,
          publishedAt,
        })
        const verified = verifyStored(created)
        await tx.writeAudit({
          action: 'COMMERCIAL_OFFER_V3_PUBLISHED',
          entityId: created.id,
          actor: { ...actor, reason },
          data: {
            campaignCode: draft.code,
            sourceDraftId: draft.id,
            sourceRevision: draft.revision,
            schemaVersion: 3,
            checksum: created.checksum,
          },
        })
        return verified
      }))
    },
  }
}

const prismaCommercialOfferWriterTransaction = createCommercialWriterTransactionRunner({ host: prisma })

const prismaCommercialOfferPublicationDependencies: CommercialOfferPublicationDependencies = {
  now: () => new Date(),
  randomId: randomUUID,
  runInTransaction: operation =>
    prismaCommercialOfferWriterTransaction.run(async prismaTx => {
        const tx: CommercialOfferPublicationTransaction = {
          lockDraft: id => loadCommercialOfferDraftGraphV3(prismaTx, id, { consistency: 'FOR_UPDATE' }),
          async getProductionCatalog() {
            const activation = await prismaTx.commercialPublicationActivation.findUnique({
              where: { environment: 'PRODUCTION' },
              include: { publication: true },
            })
            return activation?.publication ?? null
          },
          findVersionBySourceRevision: (draftId, revision) =>
            prismaTx.commercialCampaignVersion.findUnique({
              where: {
                sourceDraftId_sourceRevision_schemaVersion: {
                  sourceDraftId: draftId,
                  sourceRevision: revision,
                  schemaVersion: 3,
                },
              },
            }),
          createVersion: input =>
            prismaTx.commercialCampaignVersion.create({
              data: {
                id: input.emitted.snapshot.campaignVersionId,
                campaignCode: input.emitted.snapshot.campaignCode,
                sourceDraftId: input.sourceDraftId,
                sourceRevision: input.sourceRevision,
                schemaVersion: 3,
                snapshot: input.emitted.snapshot as unknown as Prisma.InputJsonValue,
                checksum: input.emitted.checksum,
                reason: input.reason,
                publishedById: input.publishedById,
                publishedAt: input.publishedAt,
              },
            }),
          async writeAudit(input) {
            await prismaTx.activityLog.create({
              data: {
                staffId: input.actor.staffId,
                actorType: null,
                action: input.action,
                entity: 'CommercialCampaignVersion',
                entityId: input.entityId,
                ipAddress: input.actor.ipAddress,
                userAgent: input.actor.userAgent,
                data: { reason: input.actor.reason, ...input.data },
              },
            })
          },
        }
        return operation(tx)
      }),
}

export const commercialOfferPublicationService = createCommercialOfferPublicationService(
  prismaCommercialOfferPublicationDependencies,
)
