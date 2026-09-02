import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/errors/AppError'
import type { CommercialPublisherActor } from '@/types/commercial'
import { commercialActivityLogData, type CommercialAuditInput } from './commercialAudit.service'
import {
  CommercialCatalogAuthorityError,
  type CommercialCatalogAuthorityChainDecision,
  type CommercialCatalogAuthorityPointer,
  verifyCommercialCatalogActivationChain,
  verifyEmergencyCommercialCatalogV1Target,
  verifyNormalCommercialCatalogActivationTarget,
} from './commercialCatalogAuthority.service'
import type { CommercialCatalogActivationOutboxRecord, CommercialCatalogPersistedRow } from '@/types/commercialCodec'
import type { VerifiedStoredCommercialOfferV3 } from '@/types/commercialOfferV3'
import { decodeAndVerifyStoredCommercialCatalogV2 } from './commercialArtifactCodecRegistry.service'
import { validateCommercialCatalogOfferCompatibilityV3 } from './offers/commercialCatalogOfferCompatibility.service'
import { loadEligibleCommercialOffersV3 } from './offers/commercialOfferEligibility.service'
import { createCommercialEligibleOfferWriterSnapshotRunner } from './offers/commercialEligibleOfferWriterSnapshot.service'
import { createCommercialWriterTransactionRunner } from './commercialWriterTransaction.service'
import { runWithCommercialCompatibilityObservation } from './offers/commercialCompatibilityObservability.service'

type ActivatablePublication = CommercialCatalogPersistedRow

interface ActivationMove {
  publicationId: string
  previousPublicationId: string | null
  revision: number
}

interface CommercialActivationState {
  pointer: CommercialCatalogAuthorityPointer | null
  activationEvents: readonly CommercialCatalogActivationOutboxRecord[]
}

interface CommercialActivationTransaction {
  getEligibleOffers(now: Date): Promise<readonly VerifiedStoredCommercialOfferV3[]>
  lockProductionState(): Promise<CommercialActivationState>
  getPublication(id: string): Promise<ActivatablePublication | null>
  movePointerIfRevision(
    publicationId: string,
    expectedRevision: number,
    actorStaffId: string,
    reason: string,
  ): Promise<ActivationMove | null>
  writeAudit(input: CommercialAuditInput): Promise<void>
  enqueue(input: {
    eventType: 'PUBLICATION_ACTIVATED' | 'PUBLICATION_ROLLED_BACK'
    publication: ActivatablePublication
    previousPublicationId: string | null
    activationRevision: number
    occurredAt: Date
  }): Promise<void>
}

export interface CommercialActivationServiceDependencies {
  runInTransaction<T>(operation: (tx: CommercialActivationTransaction) => Promise<T>): Promise<T>
  runWithEligibleOffers<T>(
    now: Date,
    operation: (tx: CommercialActivationTransaction, offers: readonly VerifiedStoredCommercialOfferV3[]) => Promise<T>,
  ): Promise<T>
  now?: () => Date
}

export interface ActivateCommercialPublicationInput {
  publicationId: string
  expectedActivationRevision: number
  reason: string
  confirm: true
}

export type EmergencyReactivateCommercialPublicationV1Input = ActivateCommercialPublicationInput

export interface EmergencyActivationMove extends ActivationMove {
  emergency: true
  noOp?: true
}

function requirePublisher(actor: CommercialPublisherActor): void {
  if (!actor.permissions.includes('commercial:publish') && !actor.permissions.includes('*')) {
    throw new ForbiddenError('No tienes permiso para activar el catálogo comercial.', 'COMMERCIAL_PUBLISH_FORBIDDEN')
  }
}

const prismaCommercialActivationWriterTransaction = createCommercialWriterTransactionRunner({ host: prisma })

