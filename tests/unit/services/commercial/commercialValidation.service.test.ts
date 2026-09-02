import { normalizeAndValidateCommercialDraft, type CommercialValidationError } from '@/services/commercial/commercialValidation.service'
import type { CommercialDraftInput } from '@/types/commercial'

function validDraft(): CommercialDraftInput {
  return {
    name: 'Catálogo México',
    description: 'Oferta comercial aprobada para pruebas.',
    products: [
      {
        code: 'PRO',
        slug: 'pro',
        kind: 'PLAN',
        salesMode: 'SELF_SERVICE',
        name: 'Pro',
        description: 'Plan para operar y crecer.',
        active: true,
        sortOrder: 10,
      },
      {
        code: 'POS',
        slug: 'pos',
        kind: 'POS',
        salesMode: 'SELF_SERVICE',
        name: 'Punto de venta',
        description: 'Punto de venta por sucursal.',
        active: true,
        sortOrder: 20,
        limits: { users: 'UNLIMITED', devices: 'UNLIMITED' },
      },
      {
        code: 'KDS_MODULE',
        slug: 'pantalla-cocina',
        kind: 'MODULE',
        salesMode: 'SELF_SERVICE',
        name: 'Pantalla de cocina',
        description: 'Órdenes visibles en cocina.',
        active: true,
        sortOrder: 30,
      },
    ],
    pricebooks: [{ code: 'MX_STANDARD', name: 'México estándar', active: true }],
    prices: [
      {
        code: 'PRO_MONTHLY',
        pricebookCode: 'MX_STANDARD',
        productCode: 'PRO',
        billingUnit: 'VENUE_MONTH',
        amount: '999.00',
        taxBehavior: 'EXCLUSIVE',
        active: true,
      },
      {
        code: 'PRO_ANNUAL',
        pricebookCode: 'MX_STANDARD',
        productCode: 'PRO',
        billingUnit: 'VENUE_YEAR',
        amount: '9990.00',
        taxBehavior: 'EXCLUSIVE',
        active: true,
      },
      {
        code: 'POS_MONTHLY',
        pricebookCode: 'MX_STANDARD',
        productCode: 'POS',
        billingUnit: 'VENUE_MONTH',
        amount: '249.00',
        taxBehavior: 'EXCLUSIVE',
        active: true,
      },
      {
        code: 'KDS_MONTHLY',
        pricebookCode: 'MX_STANDARD',
        productCode: 'KDS_MODULE',
        billingUnit: 'VENUE_MONTH',
        amount: '179.00',
        taxBehavior: 'EXCLUSIVE',
        active: true,
      },
      {
        code: 'ALL_MODULES_MONTHLY',
        pricebookCode: 'MX_STANDARD',
        bundleCode: 'ALL_MODULES',
        billingUnit: 'VENUE_MONTH',
        amount: '1999.00',
        taxBehavior: 'EXCLUSIVE',
        active: true,
      },
    ],
    bundles: [
      {
        code: 'ALL_MODULES',
        slug: 'todos-los-modulos',
        name: 'Todos los módulos',
        description: 'Paquete modular completo.',
        active: true,
        sortOrder: 10,
      },
    ],
    bundleItems: [{ bundleCode: 'ALL_MODULES', productCode: 'KDS_MODULE', quantity: 1, sortOrder: 10 }],
    featureBindings: [
      { productCode: 'PRO', capabilityCode: 'ADVANCED_REPORTS', capabilityKind: 'FEATURE' },
      { productCode: 'POS', capabilityCode: 'POS_CORE', capabilityKind: 'CORE' },
      { productCode: 'KDS_MODULE', capabilityCode: 'KITCHEN_DISPLAY', capabilityKind: 'FEATURE' },
    ],
  }
}

function codes(errors: CommercialValidationError[]): string[] {
  return errors.map(error => error.code)
}

