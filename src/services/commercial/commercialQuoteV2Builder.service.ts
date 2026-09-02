import type {
  CampaignV2Result,
  CatalogV2Result,
  QuoteV2Result,
  VerifiedStoredCommercialCampaignV2,
  VerifiedStoredCommercialCatalogV2,
} from './commercialArtifactCodecRegistry.service'
import { emitCommercialArtifactV2 } from './commercialArtifactCodecRegistry.service'
import type { CommercialQuoteEvaluationV2 } from './commercialQuoteEngineV2.service'
import type { CommercialQuoteDerivedFromPreviewV2, CommercialQuoteSnapshotV2, CommercialQuoteSubjectV2 } from '@/types/commercialV2'
import AppError from '@/errors/AppError'

export interface CommercialQuoteBuildInputV2 {
  quoteId: string
  subject: CommercialQuoteSubjectV2
  acquisitionContextId: string | null
  derivedFromPreview: CommercialQuoteDerivedFromPreviewV2 | null
  quotedAt: Date
  expiresAt: Date
  evaluation: CommercialQuoteEvaluationV2
  authorities: {
    catalog: CatalogV2Result | VerifiedStoredCommercialCatalogV2
    campaign: CampaignV2Result | VerifiedStoredCommercialCampaignV2 | null
  }
}

export function buildCommercialQuoteV2(input: CommercialQuoteBuildInputV2): QuoteV2Result {
  let quotedAt: number
  let expiresAt: number
  try {
    quotedAt = Date.prototype.getTime.call(input.quotedAt)
    expiresAt = Date.prototype.getTime.call(input.expiresAt)
  } catch {
    quotedAt = Number.NaN
    expiresAt = Number.NaN
  }
  if (!Number.isFinite(quotedAt) || !Number.isFinite(expiresAt) || expiresAt <= quotedAt) {
    throw new AppError('La vigencia de la cotización es inválida.', 422, true, 'COMMERCIAL_QUOTE_INVALID_WINDOW')
  }
  const domainValue: CommercialQuoteSnapshotV2 = {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    quoteId: input.quoteId,
    subject: input.subject,
    acquisitionContextId: input.acquisitionContextId,
    derivedFromPreview: input.derivedFromPreview,
    catalogPublicationId: input.evaluation.catalogPublicationId,
    campaignVersionId: input.evaluation.campaignVersionId,
    campaignCode: input.evaluation.campaignCode,
    market: 'MX',
    currency: 'MXN',
    quotedAt: Date.prototype.toISOString.call(input.quotedAt),
    expiresAt: Date.prototype.toISOString.call(input.expiresAt),
    lines: input.evaluation.lines,
    entitlementGrants: input.evaluation.entitlementGrants,
    totals: input.evaluation.totals,
    renewal: input.evaluation.renewal,
  }
  return emitCommercialArtifactV2({ kind: 'QUOTE', schemaVersion: 2, domainValue, authorities: input.authorities })
}
