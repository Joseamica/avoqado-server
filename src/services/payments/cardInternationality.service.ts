import type { CardInternationalitySource, CardInternationalityStatus } from '@prisma/client'
import { ISO_ALPHA2, ISO_ALPHA3_TO_ALPHA2, ISO_NUMERIC_TO_ALPHA2 } from './iso3166'

/**
 * v1 (ago-2026) = sólo observación («en sombra»). v2 (D3, 10-nov-2026) = la clasificación DECIDE el dato financiero
 * `processorData.isInternational` de los cobros nuevos (`resolveIsInternational`). La versión guardada en cada Payment dice
 * con cuál régimen se clasificó.
 */
export const CARD_INTERNATIONALITY_CLASSIFICATION_VERSION = 2

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

/**
 * D3 · Codex r1-2 / r2-1 / r2-3 / r3-1: desde que el país decide dinero, «tiene forma de código» no basta — `123`, `QQ`, los
 * códigos de prueba y macrorregiones que ICU nombra (`973` → XA, `967` → EU), los retirados (`280`, `810`, `AN`) y las
 * agrupaciones (`172` CEI, `830` Islas del Canal) no son un país emisor. La única verdad es ISO 3166-1 VIGENTE (`iso3166.ts`):
 * numérico del chip, y alfa-2 o alfa-3 del procesador. Lo que no está ahí no clasifica: decide la terminal, como antes de D3.
 */
function isRealCountry(code: string): boolean {
  return ISO_NUMERIC_TO_ALPHA2.has(code) || ISO_ALPHA2.has(code) || ISO_ALPHA3_TO_ALPHA2.has(code)
}

function normalizeCountryEvidence(raw: string | null | undefined, source: ClientCountryEvidenceSource | null | undefined): string | null {
  if (!raw || !source) return null

  const normalized = raw
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')

  if (INVALID_COUNTRY_TOKENS.has(normalized)) return null
  // Codex r4-2: las letras (incluido «MEXICO») sólo las puede traer el procesador. El chip (5F28) es SIEMPRE numérico: un texto
  // presentado como dato del chip es evidencia mal formada y no decide.
  if (source === 'PROCESSOR' && (normalized === 'MEXICO' || normalized === 'MEX' || normalized === 'MX')) {
    return normalized === 'MX' ? 'MX' : 'MEX'
  }

  // EMV 5F28 is ISO-3166 numeric encoded as n3 in two BCD bytes, hence values
  // observed as 0484 (Mexico) and 0840 (USA). Strip only that padding nibble.
  const numeric = /^0\d{3}$/.test(normalized) ? normalized.slice(1) : normalized
  if (/^\d{3}$/.test(numeric) && numeric !== '000' && numeric !== '999') return isRealCountry(numeric) ? numeric : null

  // EMV must be numeric. A processor may instead provide ISO alpha-2/alpha-3.
  if (source === 'PROCESSOR' && /^[A-Z]{2,3}$/.test(normalized)) return isRealCountry(normalized) ? normalized : null

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
 * Pure classifier. It never reads bank/product strings and never touches authorization or Payment.status. Since v2 its
 * result feeds `resolveIsInternational`, which is what the card-type rate, reports, refunds and settlement read.
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

  // Codex r4-1: orden de la evidencia = chip > BIN verificado > procesador. El BIN verificado es evidencia de la TARJETA y decide
  // dinero; el país que sólo reporta el procesador es observación y no lo desplaza cuando coinciden (si chocan ya salió arriba,
  // como CONFLICT).
  if (normalizedCountry && !(input.issuerCountrySource === 'PROCESSOR' && registryCountry)) {
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

/** Las fuentes que DECIDEN dinero: lo que dice la propia tarjeta (chip) o un BIN que el emisor confirmó. */
const MONEY_SOURCES: ReadonlySet<CardInternationalitySource> = new Set<CardInternationalitySource>(['EMV_5F28', 'BIN_REGISTRY'])

/** ¿Esta clasificación decidió el dato financiero del cobro? (lo usa también la respuesta del MCP). */
export function decidesMoney(decision: Pick<CardInternationalityDecision, 'status' | 'source'> | null | undefined): boolean {
  return !!decision && decision.status !== 'UNKNOWN' && MONEY_SOURCES.has(decision.source)
}

/**
 * D3 (10-nov-2026, founder: «Sí, por país»): el dato DEFINITIVO del que cuelgan costo, reportes, reembolsos y liquidación
 * (`processorData.isInternational`). Decide el país que dice la TARJETA (chip, `EMV_5F28`) o un BIN verificado; un país que
 * sólo reporta el procesador (`PROCESSOR`, que hoy ninguna app manda) queda como observación. Sin esa evidencia se conserva
 * EXACTAMENTE lo que dijo la terminal — incluido «nada» (`undefined`, el webhook de AngelPay): inventar un `false` taparía al
 * REST que lo acredita después.
 */
export function resolveIsInternational<T extends boolean | null | undefined>(
  decision: Pick<CardInternationalityDecision, 'status' | 'source'> | null | undefined,
  legacyIsInternational: T,
): boolean | T {
  if (!decidesMoney(decision)) return legacyIsInternational
  return decision!.status === 'INTERNATIONAL'
}
