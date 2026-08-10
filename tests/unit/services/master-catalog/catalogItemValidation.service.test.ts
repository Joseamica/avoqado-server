import { BusinessType, CatalogIepsMode, CatalogItemKind, CatalogItemPriceKind, ProductType, Unit } from '@prisma/client'
import {
  CATALOG_ORGANIZATION_VALUE_MAX_V1,
  validateCatalogCurrencyV1,
  validateCatalogIepsFieldsV1,
  validateCatalogItemInput,
  validateCatalogObjetoImpV1,
  validateCatalogSatProductKeyV1,
  validateCatalogSatUnitKeyV1,
} from '@/services/master-catalog/catalogItemValidation.service'
import type { CreateCatalogItemInput, UpdateCatalogItemInput } from '@/services/master-catalog/catalogItem.types'

const baseline: CreateCatalogItemInput = {
  sku: '  sku-001  ',
  kind: CatalogItemKind.RETAIL_PRODUCT,
  name: 'Café molido',
  description: 'Bolsa de café de origen',
  imageUrl: 'https://cdn.example.test/cafe.jpg',
  brandId: 'brand-1',
  manufacturerId: 'manufacturer-1',
  familyId: 'family-leaf-1',
  presentationLabel: 'Bolsa 1 kg',
  unit: Unit.BAG,
  taxRate: '0.1600',
  satProductKey: '50201706',
  satUnitKey: 'H87',
  objetoImp: '02',
  productType: ProductType.REGULAR,
  iepsMode: CatalogIepsMode.NONE,
  iepsRate: null,
  iepsQuota: null,
  iepsQuotaUnit: null,
  businessTypes: [BusinessType.RETAIL_STORE],
  organizationValues: [
    { kind: CatalogItemPriceKind.SALE_PRICE, amount: '120.00', currency: 'MXN' },
    { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '80.5', currency: 'MXN' },
  ],
}

