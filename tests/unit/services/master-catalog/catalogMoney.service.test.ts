import { Prisma } from '@prisma/client'
import { canonicalCatalogDecimal, parseCatalogMoney } from '../../../../src/services/master-catalog/catalogMoney.service'

// These literals protect the catalog boundary from float coercion, permissive
// spreadsheet notation, and silent rounding before any database write exists.
describe('catalogMoney.service', () => {
  describe('parseCatalogMoney', () => {
    it.each([
      ['0', '0.00'],
      ['0.0', '0.00'],
      ['0.00', '0.00'],
      ['1', '1.00'],
      ['1.2', '1.20'],
      ['1.23', '1.23'],
      ['0001.20', '1.20'],
      ['99999999.99', '99999999.99'],
    ])('canonicalizes the accepted ordinary decimal string %s without a JavaScript number', (input, expected) => {
      expect(parseCatalogMoney(input)).toBe(expected)
    })

    it.each(['', '   ', ' 1.00 ', '.50', '1.', '1.234', '1e2', '1E2', '1,00', '-1', '+1', 'NaN', 'Infinity', '100000000', '99999999.991'])(
      'rejects the lossy or out-of-contract string %j',
      input => {
        expect(() => parseCatalogMoney(input)).toThrow('CATALOG_MONEY_INVALID')
      },
    )

    it.each([0, 1.23, null, undefined, {}, [], new Prisma.Decimal('1.23')])(
      'rejects non-string input before a caller can coerce it: %p',
      input => {
        expect(() => parseCatalogMoney(input)).toThrow('CATALOG_MONEY_INVALID')
      },
    )
  })

  describe('canonicalCatalogDecimal', () => {
    it('retains the requested scale for string and Decimal inputs', () => {
      expect(canonicalCatalogDecimal('1.2300', 4)).toBe('1.2300')
      expect(canonicalCatalogDecimal(new Prisma.Decimal('1.2'), 4)).toBe('1.2000')
      expect(canonicalCatalogDecimal('-0.5', 2)).toBe('-0.50')
    })

    it.each([
      ['1.234', 2],
      ['1e2', 2],
      ['NaN', 2],
      ['1.00', -1],
      ['1.00', 1.5],
    ] as const)('rejects %s at scale %s instead of rounding or reinterpreting it', (input, scale) => {
      expect(() => canonicalCatalogDecimal(input, scale)).toThrow('CATALOG_DECIMAL_INVALID')
    })
  })
})
