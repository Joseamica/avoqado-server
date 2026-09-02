import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { CommercialArtifactCodecError, decodeAndVerifyStoredCommercialCatalog } from './commercialArtifactCodecRegistry.service'
import { decodeVerifiedCommercialCampaignAuthority } from './commercialCampaignAuthority.service'
import { catalogDecodeInput } from './commercialCatalogFallbackBoundary.service'
import { CommercialCatalogFallbackError } from './commercialCatalogFallback.service'
import {
  CommercialCatalogAuthorityError,
  verifyCommercialCatalogActivationChain,
  type CommercialCatalogAuthorityPointer,
} from './commercialCatalogAuthority.service'
import type {
  CommercialCampaignDecodeInput,
  CommercialCatalogActivationOutboxRecord,
  CommercialCatalogPersistedRow,
} from '@/types/commercialCodec'
import {
  assertNoProhibitedCommercialOfferV3Q3BReferences,
  countAllowedCommercialOfferV3Q3AReferences,
  countAllowedCommercialOfferV3Q3BReferences,
  countProhibitedCommercialOfferV3Q3AReferences,
  countProhibitedCommercialOfferV3Q3BReferences,
  type CommercialOfferV3AllowedQ3AReferences,
  type CommercialOfferV3AllowedQ3BReferences,
  type CommercialOfferV3ProhibitedQ3BReferences,
  type CommercialOfferV3ProhibitedReferences,
} from './offers/commercialOfferReleasePreflight.service'

interface CommercialReleasePreflightCampaignRow {
  id: string
  campaignCode: string
  sourceRevision: number
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

interface CommercialReleasePreflightClaimRow {
  id: string
  campaignVersionId: string
  campaignVersion: CommercialReleasePreflightCampaignRow
}

export interface CommercialReleasePreflightTransaction {
  getProductionPointer(): Promise<CommercialCatalogAuthorityPointer | null>
  getActivationEvents(): Promise<readonly CommercialCatalogActivationOutboxRecord[]>
  countPreviewCatalogPointers(): Promise<number>
  getActiveCampaignV1Versions(): Promise<readonly CommercialReleasePreflightCampaignRow[]>
  getNonexpiredCampaignV1Claims(now: Date): Promise<readonly CommercialReleasePreflightClaimRow[]>
  countPublishedV3Versions(): Promise<number>
  countAllowedOfferV3Q3AReferences(): Promise<CommercialOfferV3AllowedQ3AReferences>
  countProhibitedOfferV3Q3AReferences(): Promise<CommercialOfferV3ProhibitedReferences>
  countAllowedOfferV3Q3BReferences(): Promise<CommercialOfferV3AllowedQ3BReferences>
  countProhibitedOfferV3Q3BReferences(): Promise<CommercialOfferV3ProhibitedQ3BReferences>
}

export interface CommercialReleasePreflightDependencies {
  runInRepeatableRead<T>(operation: (tx: CommercialReleasePreflightTransaction) => Promise<T>): Promise<T>
  now(): Date
}

export type CommercialReleasePreflightFailureReason =
  | 'PRODUCTION_CATALOG_NOT_ACTIVE'
  | 'PREVIEW_CATALOG_POINTER_PRESENT'
  | 'CATALOG_HISTORY_AUTHORITY_INVALID'
  | 'CAMPAIGN_V1_AUTHORITY_INVALID'

export class CommercialReleasePreflightError extends Error {
  readonly code = 'COMMERCIAL_RELEASE_PREFLIGHT_FAILED'