// WHY: CatalogItem has no DRAFT state. This table pins every baseline rejection
// at the pure boundary before the transaction service can perform any write.
describe('validateCatalogItemInput complete baseline', () => {
  it('exports the pure field validators used by workbook diagnostics without changing Task 5 rules', () => {
    // WHY: Task 7 must accumulate field-specific findings while Task 5 stays
    // the single authority for currency, CFDI, and IEPS acceptance.
    expect(validateCatalogCurrencyV1('MXN')).toBe('MXN')
    expect(validateCatalogSatProductKeyV1('50161509')).toBe('50161509')
    expect(validateCatalogSatUnitKeyV1('H87')).toBe('H87')
    expect(validateCatalogObjetoImpV1('02')).toBe('02')
    expect(CATALOG_ORGANIZATION_VALUE_MAX_V1).toBeGreaterThan(300)
    expect(CATALOG_ORGANIZATION_VALUE_MAX_V1 % 2).toBe(0)
    expect(
      validateCatalogIepsFieldsV1({
        iepsMode: CatalogIepsMode.NONE,
        iepsRate: null,
        iepsQuota: null,
        iepsQuotaUnit: null,
      }),
    ).toEqual({ iepsRate: null, iepsQuota: null })
  })
  it.each([
    ['blank SKU', { sku: ' ' }],
    ['over-index-budget SKU', { sku: 'S'.repeat(257) }],
    ['over-workbook-envelope SKU', { sku: `${' '.repeat(3_841)}${'😀'.repeat(256)}` }],
    ['empty business types', { businessTypes: [] }],
    ['duplicate business type', { businessTypes: [BusinessType.RETAIL_STORE, BusinessType.RETAIL_STORE] }],
    ['unknown business type', { businessTypes: ['FUTURE_TYPE'] }],
    ['blank name', { name: ' ' }],
    ['blank description', { description: '\t' }],
    ['blank presentation', { presentationLabel: '' }],
    ['blank SAT product key', { satProductKey: ' ' }],
    ['short SAT product key', { satProductKey: '5020170' }],
    ['non-digit SAT product key', { satProductKey: '5020A706' }],
    ['non-string SAT product key', { satProductKey: 50201706 }],
    ['blank SAT unit key', { satUnitKey: ' ' }],
    ['overlength SAT unit key', { satUnitKey: 'A'.repeat(21) }],
    ['non-string SAT unit key', { satUnitKey: 87 }],
    ['blank objetoImp', { objetoImp: ' ' }],
    ['unknown objetoImp', { objetoImp: '05' }],
    ['non-string objetoImp', { objetoImp: 2 }],
    ['unsafe image URL', { imageUrl: 'ftp://example.test/image.jpg' }],
    ['tax precision over scale 4', { taxRate: '0.12345' }],
    ['negative tax', { taxRate: '-0.1000' }],
    ['tax above the database ratio maximum', { taxRate: '1.0001' }],
    ['tax over Decimal(5,4)', { taxRate: '10.0000' }],
    ['non-string tax', { taxRate: 0.16 }],
    ['unknown item unit', { unit: 'FUTURE_UNIT' }],
    [
      'no same-currency sale/cost pair',
      {
        organizationValues: [
          { kind: CatalogItemPriceKind.SALE_PRICE, amount: '1.00', currency: 'MXN' },
          { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '1.00', currency: 'USD' },
        ],
      },
    ],
    ['three-decimal organization value', { organizationValues: [{ kind: 'SALE_PRICE', amount: '1.001', currency: 'MXN' }] }],
    ['null organization value row', { organizationValues: [null, baseline.organizationValues[0]] }],
    ['primitive organization value row', { organizationValues: ['MXN', baseline.organizationValues[0]] }],
    [
      'lowercase currency',
      {
        organizationValues: [
          { kind: CatalogItemPriceKind.SALE_PRICE, amount: '1.00', currency: 'mxn' },
          { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '1.00', currency: 'mxn' },
        ],
      },
    ],
    [
      'well-shaped but non-ISO currency',
      {
        organizationValues: [
          { kind: CatalogItemPriceKind.SALE_PRICE, amount: '1.00', currency: 'ZZZ' },
          { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '1.00', currency: 'ZZZ' },
        ],
      },
    ],
    ['duplicate value key', { organizationValues: [...baseline.organizationValues, baseline.organizationValues[0]] }],
    ['NONE with a rate', { iepsMode: CatalogIepsMode.NONE, iepsRate: '0.100000' }],
    ['RATE without a rate', { iepsMode: CatalogIepsMode.RATE, iepsRate: null }],
    ['RATE with quota fields', { iepsMode: CatalogIepsMode.RATE, iepsRate: '0.1', iepsQuota: '1', iepsQuotaUnit: Unit.UNIT }],
    ['QUOTA without quota unit', { iepsMode: CatalogIepsMode.QUOTA, iepsQuota: '1.0000', iepsQuotaUnit: null }],
    ['BOTH without rate', { iepsMode: CatalogIepsMode.BOTH, iepsRate: null, iepsQuota: '1.0000', iepsQuotaUnit: Unit.UNIT }],
    ['IEPS rate over scale 6', { iepsMode: CatalogIepsMode.RATE, iepsRate: '0.1234567' }],
    ['negative IEPS rate', { iepsMode: CatalogIepsMode.RATE, iepsRate: '-0.000001' }],
    ['IEPS RATE above the database ratio maximum', { iepsMode: CatalogIepsMode.RATE, iepsRate: '1.000001' }],
    [
      'IEPS BOTH above the database ratio maximum',
      { iepsMode: CatalogIepsMode.BOTH, iepsRate: '1.000001', iepsQuota: '1.0000', iepsQuotaUnit: Unit.UNIT },
    ],
    ['IEPS quota over scale 4', { iepsMode: CatalogIepsMode.QUOTA, iepsQuota: '1.12345', iepsQuotaUnit: Unit.UNIT }],
    ['negative IEPS quota', { iepsMode: CatalogIepsMode.QUOTA, iepsQuota: '-0.0001', iepsQuotaUnit: Unit.UNIT }],
    ['IEPS quota above Decimal(12,4)', { iepsMode: CatalogIepsMode.QUOTA, iepsQuota: '100000000.0000', iepsQuotaUnit: Unit.UNIT }],
    ['unknown IEPS quota unit', { iepsMode: CatalogIepsMode.QUOTA, iepsQuota: '1.0000', iepsQuotaUnit: 'FUTURE_UNIT' }],
    ['incompatible ProductType', { productType: ProductType.SERVICE }],
  ])('rejects %s with a stable 422', (_label, override) => {
    expect(() => validateCatalogItemInput({ ...baseline, ...override } as CreateCatalogItemInput, 'CREATE')).toThrow(
      expect.objectContaining({ statusCode: 422 }),
    )
  })

  it.each([
    [CatalogIepsMode.NONE, null, null, null],
    [CatalogIepsMode.RATE, '0.100000', null, null],
    [CatalogIepsMode.QUOTA, null, '1.2500', Unit.UNIT],
    [CatalogIepsMode.BOTH, '0.100000', '1.2500', Unit.UNIT],
  ])('accepts and canonicalizes the complete IEPS %s matrix', (iepsMode, iepsRate, iepsQuota, iepsQuotaUnit) => {
    const result = validateCatalogItemInput({ ...baseline, iepsMode, iepsRate, iepsQuota, iepsQuotaUnit }, 'CREATE')

    expect(result.taxRate).toBe('0.1600')
    expect(result.iepsRate).toBe(iepsRate)
    expect(result.iepsQuota).toBe(iepsQuota)
    expect(result.organizationValues).toEqual([
      { kind: CatalogItemPriceKind.SALE_PRICE, amount: '120.00', currency: 'MXN', expectedRuleRevision: undefined },
      { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '80.50', currency: 'MXN', expectedRuleRevision: undefined },
    ])
  })

  it('accepts the exact database maxima for tax, IEPS rate, and IEPS quota', () => {
    // WHY: Boundary-equality coverage pins the service to Task 2 DECIMAL/check
    // constraints while adjacent overflow cases remain rejected above.
    const result = validateCatalogItemInput(
      {
        ...baseline,
        taxRate: '1.0000',
        iepsMode: CatalogIepsMode.BOTH,
        iepsRate: '1.000000',
        iepsQuota: '99999999.9999',
        iepsQuotaUnit: Unit.UNIT,
      },
      'CREATE',
    )
    expect(result).toMatchObject({ taxRate: '1.0000', iepsRate: '1.000000', iepsQuota: '99999999.9999' })
  })

  it.each(['MXN', 'USD', 'EUR'])('accepts frozen ISO-4217 currency %s', currency => {
    const organizationValues = baseline.organizationValues.map(value => ({ ...value, currency }))
    expect(validateCatalogItemInput({ ...baseline, organizationValues }, 'CREATE').organizationValues).toEqual(
      expect.arrayContaining([expect.objectContaining({ currency })]),
    )
  })

  it('preserves a long submitted SKU display when its final corporate key remains indexable', () => {
    const sku = `${' '.repeat(3_840)}${'😀'.repeat(256)}`
    expect(validateCatalogItemInput({ ...baseline, sku }, 'CREATE')).toMatchObject({ sku, normalizedSku: '😀'.repeat(256) })
  })
})