describe('normalizeAndValidateCommercialDraft', () => {
  it('normalizes exact MXN decimal strings to integer minor units', () => {
    const result = normalizeAndValidateCommercialDraft(validDraft())

    expect(result.valid).toBe(true)
    expect(result.normalizedSnapshot?.products.find(product => product.code === 'POS')?.prices[0]?.amountMinor).toBe(24900)
    expect(JSON.stringify(result.normalizedSnapshot)).not.toContain('249.00')
  })

  it('rejects sub-cent, numeric and negative money instead of rounding it', () => {
    const subCent = validDraft()
    subCent.prices[0].amount = '999.001'
    const numeric = validDraft()
    ;(numeric.prices[0] as unknown as { amount: string | number }).amount = 999
    const negative = validDraft()
    negative.prices[0].amount = '-1.00'

    expect(codes(normalizeAndValidateCommercialDraft(subCent).errors)).toContain('INVALID_MONEY')
    expect(codes(normalizeAndValidateCommercialDraft(numeric as CommercialDraftInput).errors)).toContain('INVALID_MONEY')
    expect(codes(normalizeAndValidateCommercialDraft(negative).errors)).toContain('INVALID_MONEY')
  })

  it('rejects duplicate product and price codes', () => {
    const draft = validDraft()
    draft.products.push({ ...draft.products[0], slug: 'pro-duplicado' })
    draft.prices.push({ ...draft.prices[0], productCode: 'POS' })

    const result = normalizeAndValidateCommercialDraft(draft)

    expect(codes(result.errors)).toEqual(expect.arrayContaining(['DUPLICATE_PRODUCT_CODE', 'DUPLICATE_PRICE_CODE']))
  })

  it('rejects missing bundle targets and invalid capability codes', () => {
    const draft = validDraft()
    draft.bundleItems[0].productCode = 'DOES_NOT_EXIST'
    draft.featureBindings[0].capabilityCode = 'reportes avanzados'

    const result = normalizeAndValidateCommercialDraft(draft)

    expect(codes(result.errors)).toEqual(expect.arrayContaining(['UNKNOWN_BUNDLE_PRODUCT', 'INVALID_CAPABILITY_CODE']))
  })

  it('requires monthly and annual prices for self-service plans', () => {
    const draft = validDraft()
    draft.prices = draft.prices.filter(price => price.code !== 'PRO_ANNUAL')

    expect(codes(normalizeAndValidateCommercialDraft(draft).errors)).toContain('MISSING_PLAN_BILLING_PAIR')
  })

  it('does not count prices from inactive pricebooks toward a self-service billing pair', () => {
    const draft = validDraft()
    draft.pricebooks[0].active = false

    const result = normalizeAndValidateCommercialDraft(draft)

    expect(codes(result.errors)).toContain('MISSING_PLAN_BILLING_PAIR')
    expect(result.normalizedSnapshot).toBeNull()
  })

  it('requires the monthly and annual plan prices to come from the same active pricebook', () => {
    const draft = validDraft()
    draft.pricebooks.push({ code: 'MX_ANNUAL', name: 'México anual', active: true })
    draft.prices.find(price => price.code === 'PRO_ANNUAL')!.pricebookCode = 'MX_ANNUAL'

    expect(codes(normalizeAndValidateCommercialDraft(draft).errors)).toContain('MISSING_PLAN_BILLING_PAIR')
  })

  it('rejects an active bundle that references an inactive product', () => {
    const draft = validDraft()
    draft.products.find(product => product.code === 'KDS_MODULE')!.active = false

    const result = normalizeAndValidateCommercialDraft(draft)

    expect(codes(result.errors)).toContain('INACTIVE_BUNDLE_PRODUCT')
    expect(result.normalizedSnapshot).toBeNull()
  })

  it('keeps $22 and $50 out of base pricebooks because they belong to campaigns', () => {
    for (const forbiddenAmount of ['22.00', '50.00']) {
      const draft = validDraft()
      draft.prices.find(price => price.code === 'POS_MONTHLY')!.amount = forbiddenAmount

      expect(codes(normalizeAndValidateCommercialDraft(draft).errors)).toContain('CAMPAIGN_PRICE_IN_BASE_CATALOG')
    }
  })

  it('rejects overlapping active pricebooks for the same target and billing unit', () => {
    const draft = validDraft()
    draft.pricebooks.push({ code: 'MX_SECONDARY', name: 'México secundario', active: true })
    draft.prices.push({
      ...draft.prices.find(price => price.code === 'POS_MONTHLY')!,
      code: 'POS_MONTHLY_SECONDARY',
      pricebookCode: 'MX_SECONDARY',
    })

    expect(codes(normalizeAndValidateCommercialDraft(draft).errors)).toContain('AMBIGUOUS_ACTIVE_PRICE')
  })

  it('rejects capability typos and a kind that disagrees with the canonical gate registry', () => {
    const typo = validDraft()
    typo.featureBindings[0].capabilityCode = 'ADVANCED_REPORTS_TYPO'
    expect(codes(normalizeAndValidateCommercialDraft(typo).errors)).toContain('UNKNOWN_CAPABILITY_CODE')

    const wrongKind = validDraft()
    wrongKind.featureBindings.find(binding => binding.capabilityCode === 'ADVANCED_REPORTS')!.capabilityKind = 'MODULE'
    expect(codes(normalizeAndValidateCommercialDraft(wrongKind).errors)).toContain('CAPABILITY_KIND_MISMATCH')
  })

  it('rejects drafts whose normalized preview violates the frozen public contract', () => {
    const withoutProducts = validDraft()
    withoutProducts.products.forEach(product => {
      product.active = false
    })
    withoutProducts.bundles[0].active = false
    expect(codes(normalizeAndValidateCommercialDraft(withoutProducts).errors)).toContain('COMMERCIAL_CONTRACT_INVALID')

    const bundleWithoutItems = validDraft()
    bundleWithoutItems.bundleItems = []
    expect(codes(normalizeAndValidateCommercialDraft(bundleWithoutItems).errors)).toContain('COMMERCIAL_CONTRACT_INVALID')

    const bundleWithoutPrices = validDraft()
    bundleWithoutPrices.prices = bundleWithoutPrices.prices.filter(price => price.bundleCode !== 'ALL_MODULES')
    expect(codes(normalizeAndValidateCommercialDraft(bundleWithoutPrices).errors)).toContain('COMMERCIAL_CONTRACT_INVALID')
  })

  it('requires IVA 16% for positive prices and tax exemption only for zero prices', () => {
    const positiveExempt = validDraft()
    positiveExempt.prices.find(price => price.code === 'POS_MONTHLY')!.taxBehavior = 'NOT_APPLICABLE'
    expect(codes(normalizeAndValidateCommercialDraft(positiveExempt).errors)).toContain('POSITIVE_PRICE_REQUIRES_IVA')

    const zeroTaxed = validDraft()
    zeroTaxed.prices.find(price => price.code === 'POS_MONTHLY')!.amount = '0.00'
    expect(codes(normalizeAndValidateCommercialDraft(zeroTaxed).errors)).toContain('FREE_PRICE_MUST_BE_TAX_EXEMPT')
  })

  it('freezes bundle quantity at one while contract v1 models membership only', () => {
    const draft = validDraft()
    draft.bundleItems[0].quantity = 2

    const result = normalizeAndValidateCommercialDraft(draft)

    expect(codes(result.errors)).toContain('INVALID_DRAFT_FIELD')
    expect(result.normalizedSnapshot).toBeNull()
  })
})
