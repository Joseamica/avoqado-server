import campaignFixture from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import {
  CommercialContractV2ValidationError,
  validateCommercialQuoteV2 as validateCommercialQuoteV2WithAuthorities,
} from '@/services/commercial/commercialContractV2.service'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

const catalogAuthority = catalogFixture as unknown as CommercialCatalogSnapshotV2
const campaignAuthority = campaignFixture as unknown as CommercialCampaignSnapshotV2

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function validationRule(operation: () => unknown): string {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(CommercialContractV2ValidationError)
    return (error as CommercialContractV2ValidationError).rule
  }
  throw new Error('Expected commercial v2 validation failure')
}

export function expectTrustedSnapshot<T>(snapshot: T, source: unknown): void {
  expect(snapshot).toEqual(source)
  expect(snapshot).not.toBe(source)
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    expect(Object.isFrozen(value)).toBe(true)
    Object.values(value).forEach(visit)
  }
  visit(snapshot)
}

export function validateCommercialQuoteV2(value: unknown) {
  return validateCommercialQuoteV2WithAuthorities(value, { catalog: catalogAuthority, campaign: campaignAuthority })
}

export function validateQuoteAgainst(value: unknown, campaign: any, catalog: any = catalogFixture) {
  return validateCommercialQuoteV2WithAuthorities(value, { catalog, campaign })
}

export function parseMinor(value: string): bigint {
  const [whole, fraction] = value.split('.')
  return BigInt(whole) * 100n + BigInt(fraction)
}

export function formatMinor(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`
}

export function taxMinor(subtotal: bigint, basisPoints: number): bigint {
  return (subtotal * BigInt(basisPoints) + 5_000n) / 10_000n
}

export function setCurrentSubtotal(line: any, subtotal: string): void {
  const list = parseMinor(line.listSubtotal)
  const current = parseMinor(subtotal)
  const tax = taxMinor(current, line.taxRateBasisPoints)
  line.discount = formatMinor(list - current)
  line.subtotal = subtotal
  line.tax = formatMinor(tax)
  line.total = formatMinor(current + tax)
}

export function reconcileQuoteTotals(quote: any): void {
  const sum = (field: string) => quote.lines.reduce((total: bigint, line: any) => total + parseMinor(line[field]), 0n)
  const listSubtotal = sum('listSubtotal')
  const discount = sum('discount')
  const subtotal = sum('subtotal')
  const tax = sum('tax')
  const renewalSubtotal = sum('renewalSubtotal')
  const renewalTax = sum('renewalTax')
  quote.totals = {
    listSubtotal: formatMinor(listSubtotal),
    discount: formatMinor(discount),
    subtotal: formatMinor(subtotal),
    tax: formatMinor(tax),
    total: formatMinor(subtotal + tax),
  }
  quote.renewal = {
    subtotal: formatMinor(renewalSubtotal),
    tax: formatMinor(renewalTax),
    total: formatMinor(renewalSubtotal + renewalTax),
  }
}

export function productLine(productCode: string, priceCode: string): any {
  const product = catalogFixture.products.find(candidate => candidate.code === productCode)!
  const price = product.prices.find(candidate => candidate.code === priceCode)!
  const amount = parseMinor(price.amount)
  const tax = taxMinor(amount, price.taxRateBasisPoints)
  return {
    lineKey: `PRODUCT:${product.code}:${price.code}`,
    targetType: 'PRODUCT',
    targetCode: product.code,
    priceCode: price.code,
    quantity: 1,
    productKind: product.kind,
    name: product.name,
    billingUnit: price.billingUnit,
    currency: price.currency,
    taxRateBasisPoints: price.taxRateBasisPoints,
    unitAmount: price.amount,
    listSubtotal: price.amount,
    appliedCampaigns: [],
    discount: '0.00',
    subtotal: price.amount,
    tax: formatMinor(tax),
    total: formatMinor(amount + tax),
    promotionalCycles: null,
    renewalSubtotal: price.amount,
    renewalTax: formatMinor(tax),
    renewalTotal: formatMinor(amount + tax),
  }
}

export function productGrant(productCode: string, lineKey: string, campaign: boolean): any {
  const product = catalogFixture.products.find(candidate => candidate.code === productCode)!
  const binding = product.capabilityBindings[0]
  const baseOrigin = { kind: product.code === 'FREE' ? 'FREE' : 'PRODUCT', sourceCode: product.code, lineKey }
  return {
    capabilityCode: binding.capabilityCode,
    capabilityKind: binding.capabilityKind,
    origins: campaign
      ? [
          baseOrigin,
          {
            kind: 'CAMPAIGN',
            sourceCode: campaignFixture.campaignCode,
            sourceId: campaignFixture.campaignVersionId,
            lineKey,
          },
        ]
      : [baseOrigin],
    activationRequirement: binding.activationRequirement,
  }
}