  constructor(public readonly reason: CommercialReleasePreflightFailureReason) {
    super('La verificación comercial previa al release no pasó.')
    this.name = 'CommercialReleasePreflightError'
  }
}

function isCommercialReleasePreflightAuthorityError(error: unknown): boolean {
  return (
    error instanceof CommercialArtifactCodecError ||
    error instanceof CommercialCatalogAuthorityError ||
    error instanceof CommercialCatalogFallbackError ||
    error instanceof CommercialReleasePreflightError
  )
}

function campaignDecodeInput(row: CommercialReleasePreflightCampaignRow): CommercialCampaignDecodeInput {
  return {
    kind: 'CAMPAIGN',
    rowSchemaVersion: row.schemaVersion,
    snapshot: row.snapshot,
    checksum: row.checksum,
    rowContext: {
      kind: 'CAMPAIGN',
      id: row.id,
      campaignCode: row.campaignCode,
      sourceRevision: row.sourceRevision,
      schemaVersion: row.schemaVersion,
      publishedAt: row.publishedAt,
    },
  }
}

function verifyCampaignV1(row: CommercialReleasePreflightCampaignRow): void {
  const authority = decodeVerifiedCommercialCampaignAuthority(campaignDecodeInput(row))
  if (authority.schemaVersion !== 1 || authority.campaignVersionId !== row.id || authority.campaignCode !== row.campaignCode) {
    throw new CommercialReleasePreflightError('CAMPAIGN_V1_AUTHORITY_INVALID')
  }
}

export const prismaCommercialReleasePreflightDependencies: CommercialReleasePreflightDependencies = {
  now: () => new Date(),
  runInRepeatableRead: operation =>
    prisma.$transaction(
      async tx =>
        operation({
          getProductionPointer: () =>
            tx.commercialPublicationActivation.findUnique({
              where: { environment: 'PRODUCTION' },
              include: { publication: true },
            }) as Promise<CommercialCatalogAuthorityPointer | null>,
          getActivationEvents: () =>
            tx.commercialPublicationOutbox.findMany({
              where: { eventType: { in: ['PUBLICATION_ACTIVATED', 'PUBLICATION_ROLLED_BACK'] } },
              include: { publication: true, previousPublication: true },
            }) as Promise<CommercialCatalogActivationOutboxRecord[]>,
          countPreviewCatalogPointers: () => tx.commercialPublicationActivation.count({ where: { environment: 'PREVIEW' } }),
          getActiveCampaignV1Versions: async () => {
            const activations = await tx.commercialCampaignActivation.findMany({
              where: { environment: 'PRODUCTION', campaignVersion: { schemaVersion: 1 } },
              include: { campaignVersion: true },
            })
            return activations.map(activation => activation.campaignVersion)
          },
          getNonexpiredCampaignV1Claims: async operationNow => {
            const rows = await tx.commercialCampaignClaim.findMany({
              where: { expiresAt: { gt: operationNow }, campaignVersion: { schemaVersion: 1 } },
              select: { id: true, campaignVersionId: true, campaignVersion: true },
            })
            return rows.map(row => {
              if (row.campaignVersionId === null || row.campaignVersion === null) {
                throw new CommercialReleasePreflightError('CAMPAIGN_V1_AUTHORITY_INVALID')
              }
              return {
                id: row.id,
                campaignVersionId: row.campaignVersionId,
                campaignVersion: row.campaignVersion,
              }
            })
          },
          countPublishedV3Versions: () => tx.commercialCampaignVersion.count({ where: { schemaVersion: 3 } }),
          countAllowedOfferV3Q3AReferences: () => countAllowedCommercialOfferV3Q3AReferences(tx),
          countProhibitedOfferV3Q3AReferences: () => countProhibitedCommercialOfferV3Q3AReferences(tx),
          countAllowedOfferV3Q3BReferences: () => countAllowedCommercialOfferV3Q3BReferences(tx),
          countProhibitedOfferV3Q3BReferences: () => countProhibitedCommercialOfferV3Q3BReferences(tx),
        }),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 30_000,
      },
    ),
}

