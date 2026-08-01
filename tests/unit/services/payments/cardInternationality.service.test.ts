import {
  CARD_INTERNATIONALITY_CLASSIFICATION_VERSION,
  classifyCardInternationality,
  extractBinFromMaskedPan,
} from '@/services/payments/cardInternationality.service'

describe('cardInternationality shadow classifier', () => {
  it('classifies Mexico from EMV 5F28 even when the product label could say INTERNAC', () => {
    const result = classifyCardInternationality({
      issuerCountryCode: '0484',
      issuerCountrySource: 'EMV_5F28',
      maskedPan: '415231******9979',
      legacyIsInternational: false,
    })

    expect(result).toMatchObject({
      status: 'DOMESTIC',
      source: 'EMV_5F28',
      issuerCountryCode: '484',
      reasonCode: 'COUNTRY_MEXICO',
      legacyComparison: 'MATCH',
      classificationVersion: CARD_INTERNATIONALITY_CLASSIFICATION_VERSION,
    })
  })

  it('classifies the Doña Simona BIN as domestic without trusting the legacy boolean', () => {
    const result = classifyCardInternationality({
      maskedPan: '477291******004F',
      legacyIsInternational: true,
    })

    expect(result).toMatchObject({
      status: 'DOMESTIC',
      source: 'BIN_REGISTRY',
      issuerCountryCode: '484',
      reasonCode: 'VERIFIED_BIN_MEXICO',
      legacyComparison: 'MISMATCH',
      registryMatched: true,
    })
  })

  it('classifies the physical USA test card as international from EMV 5F28', () => {
    const result = classifyCardInternationality({
      issuerCountryCode: '0840',
      issuerCountrySource: 'EMV_5F28',
      maskedPan: '403491******5159',
      legacyIsInternational: true,
    })

    expect(result).toMatchObject({
      status: 'INTERNATIONAL',
      source: 'EMV_5F28',
      issuerCountryCode: '840',
      reasonCode: 'COUNTRY_NON_MEXICO',
      legacyComparison: 'MATCH',
    })
  })

  it('accepts an explicit processor ISO alpha country', () => {
    const result = classifyCardInternationality({
      issuerCountryCode: 'US',
      issuerCountrySource: 'PROCESSOR',
      maskedPan: '403491******5159',
      legacyIsInternational: false,
    })

    expect(result).toMatchObject({
      status: 'INTERNATIONAL',
      source: 'PROCESSOR',
      issuerCountryCode: 'US',
      legacyComparison: 'MISMATCH',
    })
  })

  it('returns UNKNOWN when neither country nor a verified BIN is available', () => {
    const result = classifyCardInternationality({
      maskedPan: '499999******1234',
      legacyIsInternational: true,
    })

    expect(result).toMatchObject({
      status: 'UNKNOWN',
      source: 'LEGACY',
      issuerCountryCode: null,
      reasonCode: 'INSUFFICIENT_EVIDENCE',
      legacyComparison: 'INCONCLUSIVE',
      registryMatched: false,
    })
  })

  it('returns UNKNOWN on a country/BIN conflict instead of guessing', () => {
    const result = classifyCardInternationality({
      issuerCountryCode: '0840',
      issuerCountrySource: 'EMV_5F28',
      maskedPan: '477291******5280',
      legacyIsInternational: true,
    })

    expect(result).toMatchObject({
      status: 'UNKNOWN',
      source: 'CONFLICT',
      issuerCountryCode: null,
      reasonCode: 'COUNTRY_BIN_CONFLICT',
      legacyComparison: 'INCONCLUSIVE',
      registryMatched: true,
    })
  })

  it('does not treat malformed or incomplete country evidence as international', () => {
    const result = classifyCardInternationality({
      issuerCountryCode: 'DEFAULT',
      issuerCountrySource: 'PROCESSOR',
      maskedPan: '499999******1234',
      legacyIsInternational: false,
    })

    expect(result).toMatchObject({
      status: 'UNKNOWN',
      source: 'LEGACY',
      reasonCode: 'INVALID_COUNTRY_EVIDENCE',
    })
  })

  it('marks evidence-free records as NONE when no legacy value exists', () => {
    const result = classifyCardInternationality({ maskedPan: null })

    expect(result).toMatchObject({
      status: 'UNKNOWN',
      source: 'NONE',
      reasonCode: 'INSUFFICIENT_EVIDENCE',
      legacyComparison: 'NOT_AVAILABLE',
    })
  })

  it('extracts only the leading BIN/IIN from masked PAN variants', () => {
    expect(extractBinFromMaskedPan('477291******004F')).toBe('477291')
    expect(extractBinFromMaskedPan('4152-31**-****-9979')).toBe('415231')
    expect(extractBinFromMaskedPan('****5280')).toBeNull()
  })
})
