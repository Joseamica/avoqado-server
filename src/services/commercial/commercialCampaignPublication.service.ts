import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/errors/AppError'
import type { CommercialPublisherActor } from '@/types/commercial'
import type { CommercialCampaignDraftView } from '@/types/commercialQuote'
import prisma from '@/utils/prismaClient'
import {
  CommercialArtifactCodecError,
  assertEmittedCommercialCampaignV2,
  type CampaignV2Result,
} from './commercialArtifactCodecRegistry.service'
import { decodeVerifiedCommercialCampaignAuthority, type VerifiedCommercialCampaignAuthority } from './commercialCampaignAuthority.service'
import { loadCommercialCampaignDraftGraph } from './commercialCampaignDraftGraph.service'
import { buildCommercialCampaignV2 } from './commercialCampaignV2Builder.service'

interface CampaignVersionRecord {
  id: string
  campaignCode: string
  sourceDraftId: string
  sourceRevision: number
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

interface CampaignActivationRecord {
  id: string
  campaignCode: string
  campaignVersionId: string
  revision: number
  campaignVersion: CampaignVersionRecord
}

interface CampaignAudit {
  action: 'COMMERCIAL_CAMPAIGN_PUBLISHED' | 'COMMERCIAL_CAMPAIGN_ACTIVATED' | 'COMMERCIAL_CAMPAIGN_ROLLED_BACK'
  entity: 'CommercialCampaignVersion' | 'CommercialCampaignActivation'
  entityId: string
  actor: CommercialPublisherActor
  data: Record<string, unknown>
}

export interface CommercialCampaignPublicationTransaction {
  lockDraft(id: string): Promise<CommercialCampaignDraftView | null>
  findVersionBySourceRevision(draftId: string, revision: number): Promise<CampaignVersionRecord | null>
  createVersion(input: {
    id: string
    campaignCode: string
    sourceDraftId: string
    sourceRevision: number
    emitted: CampaignV2Result
    reason: string
    publishedById: string
    publishedAt: Date
  }): Promise<CampaignVersionRecord>
  getVersion(id: string): Promise<CampaignVersionRecord | null>
  getActivation(campaignCode: string): Promise<CampaignActivationRecord | null>
  createActivation(input: {
    id: string
    campaignCode: string
    campaignVersionId: string
    reason: string
    updatedById: string
  }): Promise<CampaignActivationRecord>
  moveActivationIfRevision(input: {
    campaignCode: string
    campaignVersionId: string
    expectedRevision: number
    reason: string
    updatedById: string
  }): Promise<CampaignActivationRecord | null>
  writeAudit(input: CampaignAudit): Promise<void>
}

export interface CommercialCampaignPublicationDependencies {
  now(): Date
  randomId(): string
  runInTransaction<T>(operation: (tx: CommercialCampaignPublicationTransaction) => Promise<T>): Promise<T>
}

export interface PublishAndActivateCampaignInput {
  draftId: string
  expectedDraftRevision: number
  expectedActivationRevision: number | null
  reason: string
  confirm: true
}

export interface ActivateCampaignVersionInput {
  campaignCode: string
  campaignVersionId: string
  expectedActivationRevision: number
  reason: string
  confirm: true
}

function requirePublisher(actor: CommercialPublisherActor): void {
  if (!actor.permissions.includes('commercial:publish') && !actor.permissions.includes('*')) {
    throw new ForbiddenError('No tienes permiso para publicar campañas.', 'COMMERCIAL_CAMPAIGN_PUBLISH_FORBIDDEN')
  }
}

function reason(input: string): string {
  const normalized = input.trim()
  if (normalized.length < 3 || normalized.length > 500) throw new ValidationError('Se requiere un motivo de campaña.')
  return normalized
}

function isRevision(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647
}

function campaignVersionInvalid(): ConflictError {
  return new ConflictError('La versión de campaña no es válida.', 'COMMERCIAL_CAMPAIGN_VERSION_INVALID')
}

function verifyCampaignVersion(
  version: CampaignVersionRecord,
  expectedCampaignCode: string,
  requireV2: boolean,
): VerifiedCommercialCampaignAuthority {
  let authority: VerifiedCommercialCampaignAuthority
  try {
    authority = decodeVerifiedCommercialCampaignAuthority({
      kind: 'CAMPAIGN',
      rowSchemaVersion: version.schemaVersion,
      snapshot: version.snapshot,
      checksum: version.checksum,
      rowContext: {
        kind: 'CAMPAIGN',
        id: version.id,
        campaignCode: version.campaignCode,
        sourceRevision: version.sourceRevision,
        schemaVersion: version.schemaVersion,
        publishedAt: version.publishedAt,
      },
    })
  } catch (error) {
    if (error instanceof CommercialArtifactCodecError) throw campaignVersionInvalid()
    throw error
  }
  if (authority.campaignCode !== expectedCampaignCode || (requireV2 && authority.schemaVersion !== 2)) {
    throw campaignVersionInvalid()
  }
  return authority
}

function verifyCurrentCampaignVersion(
  activation: CampaignActivationRecord,
  expectedCampaignCode: string,
): VerifiedCommercialCampaignAuthority {
  if (
    activation.campaignCode !== expectedCampaignCode ||
    activation.campaignVersionId !== activation.campaignVersion.id ||
    activation.campaignVersion.campaignCode !== expectedCampaignCode
  ) {
    throw campaignVersionInvalid()
  }
  return verifyCampaignVersion(activation.campaignVersion, expectedCampaignCode, false)
}

function classifyCampaignActivation(
  current: CampaignVersionRecord,
  currentAuthority: VerifiedCommercialCampaignAuthority,
  target: CampaignVersionRecord,
): 'COMMERCIAL_CAMPAIGN_ACTIVATED' | 'COMMERCIAL_CAMPAIGN_ROLLED_BACK' {
  if (currentAuthority.schemaVersion === 1) return 'COMMERCIAL_CAMPAIGN_ACTIVATED'
  if (current.sourceRevision === target.sourceRevision) throw campaignVersionInvalid()
  return target.sourceRevision > current.sourceRevision ? 'COMMERCIAL_CAMPAIGN_ACTIVATED' : 'COMMERCIAL_CAMPAIGN_ROLLED_BACK'
}

export function createCommercialCampaignPublicationService(dependencies: CommercialCampaignPublicationDependencies) {
  return {
    async publishAndActivate(input: PublishAndActivateCampaignInput, actor: CommercialPublisherActor) {
      requirePublisher(actor)
      if (input.confirm !== true || !isRevision(input.expectedDraftRevision)) {
        throw new ValidationError('Confirma una revisión válida de campaña.')
      }
      const publishReason = reason(input.reason)
      const auditActor = { ...actor, reason: publishReason }
      return dependencies.runInTransaction(async tx => {
        const draft = await tx.lockDraft(input.draftId)
        if (!draft) throw new NotFoundError('Borrador de campaña no encontrado.')
        if (draft.revision !== input.expectedDraftRevision) {
          throw new ConflictError('La revisión del borrador de campaña cambió.', 'COMMERCIAL_CAMPAIGN_DRAFT_CONFLICT')
        }
        let version = await tx.findVersionBySourceRevision(draft.id, draft.revision)
        let versionCreated = false
        if (!version) {
          const publishedAt = dependencies.now()
          const built = buildCommercialCampaignV2(draft, {
            campaignVersionId: dependencies.randomId(),
            publishedAt,
          })
          version = await tx.createVersion({
            id: built.snapshot.campaignVersionId,
            campaignCode: draft.code,
            sourceDraftId: draft.id,
            sourceRevision: draft.revision,
            emitted: built,
            reason: publishReason,
            publishedById: actor.staffId,
            publishedAt,
          })
          versionCreated = true
        }
        verifyCampaignVersion(version, draft.code, true)
        const current = await tx.getActivation(draft.code)
        const currentAuthority = current ? verifyCurrentCampaignVersion(current, draft.code) : null
        if (current?.campaignVersionId === version.id) {
          return { version, activation: current }
        }
        let activation: CampaignActivationRecord
        let activationAction: 'COMMERCIAL_CAMPAIGN_ACTIVATED' | 'COMMERCIAL_CAMPAIGN_ROLLED_BACK' = 'COMMERCIAL_CAMPAIGN_ACTIVATED'
        if (!current) {
          if (input.expectedActivationRevision !== null) {
            throw new ConflictError('La activación de campaña cambió.', 'COMMERCIAL_CAMPAIGN_ACTIVATION_CONFLICT')
          }
          activation = await tx.createActivation({
            id: dependencies.randomId(),
            campaignCode: draft.code,
            campaignVersionId: version.id,
            reason: publishReason,
            updatedById: actor.staffId,
          })
        } else {
          if (input.expectedActivationRevision !== current.revision) {
            throw new ConflictError('La activación de campaña cambió.', 'COMMERCIAL_CAMPAIGN_ACTIVATION_CONFLICT')
          }
          activationAction = classifyCampaignActivation(current.campaignVersion, currentAuthority!, version)
          const moved = await tx.moveActivationIfRevision({
            campaignCode: draft.code,
            campaignVersionId: version.id,
            expectedRevision: current.revision,
            reason: publishReason,
            updatedById: actor.staffId,
          })
          if (!moved) throw new ConflictError('La activación de campaña cambió.', 'COMMERCIAL_CAMPAIGN_ACTIVATION_CONFLICT')
          activation = moved
        }
        if (versionCreated) {
          await tx.writeAudit({
            action: 'COMMERCIAL_CAMPAIGN_PUBLISHED',
            entity: 'CommercialCampaignVersion',
            entityId: version.id,
            actor: auditActor,
            data: { campaignCode: draft.code, sourceDraftId: draft.id, sourceRevision: draft.revision, checksum: version.checksum },
          })
        }
        await tx.writeAudit({
          action: activationAction,
          entity: 'CommercialCampaignActivation',
          entityId: activation.id,
          actor: auditActor,
          data: { campaignCode: draft.code, campaignVersionId: version.id, revision: activation.revision },
        })
        return { version, activation }
      })
    },

    async activateVersion(input: ActivateCampaignVersionInput, actor: CommercialPublisherActor) {
      requirePublisher(actor)
      if (input.confirm !== true || !isRevision(input.expectedActivationRevision)) {
        throw new ValidationError('Confirma una revisión válida de activación de campaña.')
      }
      const activationReason = reason(input.reason)
      return dependencies.runInTransaction(async tx => {
        const version = await tx.getVersion(input.campaignVersionId)
        if (!version || version.campaignCode !== input.campaignCode) {
          throw campaignVersionInvalid()
        }
        verifyCampaignVersion(version, input.campaignCode, true)
        const current = await tx.getActivation(input.campaignCode)
        if (!current || current.revision !== input.expectedActivationRevision) {
          throw new ConflictError('La activación de campaña cambió.', 'COMMERCIAL_CAMPAIGN_ACTIVATION_CONFLICT')
        }
        const currentAuthority = verifyCurrentCampaignVersion(current, input.campaignCode)
        if (current.campaignVersionId === version.id) return current
        const action = classifyCampaignActivation(current.campaignVersion, currentAuthority, version)
        const moved = await tx.moveActivationIfRevision({
          campaignCode: input.campaignCode,
          campaignVersionId: version.id,
          expectedRevision: current.revision,
          reason: activationReason,
          updatedById: actor.staffId,
        })
        if (!moved) throw new ConflictError('La activación de campaña cambió.', 'COMMERCIAL_CAMPAIGN_ACTIVATION_CONFLICT')
        await tx.writeAudit({
          action,
          entity: 'CommercialCampaignActivation',
          entityId: moved.id,
          actor: { ...actor, reason: activationReason },
          data: {
            campaignCode: input.campaignCode,
            previousCampaignVersionId: current.campaignVersionId,
            campaignVersionId: version.id,
            revision: moved.revision,
          },
        })
        return moved
      })
    },
  }
}

export const prismaCommercialCampaignPublicationDependencies: CommercialCampaignPublicationDependencies = {
  now: () => new Date(),
  randomId: () => randomUUID(),
  runInTransaction: operation =>
    prisma.$transaction(
      async prismaTx => {
        const tx: CommercialCampaignPublicationTransaction = {
          async lockDraft(id) {
            return loadCommercialCampaignDraftGraph(prismaTx, id, { consistency: 'FOR_UPDATE' })
          },
          findVersionBySourceRevision: (sourceDraftId, sourceRevision) =>
            prismaTx.commercialCampaignVersion.findUnique({
              where: {
                sourceDraftId_sourceRevision_schemaVersion: { sourceDraftId, sourceRevision, schemaVersion: 2 },
              },
            }),
          createVersion: input => {
            assertEmittedCommercialCampaignV2(input.emitted)
            return prismaTx.commercialCampaignVersion.create({
              data: {
                id: input.id,
                campaignCode: input.campaignCode,
                sourceDraftId: input.sourceDraftId,
                sourceRevision: input.sourceRevision,
                schemaVersion: 2,
                snapshot: input.emitted.snapshot as unknown as Prisma.InputJsonValue,
                checksum: input.emitted.checksum,
                reason: input.reason,
                publishedById: input.publishedById,
                publishedAt: input.publishedAt,
              },
            })
          },
          getVersion: id => prismaTx.commercialCampaignVersion.findUnique({ where: { id } }),
          getActivation: campaignCode =>
            prismaTx.commercialCampaignActivation.findUnique({
              where: { environment_campaignCode: { environment: 'PRODUCTION', campaignCode } },
              include: { campaignVersion: true },
            }),
          createActivation: input =>
            prismaTx.commercialCampaignActivation.create({
              data: { ...input, environment: 'PRODUCTION' },
              include: { campaignVersion: true },
            }),
          async moveActivationIfRevision(input) {
            const changed = await prismaTx.commercialCampaignActivation.updateMany({
              where: { environment: 'PRODUCTION', campaignCode: input.campaignCode, revision: input.expectedRevision },
              data: {
                campaignVersionId: input.campaignVersionId,
                reason: input.reason,
                updatedById: input.updatedById,
                revision: { increment: 1 },
              },
            })
            if (changed.count !== 1) return null
            return prismaTx.commercialCampaignActivation.findUnique({
              where: { environment_campaignCode: { environment: 'PRODUCTION', campaignCode: input.campaignCode } },
              include: { campaignVersion: true },
            })
          },
          async writeAudit(input) {
            await prismaTx.activityLog.create({
              data: {
                staffId: input.actor.staffId,
                // Campaign publication is global, not tenant-owned. Keep the
                // legacy staff principal until ActivityLog supports global actors.
                actorType: null,
                action: input.action,
                entity: input.entity,
                entityId: input.entityId,
                ipAddress: input.actor.ipAddress,
                userAgent: input.actor.userAgent,
                data: { reason: input.actor.reason, ...input.data },
              },
            })
          },
        }
        return operation(tx)
      },
      { maxWait: 5_000, timeout: 30_000 },
    ),
}

export const commercialCampaignPublicationService = createCommercialCampaignPublicationService(
  prismaCommercialCampaignPublicationDependencies,
)
