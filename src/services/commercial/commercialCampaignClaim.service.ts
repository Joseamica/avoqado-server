import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { ForbiddenError } from '@/errors/AppError'
import AppError from '@/errors/AppError'
import type { CommercialPublisherActor } from '@/types/commercial'
import type {
  CommercialAcquisitionChannel,
  CommercialCampaignClaimRecordV1,
  CommercialResolvedCampaignClaimV1,
} from '@/types/commercialQuote'
import prisma from '@/utils/prismaClient'
import { CommercialArtifactCodecError } from './commercialArtifactCodecRegistry.service'
import {
  assertVerifiedStoredCommercialCampaignV2,
  type VerifiedStoredCommercialCampaignV2,
} from './commercialArtifactCodecRegistry.service'
import { decodeVerifiedCommercialCampaignAuthority, type VerifiedCommercialCampaignAuthority } from './commercialCampaignAuthority.service'
import { assertCommercialQuoteV2AuthorityContext, type CommercialQuoteV2AuthorityContext } from './commercialQuoteV2Authority.service'

const CLAIM_TOKEN = /^[A-Za-z0-9_-]{43}$/
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/
const SOURCE_REF = /^[A-Za-z0-9._:@/+\-=]{1,255}$/
const MAX_CLAIM_TTL_MS = 90 * 24 * 60 * 60 * 1000
const CLAIM_CHANNELS = new Set<CommercialAcquisitionChannel>(['PAID_META', 'PAID_GOOGLE', 'SELLER', 'DISTRIBUTOR', 'PARTNER'])

export interface CommercialCampaignClaimInput {
  campaignCode: string
  campaignVersionId: string
  channel: Exclude<CommercialAcquisitionChannel, 'ORGANIC' | 'DIRECT'>
  sourceRef: string
  expiresAt: string
  confirm: true
}

interface ActiveCampaignForClaim {
  campaignVersionId: string
  campaignCode: string
  authority: VerifiedCommercialCampaignAuthority
}

interface PersistedCampaignClaim extends CommercialCampaignClaimRecordV1 {
  activeCampaignVersionId: string | null
  campaignAuthority: VerifiedCommercialCampaignAuthority | null
}