function createPrismaCommercialActivationTransaction(prismaTx: Prisma.TransactionClient): CommercialActivationTransaction {
  return {
    getEligibleOffers: now => loadEligibleCommercialOffersV3(prismaTx, now),
    async lockProductionState() {
      await prismaTx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "CommercialPublicationActivation"
        WHERE "environment" = 'PRODUCTION'
        FOR UPDATE
      `
      const pointer = (await prismaTx.commercialPublicationActivation.findUnique({
        where: { environment: 'PRODUCTION' },
        include: { publication: true },
      })) as CommercialCatalogAuthorityPointer | null
      if (!pointer) return { pointer: null, activationEvents: [] }
      const activationEvents = (await prismaTx.commercialPublicationOutbox.findMany({
        where: { eventType: { in: ['PUBLICATION_ACTIVATED', 'PUBLICATION_ROLLED_BACK'] } },
        include: { publication: true, previousPublication: true },
      })) as CommercialCatalogActivationOutboxRecord[]
      return { pointer, activationEvents }
    },
    getPublication: id =>
      prismaTx.commercialPublication.findUnique({
        where: { id },
        select: { id: true, checksum: true, schemaVersion: true, snapshot: true, publishedAt: true },
      }),
    async movePointerIfRevision(publicationId, expectedRevision, actorStaffId, reason) {
      const current = await prismaTx.commercialPublicationActivation.findUnique({ where: { environment: 'PRODUCTION' } })
      if (!current) {
        if (expectedRevision !== 0) return null
        try {
          const created = await prismaTx.commercialPublicationActivation.create({
            data: {
              environment: 'PRODUCTION',
              publicationId,
              revision: 1,
              reason,
              updatedById: actorStaffId,
            },
          })
          return { publicationId, previousPublicationId: null, revision: created.revision }
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null
          throw error
        }
      }
      const changed = await prismaTx.commercialPublicationActivation.updateMany({
        where: { id: current.id, revision: expectedRevision },
        data: { publicationId, reason, updatedById: actorStaffId, revision: { increment: 1 } },
      })
      if (changed.count !== 1) return null
      return { publicationId, previousPublicationId: current.publicationId, revision: expectedRevision + 1 }
    },
    async writeAudit(input) {
      await prismaTx.activityLog.create({ data: commercialActivityLogData(input) })
    },
    async enqueue(input) {
      const eventId = `commercial:activation:${input.activationRevision}:${input.publication.id}`
      await prismaTx.commercialPublicationOutbox.create({
        data: {
          eventType: input.eventType,
          publicationId: input.publication.id,
          previousPublicationId: input.previousPublicationId,
          dedupeKey: eventId,
          payload: {
            eventId,
            type: input.eventType,
            publicationId: input.publication.id,
            previousPublicationId: input.previousPublicationId,
            schemaVersion: input.publication.schemaVersion,
            checksum: input.publication.checksum,
            occurredAt: input.occurredAt.toISOString(),
          },
        },
      })
    },
  }
}

const prismaCommercialActivationEligibilityRunner = createCommercialEligibleOfferWriterSnapshotRunner({
  reader: prisma,
  runSerialized: <T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>) =>
    prismaCommercialActivationWriterTransaction.run(operation),
})

export const prismaCommercialActivationDependencies: CommercialActivationServiceDependencies = {
  now: () => new Date(),
  runInTransaction: operation =>
    prismaCommercialActivationWriterTransaction.run(prismaTx => operation(createPrismaCommercialActivationTransaction(prismaTx))),
  runWithEligibleOffers: (now, operation) =>
    prismaCommercialActivationEligibilityRunner.run(now, (prismaTx, offers) =>
      operation(createPrismaCommercialActivationTransaction(prismaTx), offers),
    ),
}

function authorityConflict(error: unknown): never {
  if (error instanceof CommercialCatalogAuthorityError) {
    throw new ConflictError(error.message, error.code)
  }
  throw error
}

function emergencyAuthorityConflict(error: unknown): never {
  if (error instanceof CommercialCatalogAuthorityError) {
    throw new ConflictError(
      'La reactivación de emergencia v1 no pudo comprobar publicación e historial.',
      'COMMERCIAL_CATALOG_V1_EMERGENCY_ROLLBACK_INVALID',
    )
  }
  throw error
}

function validateActivationInput(input: ActivateCommercialPublicationInput): string {
  if (input.confirm !== true) throw new ValidationError('Confirma explícitamente la activación.')
  if (!Number.isInteger(input.expectedActivationRevision) || input.expectedActivationRevision < 0) {
    throw new ValidationError('La revisión de activación debe ser un entero no negativo.')
  }
  const reason = input.reason.trim()
  if (reason.length < 3 || reason.length > 500) throw new ValidationError('Se requiere un motivo de activación.')
  return reason
}

export function createCommercialActivationService(dependencies: CommercialActivationServiceDependencies) {
  const now = dependencies.now ?? (() => new Date())
  return {
    async emergencyReactivateCommercialPublicationV1(
      input: EmergencyReactivateCommercialPublicationV1Input,
      actor: CommercialPublisherActor,
    ): Promise<EmergencyActivationMove> {
      requirePublisher(actor)
      const reason = validateActivationInput(input)
      // Gate 1 is intentionally absent here: the authority verifier below accepts only Catalog v1,
      // so this emergency route cannot create a Catalog v2 × Offer v3 pair. Returning to v2 always
      // uses activateCommercialPublication, which reloads and validates every eligible Offer.
      return dependencies.runInTransaction(async tx => {
        const state = await tx.lockProductionState()
        if (!state.pointer) {
          throw new ConflictError(
            'No existe una cadena activa que autorice la reactivación v1.',
            'COMMERCIAL_CATALOG_V1_EMERGENCY_ROLLBACK_INVALID',
          )
        }
        if (state.pointer.revision !== input.expectedActivationRevision) {
          throw new ConflictError('La activación cambió mientras la editabas.', 'COMMERCIAL_ACTIVATION_REVISION_CONFLICT')
        }
        let chain: CommercialCatalogAuthorityChainDecision
        try {
          chain = verifyCommercialCatalogActivationChain({
            pointer: state.pointer,
            activationEvents: state.activationEvents,
          })
        } catch (error) {
          return emergencyAuthorityConflict(error)
        }
        const publication = await tx.getPublication(input.publicationId)
        if (!publication) throw new NotFoundError('Publicación comercial no encontrada.')
        try {
          verifyEmergencyCommercialCatalogV1Target(publication, chain)
        } catch (error) {
          return emergencyAuthorityConflict(error)
        }
        if (state.pointer.publicationId === publication.id) {
          return {
            publicationId: publication.id,
            previousPublicationId: publication.id,
            revision: state.pointer.revision,
            emergency: true,
            noOp: true,
          }
        }
        const moved = await tx.movePointerIfRevision(publication.id, input.expectedActivationRevision, actor.staffId, reason)
        if (!moved) {
          throw new ConflictError('La activación cambió mientras la editabas.', 'COMMERCIAL_ACTIVATION_REVISION_CONFLICT')
        }
        const auditActor = { ...actor, reason }
        await tx.writeAudit({
          action: 'COMMERCIAL_PUBLICATION_V1_EMERGENCY_REACTIVATED',
          entity: 'CommercialPublicationActivation',
          entityId: 'PRODUCTION',
          actor: auditActor,
          before: { publicationId: moved.previousPublicationId, revision: input.expectedActivationRevision },
          after: { publicationId: moved.publicationId, revision: moved.revision, emergency: true },
        })
        await tx.enqueue({
          eventType: 'PUBLICATION_ROLLED_BACK',
          publication,
          previousPublicationId: moved.previousPublicationId,
          activationRevision: moved.revision,
          occurredAt: now(),
        })
        return { ...moved, emergency: true }
      })
    },

    async activateCommercialPublication(
      input: ActivateCommercialPublicationInput,
      actor: CommercialPublisherActor,
    ): Promise<ActivationMove> {
      requirePublisher(actor)
      const reason = validateActivationInput(input)
      let compatibilityOperation: 'CATALOG_ACTIVATE' | 'CATALOG_ROLLBACK' = 'CATALOG_ACTIVATE'
      const eligibilityNow = now()
      const activateInTransaction = async (
        tx: CommercialActivationTransaction,
        preparedEligibleOffers: readonly VerifiedStoredCommercialOfferV3[],
      ): Promise<ActivationMove> => {
        const state = await tx.lockProductionState()
        let chain: CommercialCatalogAuthorityChainDecision | null = null
        if (state.pointer) {
          try {
            chain = verifyCommercialCatalogActivationChain({
              pointer: state.pointer,
              activationEvents: state.activationEvents,
            })
          } catch (error) {
            return authorityConflict(error)
          }
        }
        const publication = await tx.getPublication(input.publicationId)
        if (!publication) throw new NotFoundError('Publicación comercial no encontrada.')
        try {
          verifyNormalCommercialCatalogActivationTarget(publication)
        } catch (error) {
          return authorityConflict(error)
        }
        const catalog = decodeAndVerifyStoredCommercialCatalogV2({
          kind: 'CATALOG',
          rowSchemaVersion: publication.schemaVersion,
          snapshot: publication.snapshot,
          checksum: publication.checksum,
          rowContext: {
            kind: 'CATALOG',
            id: publication.id,
            schemaVersion: publication.schemaVersion,
            publishedAt: publication.publishedAt,
          },
        })
        compatibilityOperation =
          chain?.publications.some(item => item.id === publication.id) && state.pointer?.publicationId !== publication.id
            ? 'CATALOG_ROLLBACK'
            : 'CATALOG_ACTIVATE'
        for (const offer of preparedEligibleOffers) {
          validateCommercialCatalogOfferCompatibilityV3({
            catalog: catalog.snapshot,
            offer: offer.snapshot,
            resolvedAt: offer.snapshot.claimStartsAt,
          })
        }
        const moved = await tx.movePointerIfRevision(input.publicationId, input.expectedActivationRevision, actor.staffId, reason)
        if (!moved) {
          throw new ConflictError('La activación cambió mientras la editabas.', 'COMMERCIAL_ACTIVATION_REVISION_CONFLICT')
        }
        const eventType =
          moved.previousPublicationId !== publication.id && chain?.publications.some(item => item.id === publication.id)
            ? 'PUBLICATION_ROLLED_BACK'
            : 'PUBLICATION_ACTIVATED'
        const auditActor = { ...actor, reason }
        await tx.writeAudit({
          action: eventType === 'PUBLICATION_ROLLED_BACK' ? 'COMMERCIAL_PUBLICATION_ROLLED_BACK' : 'COMMERCIAL_PUBLICATION_ACTIVATED',
          entity: 'CommercialPublicationActivation',
          entityId: 'PRODUCTION',
          actor: auditActor,
          before: moved.previousPublicationId
            ? { publicationId: moved.previousPublicationId, revision: input.expectedActivationRevision }
            : null,
          after: { publicationId: moved.publicationId, revision: moved.revision },
        })
        await tx.enqueue({
          eventType,
          publication,
          previousPublicationId: moved.previousPublicationId,
          activationRevision: moved.revision,
          occurredAt: now(),
        })
        return moved
      }
      return runWithCommercialCompatibilityObservation(
        () => compatibilityOperation,
        () =>
            dependencies.runWithEligibleOffers(eligibilityNow, activateInTransaction),
      )
    },
  }
}

const commercialActivationService = createCommercialActivationService(prismaCommercialActivationDependencies)
export const activateCommercialPublication = commercialActivationService.activateCommercialPublication
export const emergencyReactivateCommercialPublicationV1 = commercialActivationService.emergencyReactivateCommercialPublicationV1
