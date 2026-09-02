import fixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import type {
  CommercialBillingUnit,
  CommercialDraftInput,
  CommercialProductKind,
  CommercialSalesMode,
  CommercialTaxBehavior,
} from '@/types/commercial'
import { getCommercialCapabilityKind } from './commercialCapabilityRegistry'
import type { CommercialCapabilityKind } from '@/types/commercial'

export const COMMERCIAL_INITIAL_SOURCE_KEY = 'MEXICO_INITIAL_CATALOG_V1'
const PRICEBOOK_CODE = 'MX_STANDARD'

interface FixturePrice {
  code: string
  billingUnit: CommercialBillingUnit
  amountMinor: number
  taxBehavior: CommercialTaxBehavior
}

interface FixtureProduct {
  code: string
  slug: string
  kind: CommercialProductKind
  name: string
  description: string
  salesMode: CommercialSalesMode
  capabilityCodes: string[]
  prices: FixturePrice[]
  limits?: { users: 'UNLIMITED'; devices: 'UNLIMITED' }
}

interface FixtureBundle {
  code: string
  slug: string
  name: string
  description: string
  itemProductCodes: string[]
  prices: FixturePrice[]
}

function exactPesos(amountMinor: number): string {
  return `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, '0')}`
}

function requireCapabilityKind(capabilityCode: string): CommercialCapabilityKind {
  const kind = getCommercialCapabilityKind(capabilityCode)
  if (!kind) throw new Error(`Initial commercial fixture uses unknown capability ${capabilityCode}`)
  return kind
}

export function buildInitialCommercialDraftV1(): { sourceKey: string; draft: CommercialDraftInput } {
  const products = fixture.products as FixtureProduct[]
  const bundles = fixture.bundles as FixtureBundle[]
  return {
    sourceKey: COMMERCIAL_INITIAL_SOURCE_KEY,
    draft: {
      name: 'Avoqado México — catálogo comercial inicial',
      description: 'Paquetes y módulos aprobados para publicación humana en México.',
      products: products.map((product, index) => ({
        code: product.code,
        slug: product.slug,
        kind: product.kind,
        salesMode: product.salesMode,
        name: product.name,
        description: product.description,
        active: true,
        sortOrder: (index + 1) * 10,
        ...(product.limits ? { limits: { ...product.limits } } : {}),
      })),
      pricebooks: [{ code: PRICEBOOK_CODE, name: 'México estándar', active: true }],
      prices: [
        ...products.flatMap(product =>
          product.prices.map(price => ({
            code: price.code,
            pricebookCode: PRICEBOOK_CODE,
            productCode: product.code,
            billingUnit: price.billingUnit,
            amount: exactPesos(price.amountMinor),
            taxBehavior: price.taxBehavior,
            active: true,
          })),
        ),
        ...bundles.flatMap(bundle =>
          bundle.prices.map(price => ({
            code: price.code,
            pricebookCode: PRICEBOOK_CODE,
            bundleCode: bundle.code,
            billingUnit: price.billingUnit,
            amount: exactPesos(price.amountMinor),
            taxBehavior: price.taxBehavior,
            active: true,
          })),
        ),
      ],
      bundles: bundles.map((bundle, index) => ({
        code: bundle.code,
        slug: bundle.slug,
        name: bundle.name,
        description: bundle.description,
        active: true,
        sortOrder: (index + 1) * 10,
      })),
      bundleItems: bundles.flatMap(bundle =>
        bundle.itemProductCodes.map((productCode, index) => ({
          bundleCode: bundle.code,
          productCode,
          quantity: 1,
          sortOrder: (index + 1) * 10,
        })),
      ),
      featureBindings: products.flatMap(product =>
        product.capabilityCodes.map(capabilityCode => ({
          productCode: product.code,
          capabilityCode,
          capabilityKind: requireCapabilityKind(capabilityCode),
        })),
      ),
    },
  }
}
