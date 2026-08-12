import vectors from '../../../contracts/master-catalog/identifier-normalization-v1.json'
import {
  CATALOG_INDEXED_TEXT_MAX_SCALARS_V1,
  CATALOG_INDEXED_TEXT_MAX_UTF8_BYTES_V1,
  CATALOG_WORKBOOK_TEXT_MAX_SCALARS_V1,
  CATALOG_WORKBOOK_TEXT_MAX_UTF8_BYTES_V1,
  isCatalogUnicodeScalarTextV1,
  isCatalogWorkbookTextV1,
  normalizeCatalogCorporateSkuV1,
  normalizeIdentifierV1,
} from '../../../../src/services/master-catalog/identifierNormalization.service'

// The frozen cross-client vectors prevent H1B from reinterpreting an H1A SKU
// after Android, iOS, TPV, and Desktop begin caching normalized identifiers.
describe('identifierNormalization.service', () => {
  it.each(vectors.vectors)('matches normalization-v1 for %j', vector => {
    expect(normalizeIdentifierV1({ code: vector.input, format: 'SKU' })).toEqual({
      code: vector.input,
      normalizedCode: vector.normalized,
      normalizationVersion: 1,
    })
  })

  it('preserves leading zeroes, internal spaces, hyphens, and the display code', () => {
    const input = '  000  ab-c  '

    expect(normalizeIdentifierV1({ code: input, format: 'SKU' })).toEqual({
      code: input,
      normalizedCode: '000  AB-C',
      normalizationVersion: 1,
    })
  })

  it.each(['', '   ', '\u00a0\t'])('rejects a code that becomes blank after peripheral trimming: %j', code => {
    expect(() => normalizeIdentifierV1({ code, format: 'SKU' })).toThrow('CATALOG_IDENTIFIER_INVALID')
  })

  it('rejects formats outside the H1A SKU subset instead of guessing H1B semantics', () => {
    expect(() => normalizeIdentifierV1({ code: '7501234567893', format: 'EAN13' as 'SKU' })).toThrow(
      'CATALOG_IDENTIFIER_FORMAT_UNSUPPORTED',
    )
  })

  it.each([
    ['ASCII scalar boundary', 'A'.repeat(256), true],
    ['ASCII scalar overflow', 'A'.repeat(257), false],
    ['UTF-8 byte boundary', '😀'.repeat(256), true],
    ['UTF-8 byte overflow', '😀'.repeat(257), false],
    ['NFKC expansion boundary', '\ufb03'.repeat(85), true],
    ['NFKC expansion overflow', '\ufb03'.repeat(86), false],
    ['uppercase expansion boundary', 'ß'.repeat(128), true],
    ['uppercase expansion overflow', 'ß'.repeat(129), false],
    ['lone surrogate key', 'SKU-\ud800', false],
    ['PostgreSQL NUL key', 'SKU-\u0000', false],
    ['oversized display that normalizes short', `${' '.repeat(256)}A`, true],
    ['workbook raw scalar boundary', `${' '.repeat(3_840)}${'😀'.repeat(256)}`, true],
    ['workbook raw scalar overflow', `${' '.repeat(3_841)}${'😀'.repeat(256)}`, false],
  ])('%s is classified against the final normalized indexed-key limits', (_case, code, accepted) => {
    const action = () => normalizeCatalogCorporateSkuV1({ code, format: 'SKU' })
    if (accepted) expect(action).not.toThrow()
    else expect(action).toThrow('CATALOG_IDENTIFIER_INVALID')
  })

  it('exports the frozen scalar and UTF-8 byte budgets used by every SKU boundary', () => {
    expect(CATALOG_INDEXED_TEXT_MAX_SCALARS_V1).toBe(256)
    expect(CATALOG_INDEXED_TEXT_MAX_UTF8_BYTES_V1).toBe(1_024)
    expect(CATALOG_WORKBOOK_TEXT_MAX_SCALARS_V1).toBe(4_096)
    expect(CATALOG_WORKBOOK_TEXT_MAX_UTF8_BYTES_V1).toBe(16_384)
  })

  it.each([
    ['maximum astral envelope', '😀'.repeat(4_096), true],
    ['scalar overflow', '😀'.repeat(4_097), false],
    ['lone surrogate', 'SKU-\ud800', false],
    ['PostgreSQL NUL', 'SKU-\u0000', false],
  ])('%s is classified with Unicode-scalar rather than UTF-16 length', (_case, value, accepted) => {
    expect(isCatalogWorkbookTextV1(value)).toBe(accepted)
  })

  it('bounds diagnostic excerpts without splitting astral scalars', () => {
    expect(isCatalogUnicodeScalarTextV1(`${'A'.repeat(127)}😀`, 128)).toBe(true)
    expect(isCatalogUnicodeScalarTextV1(`${'A'.repeat(128)}😀`, 128)).toBe(false)
  })

  it('does not change generic/local normalization for a long display that becomes a short key', () => {
    expect(normalizeIdentifierV1({ code: `${' '.repeat(256)}A`, format: 'SKU' }).normalizedCode).toBe('A')
  })
})
