import type { CommercialDraftView } from '@/types/commercial'

export function buildValidCommercialDraft(overrides: Partial<CommercialDraftView> = {}): CommercialDraftView {
  return {
    id: 'draft_1',
    name: 'Catálogo México',
    description: 'Catálogo comercial de prueba.',
    revision: 3,
    status: 'ACTIVE',
    products: [
      {
        code: 'PRO',
        slug: 'pro',
        kind: 'PLAN',
        salesMode: 'SELF_SERVICE',
        name: 'Pro',
        description: 'Plan Pro.',
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
    ],
    bundles: [],
    bundleItems: [],
    featureBindings: [
      { productCode: 'PRO', capabilityCode: 'ADVANCED_REPORTS', capabilityKind: 'FEATURE' },
      { productCode: 'POS', capabilityCode: 'POS_CORE', capabilityKind: 'CORE' },
    ],
    ...overrides,
  }
}