export function createCommercialReleasePreflightService(
  dependencies: CommercialReleasePreflightDependencies = prismaCommercialReleasePreflightDependencies,
) {
  return {
    async run() {
      return dependencies.runInRepeatableRead(async tx => {
        const checkedAt = dependencies.now()
        if ((await tx.countPreviewCatalogPointers()) !== 0) {
          throw new CommercialReleasePreflightError('PREVIEW_CATALOG_POINTER_PRESENT')
        }

        const pointer = await tx.getProductionPointer()
        if (!pointer) throw new CommercialReleasePreflightError('PRODUCTION_CATALOG_NOT_ACTIVE')

        let chainPublications: readonly CommercialCatalogPersistedRow[]
        try {
          const activationEvents = await tx.getActivationEvents()
          chainPublications = verifyCommercialCatalogActivationChain({ pointer, activationEvents }).publications
          for (const publication of chainPublications) {
            if (publication.schemaVersion === 1) {
              const decoded = decodeAndVerifyStoredCommercialCatalog(catalogDecodeInput(publication))
              if (decoded.schemaVersion !== 1) {
                throw new CommercialReleasePreflightError('CATALOG_HISTORY_AUTHORITY_INVALID')
              }
            }
          }
        } catch (error) {
          if (!isCommercialReleasePreflightAuthorityError(error)) throw error
          throw new CommercialReleasePreflightError('CATALOG_HISTORY_AUTHORITY_INVALID')
        }

        const activeCampaigns = await tx.getActiveCampaignV1Versions()
        const claims = await tx.getNonexpiredCampaignV1Claims(checkedAt)
        const claimedVersions = new Map<string, CommercialReleasePreflightCampaignRow>()
        try {
          for (const campaign of activeCampaigns) verifyCampaignV1(campaign)
          for (const claim of claims) {
            if (claim.campaignVersionId !== claim.campaignVersion.id) {
              throw new CommercialReleasePreflightError('CAMPAIGN_V1_AUTHORITY_INVALID')
            }
            claimedVersions.set(claim.campaignVersion.id, claim.campaignVersion)
          }
          for (const campaign of claimedVersions.values()) verifyCampaignV1(campaign)
        } catch (error) {
          if (!isCommercialReleasePreflightAuthorityError(error)) throw error
          throw new CommercialReleasePreflightError('CAMPAIGN_V1_AUTHORITY_INVALID')
        }

        const [
          publishedOfferV3Versions,
          allowedOfferV3Q3AReferences,
          prohibitedOfferV3Q3AReferences,
          allowedOfferV3Q3BReferences,
          prohibitedOfferV3Q3BReferences,
        ] = await Promise.all([
          tx.countPublishedV3Versions(),
          tx.countAllowedOfferV3Q3AReferences(),
          tx.countProhibitedOfferV3Q3AReferences(),
          tx.countAllowedOfferV3Q3BReferences(),
          tx.countProhibitedOfferV3Q3BReferences(),
        ])
        const allowedQ3AReferences = Object.freeze({ ...allowedOfferV3Q3AReferences })
        const prohibitedQ3AReferences = Object.freeze({ ...prohibitedOfferV3Q3AReferences })
        const allowedQ3BReferences = Object.freeze({ ...allowedOfferV3Q3BReferences })
        const prohibitedQ3BReferences = assertNoProhibitedCommercialOfferV3Q3BReferences(prohibitedOfferV3Q3BReferences)

        return Object.freeze({
          status: 'PASS' as const,
          catalog: Object.freeze({
            pointerRevision: pointer.revision,
            chainPublications: chainPublications.length,
            historicalV1Verified: chainPublications.filter(publication => publication.schemaVersion === 1).length,
          }),
          campaigns: Object.freeze({
            activeV1VersionsVerified: activeCampaigns.length,
            claimedV1VersionsVerified: claimedVersions.size,
            nonexpiredV1Claims: claims.length,
          }),
          offerV3: Object.freeze({
            publishedVersions: publishedOfferV3Versions,
            q3a: Object.freeze({ allowed: allowedQ3AReferences, prohibited: prohibitedQ3AReferences }),
            q3b: Object.freeze({ allowed: allowedQ3BReferences, prohibited: prohibitedQ3BReferences }),
          }),
          previewCatalogPointers: 0 as const,
          checkedAt: checkedAt.toISOString(),
        })
      })
    },
  }
}

export const commercialReleasePreflightService = createCommercialReleasePreflightService()