// WHY: CREATE must not accept stale-row metadata, while UPDATE preserves each
// positive rule revision for the transaction service's preflight and CAS.
describe('validateCatalogItemInput organization rule revisions', () => {
  it('rejects expectedRuleRevision on CREATE', () => {
    const organizationValues = baseline.organizationValues.map(value => ({ ...value, expectedRuleRevision: 1 }))
    expect(() => validateCatalogItemInput({ ...baseline, organizationValues }, 'CREATE')).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'CATALOG_VALUE_REVISION_INVALID' }),
    )
  })

  it.each([0, -1, 1.5, 2_147_483_647, 2_147_483_648, Number.MAX_SAFE_INTEGER, Number.NaN, '1', null])(
    'rejects invalid UPDATE rule revision %p',
    expectedRuleRevision => {
      const organizationValues = baseline.organizationValues.map(value => ({ ...value, expectedRuleRevision }))
      expect(() =>
        validateCatalogItemInput(
          { ...baseline, organizationValues, organizationValueDeactivations: [] } as unknown as UpdateCatalogItemInput,
          'UPDATE',
        ),
      ).toThrow(expect.objectContaining({ statusCode: 422, code: 'CATALOG_VALUE_REVISION_INVALID' }))
    },
  )

  it('preserves valid UPDATE rule revisions without converting money through number', () => {
    const organizationValues = baseline.organizationValues.map(value => ({ ...value, expectedRuleRevision: 2_147_483_646 }))
    const result = validateCatalogItemInput(
      {
        ...baseline,
        catalogItemId: 'catalog-item-1',
        expectedRevision: 1,
        organizationValues,
        organizationValueDeactivations: [],
      },
      'UPDATE',
    )

    expect(result.organizationValues).toEqual([
      { kind: CatalogItemPriceKind.SALE_PRICE, amount: '120.00', currency: 'MXN', expectedRuleRevision: 2_147_483_646 },
      { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '80.50', currency: 'MXN', expectedRuleRevision: 2_147_483_646 },
    ])
  })
})

