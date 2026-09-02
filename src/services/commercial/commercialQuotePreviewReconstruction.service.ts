import { timingSafeEqual } from 'node:crypto'
import AppError from '@/errors/AppError'
import type { CommercialAcquisitionContextRecordV1 } from '@/types/commercialQuote'
import type { CommercialQuotePreviewTokenPayloadV2 } from './commercialQuotePreviewToken.service'
import { assertCommercialQuoteV2AuthorityContext, type CommercialQuoteV2AuthorityContext } from './commercialQuoteV2Authority.service'
import {
  assertVerifiedStoredCommercialCampaignV2,
  type QuoteV2Result,
  type VerifiedStoredCommercialCampaignV2,
} from './commercialArtifactCodecRegistry.service'
import { fingerprintCommercialSelectionV2 } from './commercialFingerprintV2.service'
import { evaluateCommercialQuoteV2, type CommercialQuoteSelectionV2 } from './commercialQuoteEngineV2.service'
import { buildCommercialQuoteV2 } from './commercialQuoteV2Builder.service'

const PREVIEW_TTL_MS = 15 * 60 * 1000
const SHA256_HEX = /^[0-9a-f]{64}$/

type SafeAcquisitionContext = Omit<CommercialAcquisitionContextRecordV1, 'tokenHash'>

export interface CommercialQuotePreviewReconstructionInputV2 {
  authorityContext: CommercialQuoteV2AuthorityContext
  acquisition: SafeAcquisitionContext
  campaign: VerifiedStoredCommercialCampaignV2 | null
  lines: readonly CommercialQuoteSelectionV2[]
  previewQuoteId: string
  issuedAt: Date
  expiresAt: Date
  expected?: CommercialQuotePreviewTokenPayloadV2
}

export interface CommercialQuotePreviewReconstructionResultV2 {
  quote: QuoteV2Result
  selectionFingerprint: string
}

function superseded(): never {
  throw new AppError('La vista previa ya no coincide con las autoridades comerciales vigentes.', 409, true, 'COMMERCIAL_PREVIEW_SUPERSEDED')
}

function intrinsicTime(value: Date): number {
  try {
    return Date.prototype.getTime.call(value)
  } catch {
    return Number.NaN
  }
}

function intrinsicIso(value: Date): string {
  try {
    return Date.prototype.toISOString.call(value)
  } catch {
    return superseded()
  }
}

function sameHash(left: string, right: string): boolean {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function assertCampaignLineage(
  acquisition: SafeAcquisitionContext,
  campaign: VerifiedStoredCommercialCampaignV2 | null,
  issuedAtTime: number,
): void {
  const campaignVersionId = campaign?.snapshot.campaignVersionId ?? null
  if (acquisition.campaignVersionId !== campaignVersionId) return superseded()
  if (!campaign) return
  assertVerifiedStoredCommercialCampaignV2(campaign)
  const startsAt = Date.parse(campaign.snapshot.startsAt)
  const endsAt = Date.parse(campaign.snapshot.endsAt)
  if (campaign.snapshot.status !== 'ACTIVE' || issuedAtTime < startsAt || issuedAtTime >= endsAt) return superseded()
}

function assertExpectedAuthority(
  expected: CommercialQuotePreviewTokenPayloadV2,
  input: CommercialQuotePreviewReconstructionInputV2,
  selectionFingerprint: string,
  issuedAtIso: string,
  expiresAtIso: string,
): void {
  const campaignVersionId = input.campaign?.snapshot.campaignVersionId ?? null
  if (
    expected.version !== 2 ||
    expected.previewQuoteId !== input.previewQuoteId ||
    expected.acquisitionContextId !== input.acquisition.id ||
    expected.publicationId !== input.authorityContext.catalog.snapshot.publicationId ||
    expected.campaignVersionId !== campaignVersionId ||
    expected.issuedAt !== issuedAtIso ||
    expected.expiresAt !== expiresAtIso ||
    !sameHash(expected.selectionFingerprint, selectionFingerprint)
  ) {
    return superseded()
  }
}

export function reconstructCommercialQuotePreviewV2(
  input: CommercialQuotePreviewReconstructionInputV2,
): CommercialQuotePreviewReconstructionResultV2 {
  assertCommercialQuoteV2AuthorityContext(input.authorityContext)
  const issuedAtTime = intrinsicTime(input.issuedAt)
  const expiresAtTime = intrinsicTime(input.expiresAt)
  if (
    !Number.isFinite(issuedAtTime) ||
    !Number.isFinite(expiresAtTime) ||
    expiresAtTime - issuedAtTime !== PREVIEW_TTL_MS ||
    typeof input.previewQuoteId !== 'string' ||
    input.previewQuoteId.length < 1 ||
    input.previewQuoteId.length > 128
  ) {
    return superseded()
  }

  assertCampaignLineage(input.acquisition, input.campaign, issuedAtTime)
  const issuedAtIso = intrinsicIso(input.issuedAt)
  const expiresAtIso = intrinsicIso(input.expiresAt)
  const selectionFingerprint = fingerprintCommercialSelectionV2({ lines: input.lines })
  if (input.expected) {
    assertExpectedAuthority(input.expected, input, selectionFingerprint, issuedAtIso, expiresAtIso)
  }

  const evaluation = evaluateCommercialQuoteV2({
    catalog: input.authorityContext.catalog.snapshot,
    campaign: input.campaign?.snapshot ?? null,
    lines: input.lines,
    now: input.issuedAt,
  })
  const quote = buildCommercialQuoteV2({
    quoteId: input.previewQuoteId,
    subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: input.acquisition.id },
    acquisitionContextId: input.acquisition.id,
    derivedFromPreview: null,
    quotedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    evaluation,
    authorities: { catalog: input.authorityContext.catalog, campaign: input.campaign },
  })
  if (input.expected && !sameHash(input.expected.previewChecksum, quote.checksum)) return superseded()
  return Object.freeze({ quote, selectionFingerprint })
}
