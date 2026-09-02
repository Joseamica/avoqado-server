import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import AppError from '@/errors/AppError'
import { commercialAcquisitionRequestSchema } from '@/schemas/commercialQuote.schema'
import prisma from '@/utils/prismaClient'
import { commercialCampaignClaimService } from './commercialCampaignClaim.service'
import { assertCommercialQuoteV2AuthorityContext, type CommercialQuoteV2AuthorityContext } from './commercialQuoteV2Authority.service'
import type {
  CommercialAcquisitionAttributionV1,
  CommercialAcquisitionContextRecordV1,
  CommercialResolvedCampaignClaimV1,
} from '@/types/commercialQuote'

type AcquisitionRequest = Parameters<typeof commercialAcquisitionRequestSchema.parse>[0]

interface StoredCommercialAcquisitionContextRecordV1 extends CommercialAcquisitionContextRecordV1 {
  offerVersionId?: string | null
  offerSchemaVersion?: number | null
  reservedCatalogPublicationId?: string | null
  reservedCatalogSchemaVersion?: number | null
}

export interface CommercialAcquisitionContextRepository {
  create(record: CommercialAcquisitionContextRecordV1): Promise<void>
  findByTokenHash(tokenHash: string): Promise<StoredCommercialAcquisitionContextRecordV1 | null>
}

interface CommercialAcquisitionContextDependencies {
  repository: CommercialAcquisitionContextRepository
  resolveCampaignClaim: (claim: string, now: Date) => Promise<CommercialResolvedCampaignClaimV1 | null>
  randomToken?: () => string
  randomId?: () => string
  ttlMs?: number
}

function acquisitionError(code: string, message: string, statusCode = 422): AppError {
  return new AppError(message, statusCode, true, code)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function intrinsicDateTime(value: Date): number {
  try {
    return Date.prototype.getTime.call(value)
  } catch {
    return Number.NaN
  }
}

export const prismaCommercialAcquisitionContextRepository: CommercialAcquisitionContextRepository = {
  async create(record) {
    await prisma.commercialAcquisitionContext.create({
      data: {
        id: record.id,
        tokenHash: record.tokenHash,
        campaignVersionId: record.campaignVersionId,
        channel: record.channel,
        attribution: record.attribution as Prisma.InputJsonValue,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      },
    })
  },
  async findByTokenHash(tokenHash) {
    const record = await prisma.commercialAcquisitionContext.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        tokenHash: true,
        campaignVersionId: true,
        offerVersionId: true,
        offerSchemaVersion: true,
        reservedCatalogPublicationId: true,
        reservedCatalogSchemaVersion: true,
        channel: true,
        attribution: true,
        createdAt: true,
        expiresAt: true,
      },
    })
    if (!record) return null
    return {
      ...record,
      attribution: record.attribution as CommercialAcquisitionAttributionV1,
    }
  },
}

export function createCommercialAcquisitionContextService(dependencies: CommercialAcquisitionContextDependencies) {
  const randomToken = dependencies.randomToken ?? (() => randomBytes(32).toString('base64url'))
  const randomId = dependencies.randomId ?? randomUUID
  const ttlMs = dependencies.ttlMs ?? 7 * 24 * 60 * 60 * 1000

  async function resolveToken(token: string, now: Date): Promise<Omit<CommercialAcquisitionContextRecordV1, 'tokenHash'>> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw acquisitionError('COMMERCIAL_ACQUISITION_TOKEN_INVALID', 'El contexto de adquisición es inválido.')
    }
    const nowTime = intrinsicDateTime(now)
    if (!Number.isFinite(nowTime)) {
      throw acquisitionError('COMMERCIAL_ACQUISITION_TOKEN_INVALID', 'El contexto de adquisición es inválido.')
    }
    const record = await dependencies.repository.findByTokenHash(hashToken(token))
    if (!record) throw acquisitionError('COMMERCIAL_ACQUISITION_NOT_FOUND', 'El contexto de adquisición no existe.', 404)
    if (
      record.offerVersionId != null ||
      record.offerSchemaVersion != null ||
      record.reservedCatalogPublicationId != null ||
      record.reservedCatalogSchemaVersion != null
    ) {
      throw acquisitionError('COMMERCIAL_ACQUISITION_NOT_FOUND', 'El contexto de adquisición no existe.', 404)
    }
    if (intrinsicDateTime(record.expiresAt) <= nowTime) {
      throw acquisitionError('COMMERCIAL_ACQUISITION_EXPIRED', 'El contexto de adquisición venció.', 410)
    }
    return {
      id: record.id,
      campaignVersionId: record.campaignVersionId,
      channel: record.channel,
      attribution: record.attribution,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    }
  }

  return {
    async issue(input: AcquisitionRequest, now: Date): Promise<{ token: string; expiresAt: string }> {
      const parsed = commercialAcquisitionRequestSchema.safeParse(input)
      if (!parsed.success) {
        throw acquisitionError('COMMERCIAL_ACQUISITION_INVALID', 'El contexto de adquisición contiene campos inválidos.')
      }
      const token = randomToken()
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        throw acquisitionError('COMMERCIAL_ACQUISITION_ENTROPY_INVALID', 'No se pudo emitir un contexto de adquisición seguro.', 500)
      }

      const claim = 'campaignClaim' in parsed.data ? await dependencies.resolveCampaignClaim(parsed.data.campaignClaim, now) : null
      if ('campaignClaim' in parsed.data && !claim) {
        throw acquisitionError('COMMERCIAL_CAMPAIGN_NOT_ACTIVE', 'La campaña solicitada no existe o no está activa.')
      }

      const analytics = { ...parsed.data } as Record<string, unknown>
      delete analytics.campaignClaim
      delete analytics.channel
      const channel = claim?.channel ?? ('channel' in parsed.data ? parsed.data.channel : 'DIRECT')
      const attribution: CommercialAcquisitionAttributionV1 = {
        ...(claim ? { campaignCode: claim.campaignCode, sourceRef: claim.sourceRef } : {}),
        ...analytics,
      }
      const expiresAt = new Date(now.getTime() + ttlMs)
      await dependencies.repository.create({
        id: randomId(),
        tokenHash: hashToken(token),
        campaignVersionId: claim?.campaignVersionId ?? null,
        channel,
        attribution,
        createdAt: now,
        expiresAt,
      })
      return { token, expiresAt: expiresAt.toISOString() }
    },

    async resolve(token: string, now: Date): Promise<Omit<CommercialAcquisitionContextRecordV1, 'tokenHash'>> {
      return resolveToken(token, now)
    },

    async resolveForQuote(
      authorityContext: CommercialQuoteV2AuthorityContext,
      token: string,
      now: Date,
    ): Promise<Omit<CommercialAcquisitionContextRecordV1, 'tokenHash'>> {
      assertCommercialQuoteV2AuthorityContext(authorityContext)
      return resolveToken(token, now)
    },
  }
}

export const commercialAcquisitionContextService = createCommercialAcquisitionContextService({
  repository: prismaCommercialAcquisitionContextRepository,
  resolveCampaignClaim: (claim, now) => commercialCampaignClaimService.resolve(claim, now),
})