// WHY: Explicit tombstones carry caller CAS for omitted ACTIVE rows; their
// shape must be closed, unique, and disjoint from the retained active set.
describe('validateCatalogItemInput organization value deactivations', () => {
  const activeValues = baseline.organizationValues.map(value => ({ ...value, expectedRuleRevision: 1 }))

  function update(overrides: Partial<UpdateCatalogItemInput> = {}): UpdateCatalogItemInput {
    return {
      ...baseline,
      catalogItemId: 'catalog-item-1',
      expectedRevision: 1,
      organizationValues: activeValues,
      organizationValueDeactivations: [],
      ...overrides,
    }
  }

  it('requires an explicit tombstone array on UPDATE', () => {
    const value = update()
    delete (value as Partial<UpdateCatalogItemInput>).organizationValueDeactivations
    expect(() => validateCatalogItemInput(value, 'UPDATE')).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'CATALOG_VALUE_DEACTIVATION_INVALID' }),
    )
  })

  it.each([
    ['overlaps an active key', [{ kind: CatalogItemPriceKind.SALE_PRICE, currency: 'MXN', expectedRuleRevision: 1 }]],
    [
      'duplicates a key',
      [
        { kind: CatalogItemPriceKind.SALE_PRICE, currency: 'USD', expectedRuleRevision: 1 },
        { kind: CatalogItemPriceKind.SALE_PRICE, currency: 'USD', expectedRuleRevision: 1 },
      ],
    ],
    ['contains null', [null]],
    ['contains a primitive', ['USD']],
    ['uses a non-ISO currency', [{ kind: CatalogItemPriceKind.SALE_PRICE, currency: 'ZZZ', expectedRuleRevision: 1 }]],
    ['uses an invalid kind', [{ kind: 'FUTURE_KIND', currency: 'USD', expectedRuleRevision: 1 }]],
    ['uses an exhausted revision', [{ kind: CatalogItemPriceKind.SALE_PRICE, currency: 'USD', expectedRuleRevision: 2_147_483_647 }]],
  ])('rejects a tombstone set that %s', (_label, organizationValueDeactivations) => {
    expect(() =>
      validateCatalogItemInput(update({ organizationValueDeactivations } as unknown as Partial<UpdateCatalogItemInput>), 'UPDATE'),
    ).toThrow(expect.objectContaining({ statusCode: 422 }))
  })

  it('preserves a valid tombstone without numeric coercion', () => {
    const organizationValueDeactivations = [{ kind: CatalogItemPriceKind.SALE_PRICE, currency: 'USD', expectedRuleRevision: 2_147_483_646 }]
    expect(validateCatalogItemInput(update({ organizationValueDeactivations }), 'UPDATE').organizationValueDeactivations).toEqual(
      organizationValueDeactivations,
    )
  })
})
