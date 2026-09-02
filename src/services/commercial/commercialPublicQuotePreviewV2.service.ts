import { randomUUID } from 'node:crypto'
import { env } from '@/config/env'
import type { CommercialQuotePreviewSecretsInput } from '@/config/commercialQuotePreviewSecrets'
import AppError from '@/errors/AppError'
import { commercialPublicQuotePreviewRequestV2Schema } from '@/schemas/commercialQuoteV2.schema'
import type { CommercialAcquisitionContextRecordV1 } from '@/types/commercialQuote'
import type { CommercialQuoteSnapshotV2 } from '@/types/commercialV2'
import { commercialAcquisitionContextService } from './commercialAcquisitionContext.service'
import { commercialCampaignQuoteAuthorityLoader } from './commercialCampaignClaim.service'
import {
  COMMERCIAL_QUOTE_PREVIEW_TTL_MS,
  issueCommercialQuotePreviewTokenV2,
  type CommercialQuotePreviewTokenPayloadV2,
} from './commercialQuotePreviewToken.service'
import { withVerifiedActiveCatalogV2, type CommercialQuoteV2AuthorityContext } from './commercialQuoteV2Authority.service'
import {
  reconstructCommercialQuotePreviewV2,
  type CommercialQuotePreviewReconstructionInputV2,
  type CommercialQuotePreviewReconstructionResultV2,
} from './commercialQuotePreviewReconstruction.service'
import type { VerifiedStoredCommercialCampaignV2 } from './commercialArtifactCodecRegistry.service'

type SafeAcquisitionContext = Omit<CommercialAcquisitionContextRecordV1, 'tokenHash'>

export interface CommercialPublicQuotePreviewV2Dependencies {
  withVerifiedActiveCatalogV2<T>(operation: (context: CommercialQuoteV2AuthorityContext) => Promise<T> | T): Promise<T>
  resolveAcquisitionForQuote(context: CommercialQuoteV2AuthorityContext, token: string, now: Date): Promise<SafeAcquisitionContext>
  loadCampaignForQuote(
    context: CommercialQuoteV2AuthorityContext,
    campaignVersionId: string,
    issuedAt: Date,
  ): Promise<VerifiedStoredCommercialCampaignV2>
  reconstruct(input: CommercialQuotePreviewReconstructionInputV2): CommercialQuotePreviewReconstructionResultV2
  issuePreviewToken(payload: CommercialQuotePreviewTokenPayloadV2, secrets: CommercialQuotePreviewSecretsInput): string
  now(): Date
  randomId(): string
  recordEngineFailure(event: CommercialQuotePreviewV2EngineFailureEvent): void
  secrets: CommercialQuotePreviewSecretsInput
}

export interface CommercialQuotePreviewV2EngineFailureEvent {
  eventName: 'COMMERCIAL_QUOTE_PREVIEW_V2_ENGINE_FAILED'
  code: 'COMMERCIAL_QUOTE_PREVIEW_V2_ENGINE_FAILED'
  correlationId: string
}

export interface CommercialPublicQuotePreviewV2Result {
  quote: CommercialQuoteSnapshotV2
  previewToken: string
}

function publicPreviewError(code: string, message: string, statusCode = 422): AppError {
  return new AppError(message, statusCode, true, code)
}

function intrinsicTime(value: Date): number {
  try {
    return Date.prototype.getTime.call(value)
  } catch {
    return Number.NaN
  }
}

export const prismaCommercialPublicQuotePreviewV2Dependencies: CommercialPublicQuotePreviewV2Dependencies = {
  withVerifiedActiveCatalogV2,
  resolveAcquisitionForQuote: (context, token, now) => commercialAcquisitionContextService.resolveForQuote(context, token, now),
  loadCampaignForQuote: (context, campaignVersionId, issuedAt) =>
    commercialCampaignQuoteAuthorityLoader.load(context, campaignVersionId, issuedAt),
  reconstruct: reconstructCommercialQuotePreviewV2,
  issuePreviewToken: issueCommercialQuotePreviewTokenV2,
  now: () => new Date(),
  randomId: () => randomUUID(),
  recordEngineFailure: () => undefined,
  secrets: {
    quotePreviewSigningSecret: env.COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET,
    publicationPreviewSigningSecret: env.COMMERCIAL_PREVIEW_SIGNING_SECRET,
  },
}

export function createCommercialPublicQuotePreviewV2Service(
  dependencies: CommercialPublicQuotePreviewV2Dependencies = prismaCommercialPublicQuotePreviewV2Dependencies,
) {
  return {
    async preview(input: unknown, correlationId = 'commercial-correlation-unavailable'): Promise<CommercialPublicQuotePreviewV2Result> {
      return dependencies.withVerifiedActiveCatalogV2(async authorityContext => {
        const parsed = commercialPublicQuotePreviewRequestV2Schema.safeParse(input)
        if (!parsed.success) {
          if (parsed.error.issues.some(issue => issue.path[0] === 'acquisitionToken')) {
            throw publicPreviewError(
              'COMMERCIAL_ACQUISITION_REQUIRED',
              'La cotización pública requiere un contexto de adquisición vigente.',
            )
          }
          throw publicPreviewError('COMMERCIAL_QUOTE_REQUEST_INVALID', 'La solicitud de cotización contiene campos inválidos.')
        }

        const issuedAt = dependencies.now()
        const issuedAtTime = intrinsicTime(issuedAt)
        if (!Number.isFinite(issuedAtTime)) {
          throw publicPreviewError('COMMERCIAL_PREVIEW_CLOCK_INVALID', 'No fue posible fijar la vigencia de la cotización.', 500)
        }
        const expiresAt = new Date(issuedAtTime + COMMERCIAL_QUOTE_PREVIEW_TTL_MS)
        const acquisition = await dependencies.resolveAcquisitionForQuote(authorityContext, parsed.data.acquisitionToken, issuedAt)
        const campaign = acquisition.campaignVersionId
          ? await dependencies.loadCampaignForQuote(authorityContext, acquisition.campaignVersionId, issuedAt)
          : null
        let reconstructed: CommercialQuotePreviewReconstructionResultV2
        try {
          reconstructed = dependencies.reconstruct({
            authorityContext,
            acquisition,
            campaign,
            lines: parsed.data.lines,
            previewQuoteId: dependencies.randomId(),
            issuedAt,
            expiresAt,
          })
        } catch (error) {
          try {
            dependencies.recordEngineFailure({
              eventName: 'COMMERCIAL_QUOTE_PREVIEW_V2_ENGINE_FAILED',
              code: 'COMMERCIAL_QUOTE_PREVIEW_V2_ENGINE_FAILED',
              correlationId,
            })
          } catch {
            // Telemetry is best-effort and must never change commercial authority behavior.
          }
          throw error
        }
        const quote = reconstructed.quote
        const payload: CommercialQuotePreviewTokenPayloadV2 = {
          version: 2,
          previewQuoteId: quote.snapshot.quoteId,
          previewChecksum: quote.checksum,
          acquisitionContextId: acquisition.id,
          publicationId: authorityContext.catalog.snapshot.publicationId,
          campaignVersionId: quote.snapshot.campaignVersionId,
          selectionFingerprint: reconstructed.selectionFingerprint,
          issuedAt: quote.snapshot.quotedAt,
          expiresAt: quote.snapshot.expiresAt,
        }
        return Object.freeze({
          quote: quote.snapshot,
          previewToken: dependencies.issuePreviewToken(payload, dependencies.secrets),
        })
      })
    },
  }
}

export const commercialPublicQuotePreviewV2Service = createCommercialPublicQuotePreviewV2Service()
