import AppError from '@/errors/AppError'
import { emitCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Contract.service'
import type { CommercialQuoteEvaluationV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Engine.service'
import type {
  CommercialQuoteDerivedFromPreviewV3,
  CommercialQuoteSnapshotV3,
  CommercialQuoteSubjectV3,
  CommercialQuoteV3Authorities,
  EmittedCommercialQuoteV3,
} from '@/types/commercialQuoteV3'

export interface BuildCommercialQuoteV3Input {
  quoteId: string
  subject: CommercialQuoteSubjectV3
  acquisitionContextId: string | null
  derivedFromPreview: CommercialQuoteDerivedFromPreviewV3 | null
  quotedAt: Date
  expiresAt: Date
  evaluation: CommercialQuoteEvaluationV3
  authorities: CommercialQuoteV3Authorities
}

const COMMERCIAL_QUOTE_V3_WINDOW_MS = 15 * 60 * 1_000

function builderError(code: string): never {
  throw new AppError('No fue posible construir la cotización comercial.', 422, true, code)
}

function exactDateIso(value: Date, code: string): string {
  try {
    const timestamp = Date.prototype.getTime.call(value)
    if (!Number.isFinite(timestamp)) return builderError(code)
    return Date.prototype.toISOString.call(value)
  } catch {
    return builderError(code)
  }
}

/**
 * Seals a completed Quote v3 evaluation. Pricing and offer resolution intentionally
 * remain outside this function so persisted quotes cannot drift from the evaluation
 * that the caller accepted.
 */
export function buildCommercialQuoteV3(input: BuildCommercialQuoteV3Input): EmittedCommercialQuoteV3 {
  const quotedAt = exactDateIso(input.quotedAt, 'COMMERCIAL_QUOTE_V3_QUOTED_AT_INVALID')
  const expiresAt = exactDateIso(input.expiresAt, 'COMMERCIAL_QUOTE_V3_EXPIRES_AT_INVALID')
  if (Date.parse(expiresAt) - Date.parse(quotedAt) !== COMMERCIAL_QUOTE_V3_WINDOW_MS) {
    builderError('COMMERCIAL_QUOTE_V3_WINDOW_INVALID')
  }

  const snapshot: CommercialQuoteSnapshotV3 = {
    schemaVersion: 3,
    contractVersion: '3.0.0',
    quoteId: input.quoteId,
    subject: input.subject,
    acquisitionContextId: input.acquisitionContextId,
    derivedFromPreview: input.derivedFromPreview,
    catalogPublicationId: input.evaluation.catalogPublicationId,
    catalogChecksum: input.evaluation.catalogChecksum,
    offerVersionId: input.evaluation.offerVersionId,
    offerCode: input.evaluation.offerCode,
    offerChecksum: input.evaluation.offerChecksum,
    market: 'MX',
    currency: 'MXN',
    quotedAt,
    expiresAt,
    saasLines: input.evaluation.saasLines,
    hardwareLines: input.evaluation.hardwareLines,
    entitlementGrants: input.evaluation.entitlementGrants,
    resolution: input.evaluation.resolution,
    totals: input.evaluation.totals,
    renewal: input.evaluation.renewal,
  }

  return emitCommercialQuoteV3(snapshot, input.authorities)
}
