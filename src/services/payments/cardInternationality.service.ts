import type { CardInternationalitySource, CardInternationalityStatus } from '@prisma/client'

export const CARD_INTERNATIONALITY_CLASSIFICATION_VERSION = 1

export type ClientCountryEvidenceSource = Extract<CardInternationalitySource, 'EMV_5F28' | 'PROCESSOR'>

export type InternationalityReasonCode =
  | 'COUNTRY_MEXICO'
  | 'COUNTRY_NON_MEXICO'
  | 'VERIFIED_BIN_MEXICO'
  | 'COUNTRY_BIN_CONFLICT'
  | 'INVALID_COUNTRY_EVIDENCE'
  | 'INSUFFICIENT_EVIDENCE'

export type LegacyComparison = 'MATCH' | 'MISMATCH' | 'INCONCLUSIVE' | 'NOT_AVAILABLE'

export interface CardInternationalityInput {
  /** Raw EMV 5F28 or explicit processor country. Never a product/bank label. */
  issuerCountryCode?: string | null
  issuerCountrySource?: ClientCountryEvidenceSource | null
  /** Masked PAN; only the leading 6-8 digit BIN/IIN is inspected. */
  maskedPan?: string | null
  /** Kept solely to compare shadow output against today's behavior. */
  legacyIsInternational?: boolean | null
}

export interface CardInternationalityDecision {
  status: CardInternationalityStatus
  source: CardInternationalitySource
  issuerCountryCode: string | null
  classificationVersion: number
  reasonCode: InternationalityReasonCode
  legacyComparison: LegacyComparison
  registryMatched: boolean
}

/**
 * Issuer-confirmed BINs only. Do not add entries from generic public BIN sites.
 *
 * BBVA source (retrieved 2026-07-29):
 * https://www.bbva.mx/content/dam/public-web/mexico/documents/tycs/TyC_Activaciones.pdf
 */
const VERIFIED_BIN_COUNTRIES = new Map<string, string>([
  ['415231', '484'], // BBVA debit
  ['455504', '484'], // BBVA Infinite
  ['477213', '484'], // BBVA Oro
  ['477214', '484'], // BBVA Platinum
  ['477291', '484'], // BBVA Azul (Doña Simona incident)
])

const INVALID_COUNTRY_TOKENS = new Set(['', '0', '000', '999', 'UNKNOWN', 'DEFAULT', 'N/A', 'NA', 'NULL'])

function normalizeCountryEvidence(raw: string | null | undefined, source: ClientCountryEvidenceSource | null | undefined): string | null {
  if (!raw || !source) return null

  const normalized = raw
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')

  if (INVALID_COUNTRY_TOKENS.has(normalized)) return null
  if (normalized === 'MEXICO' || normalized === 'MEX' || normalized === 'MX') return normalized === 'MX' ? 'MX' : 'MEX'

  // EMV 5F28 is ISO-3166 numeric encoded as n3 in two BCD bytes, hence values
  // observed as 0484 (Mexico) and 0840 (USA). Strip only that padding nibble.
  const numeric = /^0\d{3}$/.test(normalized) ? normalized.slice(1) : normalized
  if (/^\d{3}$/.test(numeric) && numeric !== '000' && numeric !== '999') return numeric

  // EMV must be numeric. A processor may instead provide ISO alpha-2/alpha-3.
  if (source === 'PROCESSOR' && /^[A-Z]{2,3}$/.test(normalized)) return normalized

  return null
}

function isMexicoCountry(code: string): boolean {
  return code === '484' || code === 'MX' || code === 'MEX'
}

export function extractBinFromMaskedPan(maskedPan: string | null | undefined): string | null {
  if (!maskedPan) return null
  const compact = maskedPan.replace(/[\s-]/g, '')
  const match = compact.match(/^(\d{6,8})/)
  return match?.[1] ?? null
}

function registryCountryForBin(bin: string | null): string | null {
  if (!bin) return null
  return VERIFIED_BIN_COUNTRIES.get(bin.slice(0, 8)) ?? VERIFIED_BIN_COUNTRIES.get(bin.slice(0, 6)) ?? null
}

function compareWithLegacy(status: CardInternationalityStatus, legacy: boolean | null | undefined): LegacyComparison {
  if (legacy === null || legacy === undefined) return 'NOT_AVAILABLE'
  if (status === 'UNKNOWN') return 'INCONCLUSIVE'
  const legacyStatus: CardInternationalityStatus = legacy ? 'INTERNATIONAL' : 'DOMESTIC'
  return status === legacyStatus ? 'MATCH' : 'MISMATCH'
}

/**
 * Pure shadow classifier. It never reads bank/product strings and never changes
 * authorization, Payment.status, TransactionCost, settlement dates, or balances.
 */
export function classifyCardInternationality(input: CardInternationalityInput): CardInternationalityDecision {
  const normalizedCountry = normalizeCountryEvidence(input.issuerCountryCode, input.issuerCountrySource)
  const bin = extractBinFromMaskedPan(input.maskedPan)
  const registryCountry = registryCountryForBin(bin)
  const registryMatched = registryCountry !== null

  if (normalizedCountry && registryCountry && isMexicoCountry(normalizedCountry) !== isMexicoCountry(registryCountry)) {
    const status: CardInternationalityStatus = 'UNKNOWN'
    return {
      status,
      source: 'CONFLICT',
      issuerCountryCode: null,
      classificationVersion: CARD_INTERNATIONALITY_CLASSIFICATION_VERSION,
      reasonCode: 'COUNTRY_BIN_CONFLICT',
      legacyComparison: compareWithLegacy(status, input.legacyIsInternational),
      registryMatched,
    }
  }

  if (normalizedCountry) {
    const status: CardInternationalityStatus = isMexicoCountry(normalizedCountry) ? 'DOMESTIC' : 'INTERNATIONAL'
    return {
      status,
      source: input.issuerCountrySource!,
      issuerCountryCode: normalizedCountry,
      classificationVersion: CARD_INTERNATIONALITY_CLASSIFICATION_VERSION,
      reasonCode: status === 'DOMESTIC' ? 'COUNTRY_MEXICO' : 'COUNTRY_NON_MEXICO',
      legacyComparison: compareWithLegacy(status, input.legacyIsInternational),
      registryMatched,
    }
  }

  if (registryCountry) {
    const status: CardInternationalityStatus = isMexicoCountry(registryCountry) ? 'DOMESTIC' : 'INTERNATIONAL'
    return {
      status,
      source: 'BIN_REGISTRY',
      issuerCountryCode: registryCountry,
      classificationVersion: CARD_INTERNATIONALITY_CLASSIFICATION_VERSION,
      reasonCode: 'VERIFIED_BIN_MEXICO',
      legacyComparison: compareWithLegacy(status, input.legacyIsInternational),
      registryMatched,
    }
  }

  const status: CardInternationalityStatus = 'UNKNOWN'
  const invalidCountryEvidence = Boolean(input.issuerCountryCode || input.issuerCountrySource)
  return {
    status,
    source: input.legacyIsInternational === null || input.legacyIsInternational === undefined ? 'NONE' : 'LEGACY',
    issuerCountryCode: null,
    classificationVersion: CARD_INTERNATIONALITY_CLASSIFICATION_VERSION,
    reasonCode: invalidCountryEvidence ? 'INVALID_COUNTRY_EVIDENCE' : 'INSUFFICIENT_EVIDENCE',
    legacyComparison: compareWithLegacy(status, input.legacyIsInternational),
    registryMatched,
  }
}
