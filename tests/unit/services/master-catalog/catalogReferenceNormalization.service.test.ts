import { normalizeCatalogReferenceNameV1 } from '@/services/master-catalog/catalogReference.service'

describe('catalog reference normalization v1 shared seam', () => {
  it('preserves display text while freezing the exact NFKC comparison key used by imports and direct commands', () => {
    // WHY: Task 7 must resolve workbook references with the same pure contract
    // as Task 5 writes; a second normalizer could preview one row and confirm another.
    expect(normalizeCatalogReferenceNameV1('  Cafe\u0301   del   Sur  ')).toEqual({
      name: '  Cafe\u0301   del   Sur  ',
      normalizedName: 'CAFÉ DEL SUR',
    })
  })

  it.each([null, 7, '', '   '])('rejects the same invalid runtime value %p before lookup', value => {
    // WHY: Keeping rejection at the shared boundary prevents malformed XLSX
    // cells from reaching Prisma under a different failure contract.
    expect(() => normalizeCatalogReferenceNameV1(value)).toThrow()
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
    ['lone surrogate key', 'Brand-\ud800', false],
    ['PostgreSQL NUL key', 'Brand-\u0000', false],
    ['oversized display that collapses short', `${' '.repeat(256)}A`, true],
    ['workbook raw scalar boundary', `${' '.repeat(3_840)}${'😀'.repeat(256)}`, true],
    ['workbook raw scalar overflow', `${' '.repeat(3_841)}${'😀'.repeat(256)}`, false],
  ])('%s is classified before any reference lookup/write', (_case, name, accepted) => {
    const action = () => normalizeCatalogReferenceNameV1(name)
    if (accepted) expect(action).not.toThrow()
    else expect(action).toThrow(expect.objectContaining({ statusCode: 422, code: 'CATALOG_REFERENCE_NAME_INVALID' }))
  })
})