export interface CampaignVersionForClaim {
  id: string
  campaignCode: string
  sourceRevision: number
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

export interface CommercialCampaignQuoteAuthorityRecord {
  activeCampaignVersionId: string | null
  campaignVersion: CampaignVersionForClaim
}

export interface CommercialCampaignQuoteAuthorityRepository {
  findVersionAndProductionActivation(campaignVersionId: string): Promise<CommercialCampaignQuoteAuthorityRecord | null>
}

interface CampaignClaimAudit {
  action: 'COMMERCIAL_ACQUISITION_CLAIM_ISSUED'
  entity: 'CommercialCampaignClaim'
  entityId: string
  staffId: string
  reason: string
  ipAddress?: string
  userAgent?: string
  data: Record<string, unknown>
}

export interface CommercialCampaignClaimRepository {
  findActiveCampaign(campaignCode: string, campaignVersionId: string, now: Date): Promise<ActiveCampaignForClaim | null>
  createWithAudit(record: CommercialCampaignClaimRecordV1, audit: CampaignClaimAudit): Promise<void>
  findByTokenHash(tokenHash: string): Promise<PersistedCampaignClaim | null>
}

interface CommercialCampaignClaimDependencies {
  repository: CommercialCampaignClaimRepository
  randomToken?: () => string
  randomId?: () => string
}

function claimError(code: string, message: string, statusCode = 422): AppError {
  return new AppError(message, statusCode, true, code)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function requirePublisher(actor: CommercialPublisherActor): void {
  if (!actor.permissions.includes('commercial:publish') && !actor.permissions.includes('*')) {
    throw new ForbiddenError('No tienes permiso para emitir enlaces de campaña.', 'COMMERCIAL_CAMPAIGN_CLAIM_FORBIDDEN')
  }
}

function decodeCampaignAuthority(version: CampaignVersionForClaim): VerifiedCommercialCampaignAuthority | null {
  try {
    return decodeVerifiedCommercialCampaignAuthority({
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
    if (error instanceof CommercialArtifactCodecError) return null
    throw error
  }
}

function isActiveAt(authority: VerifiedCommercialCampaignAuthority, now: Date): boolean {
  let nowTime: number
  try {
    nowTime = Date.prototype.getTime.call(now)
  } catch {
    nowTime = Number.NaN
  }
  const startsAt = Date.parse(authority.startsAt)
  const endsAt = Date.parse(authority.endsAt)
  return authority.status === 'ACTIVE' && Number.isFinite(nowTime) && nowTime >= startsAt && nowTime < endsAt
}

export const prismaCommercialCampaignClaimRepository: CommercialCampaignClaimRepository = {
  async findActiveCampaign(campaignCode, campaignVersionId, now) {
    const activation = await prisma.commercialCampaignActivation.findUnique({
      where: { environment_campaignCode: { environment: 'PRODUCTION', campaignCode } },
      include: { campaignVersion: true },
    })
    if (!activation || activation.campaignVersionId !== campaignVersionId) return null
    const authority = decodeCampaignAuthority(activation.campaignVersion)
    if (
      !authority ||
      activation.campaignCode !== campaignCode ||
      authority.campaignVersionId !== campaignVersionId ||
      authority.campaignCode !== campaignCode ||
      !isActiveAt(authority, now)
    ) {
      return null
    }
    return { campaignVersionId, campaignCode, authority }
  },
  async createWithAudit(record, audit) {
    await prisma.$transaction(async tx => {
      await tx.commercialCampaignClaim.create({
        data: {
          id: record.id,
          tokenHash: record.tokenHash,
          campaignVersionId: record.campaignVersionId,
          campaignCode: record.campaignCode,
          channel: record.channel,
          sourceRef: record.sourceRef,
          issuedById: record.issuedById,
          reason: record.reason,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        },
      })
      await tx.activityLog.create({
        data: {
          staffId: audit.staffId,
          actorType: null,
          action: audit.action,
          entity: audit.entity,
          entityId: audit.entityId,
          ipAddress: audit.ipAddress,
          userAgent: audit.userAgent,
          data: { reason: audit.reason, ...audit.data } as Prisma.InputJsonObject,
        },
      })
    })
  },
  async findByTokenHash(tokenHash) {
    return prisma.$transaction(
      async tx => {
        const record = await tx.commercialCampaignClaim.findUnique({
          where: { tokenHash },
          include: { campaignVersion: true },
        })
        if (
          !record ||
          record.campaignVersionId === null ||
          record.campaignCode === null ||
          record.campaignVersion === null
        ) {
          return null
        }
        const activation = await tx.commercialCampaignActivation.findUnique({
          where: { environment_campaignCode: { environment: 'PRODUCTION', campaignCode: record.campaignCode } },
        })
        const campaignVersion = record.campaignVersion
        const claim: CommercialCampaignClaimRecordV1 = {
          id: record.id,
          tokenHash: record.tokenHash,
          campaignVersionId: record.campaignVersionId,
          campaignCode: record.campaignCode,
          channel: record.channel,
          sourceRef: record.sourceRef,
          issuedById: record.issuedById,
          reason: record.reason,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        }
        return {
          ...claim,
          activeCampaignVersionId: activation?.campaignVersionId ?? null,
          campaignAuthority: decodeCampaignAuthority(campaignVersion),
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 30_000,
      },
    )
  },
}

export const prismaCommercialCampaignQuoteAuthorityRepository: CommercialCampaignQuoteAuthorityRepository = {
  async findVersionAndProductionActivation(campaignVersionId) {
    return prisma.$transaction(
      async tx => {
        const row = await tx.commercialCampaignVersion.findUnique({
          where: { id: campaignVersionId },
          include: {
            activations: {
              where: { environment: 'PRODUCTION' },
              select: { campaignVersionId: true },
              take: 1,
            },
          },
        })
        if (!row) return null
        const { activations, ...campaignVersion } = row
        return {
          campaignVersion,
          activeCampaignVersionId: activations[0]?.campaignVersionId ?? null,
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 30_000,
      },
    )
  },
}

interface CommercialCampaignQuoteAuthorityLoaderDependencies {
  repository: CommercialCampaignQuoteAuthorityRepository
}

function campaignNotActive(): never {
  throw claimError('COMMERCIAL_CAMPAIGN_NOT_ACTIVE', 'La versión de campaña no está activa.', 409)
}

export function createCommercialCampaignQuoteAuthorityLoader(
  dependencies: CommercialCampaignQuoteAuthorityLoaderDependencies = {
    repository: prismaCommercialCampaignQuoteAuthorityRepository,
  },
) {
  return {
    async load(
      authorityContext: CommercialQuoteV2AuthorityContext,
      campaignVersionId: string,
      issuedAt: Date,
    ): Promise<VerifiedStoredCommercialCampaignV2> {
      assertCommercialQuoteV2AuthorityContext(authorityContext)
      if (typeof campaignVersionId !== 'string' || campaignVersionId.length < 1 || campaignVersionId.length > 128) {
        return campaignNotActive()
      }
      const record = await dependencies.repository.findVersionAndProductionActivation(campaignVersionId)
      if (!record || record.activeCampaignVersionId !== campaignVersionId || record.campaignVersion.id !== campaignVersionId) {
        return campaignNotActive()
      }
      const authority = decodeCampaignAuthority(record.campaignVersion)
      if (
        !authority ||
        authority.schemaVersion !== 2 ||
        authority.campaignVersionId !== campaignVersionId ||
        !isActiveAt(authority, issuedAt)
      ) {
        return campaignNotActive()
      }
      assertVerifiedStoredCommercialCampaignV2(authority.artifact)
      return authority.artifact
    },
  }
}

export const commercialCampaignQuoteAuthorityLoader = createCommercialCampaignQuoteAuthorityLoader()

export function createCommercialCampaignClaimService(dependencies: CommercialCampaignClaimDependencies) {
  const randomToken = dependencies.randomToken ?? (() => randomBytes(32).toString('base64url'))
  const randomId = dependencies.randomId ?? randomUUID

  return {
    async issue(
      input: CommercialCampaignClaimInput,
      actor: CommercialPublisherActor,
      now: Date,
    ): Promise<{ claim: string; expiresAt: string }> {
      requirePublisher(actor)
      const expiresAt = new Date(input.expiresAt)
      const reason = actor.reason.trim()
      if (
        input.confirm !== true ||
        !CODE.test(input.campaignCode) ||
        !input.campaignVersionId ||
        !CLAIM_CHANNELS.has(input.channel) ||
        !SOURCE_REF.test(input.sourceRef) ||
        reason.length < 3 ||
        reason.length > 500 ||
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt <= now ||
        expiresAt.getTime() - now.getTime() > MAX_CLAIM_TTL_MS
      ) {
        throw claimError('COMMERCIAL_CAMPAIGN_CLAIM_INVALID', 'La solicitud de enlace de campaña es inválida.')
      }
      const campaign = await dependencies.repository.findActiveCampaign(input.campaignCode, input.campaignVersionId, now)
      if (!campaign) {
        throw claimError('COMMERCIAL_CAMPAIGN_NOT_ACTIVE', 'La versión de campaña no está activa.', 409)
      }
      if (expiresAt > new Date(campaign.authority.endsAt)) {
        throw claimError('COMMERCIAL_CAMPAIGN_CLAIM_EXPIRY_INVALID', 'El enlace no puede durar más que la campaña activa.')
      }
      const claim = randomToken()
      if (!CLAIM_TOKEN.test(claim)) {
        throw claimError('COMMERCIAL_CAMPAIGN_CLAIM_ENTROPY_INVALID', 'No se pudo emitir un enlace seguro.', 500)
      }
      const record: CommercialCampaignClaimRecordV1 = {
        id: randomId(),
        tokenHash: hashToken(claim),
        campaignVersionId: campaign.campaignVersionId,
        campaignCode: campaign.campaignCode,
        channel: input.channel,
        sourceRef: input.sourceRef,
        issuedById: actor.staffId,
        reason,
        createdAt: now,
        expiresAt,
      }
      await dependencies.repository.createWithAudit(record, {
        action: 'COMMERCIAL_ACQUISITION_CLAIM_ISSUED',
        entity: 'CommercialCampaignClaim',
        entityId: record.id,
        staffId: actor.staffId,
        reason,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        data: {
          campaignVersionId: record.campaignVersionId,
          campaignCode: record.campaignCode,
          channel: record.channel,
          sourceRef: record.sourceRef,
          expiresAt: record.expiresAt.toISOString(),
        },
      })
      return { claim, expiresAt: expiresAt.toISOString() }
    },

    async resolve(claim: string, now: Date): Promise<CommercialResolvedCampaignClaimV1> {
      if (!CLAIM_TOKEN.test(claim)) {
        throw claimError('COMMERCIAL_CAMPAIGN_CLAIM_INVALID', 'El enlace de campaña es inválido.')
      }
      const record = await dependencies.repository.findByTokenHash(hashToken(claim))
      if (!record) {
        throw claimError('COMMERCIAL_CAMPAIGN_CLAIM_NOT_FOUND', 'El enlace de campaña no existe.', 404)
      }
      if (record.expiresAt <= now) {
        throw claimError('COMMERCIAL_CAMPAIGN_CLAIM_EXPIRED', 'El enlace de campaña venció.', 410)
      }
      if (
        !record.campaignAuthority ||
        record.activeCampaignVersionId !== record.campaignVersionId ||
        record.campaignAuthority.campaignVersionId !== record.campaignVersionId ||
        record.campaignAuthority.campaignCode !== record.campaignCode ||
        !isActiveAt(record.campaignAuthority, now)
      ) {
        throw claimError('COMMERCIAL_CAMPAIGN_NOT_ACTIVE', 'La versión de campaña ya no está activa.', 409)
      }
      return {
        campaignVersionId: record.campaignVersionId,
        campaignCode: record.campaignCode,
        channel: record.channel,
        sourceRef: record.sourceRef,
      }
    },
  }
}

export const commercialCampaignClaimService = createCommercialCampaignClaimService({
  repository: prismaCommercialCampaignClaimRepository,
})
