import Ajv from 'ajv'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  COMMERCIAL_CONTRACT_HASH,
  COMMERCIAL_CATALOG_CONTRACT_HASH,
  COMMERCIAL_CONTRACT_SCHEMA_VERSION,
  computeCommercialContractHash,
} from '@/contracts/commercial/contractHash'

const contractDir = path.resolve(process.cwd(), 'src/contracts/commercial')
const schema = JSON.parse(readFileSync(path.join(contractDir, 'commercial-contract-v1.schema.json'), 'utf8'))
const fixture = JSON.parse(readFileSync(path.join(contractDir, 'fixtures/catalog-v1.json'), 'utf8'))
const validate = new Ajv({ allErrors: true, jsonPointers: true }).compile(schema)

function product(code: string) {
  const found = fixture.products.find((candidate: { code: string }) => candidate.code === code)
  if (!found) throw new Error(`Missing fixture product ${code}`)
  return found
}

function price(code: string, billingUnit: string) {
  const found = product(code).prices.find((candidate: { billingUnit: string }) => candidate.billingUnit === billingUnit)
  if (!found) throw new Error(`Missing ${code} ${billingUnit} price`)
  return found
}

function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, nested]) => [key, ...keys(nested)])
}

describe('Commercial Contract v1', () => {
  it('validates the frozen initial catalog and contract hash', () => {
    expect(validate(fixture)).toBe(true)
    expect(validate.errors).toBeNull()
    expect(COMMERCIAL_CONTRACT_SCHEMA_VERSION).toBe(1)
    expect(COMMERCIAL_CONTRACT_HASH).toMatch(/^[0-9a-f]{64}$/)
    expect(COMMERCIAL_CATALOG_CONTRACT_HASH).toBe(computeCommercialContractHash(schema, fixture))
    expect(COMMERCIAL_CONTRACT_HASH).not.toBe(COMMERCIAL_CATALOG_CONTRACT_HASH)
  })

  it('freezes the approved package and POS prices in integer minor MXN units', () => {
    expect(price('FREE', 'VENUE_MONTH').amountMinor).toBe(0)
    expect(price('PRO', 'VENUE_MONTH').amountMinor).toBe(99_900)
    expect(price('PRO', 'VENUE_YEAR').amountMinor).toBe(999_000)
    expect(price('PREMIUM', 'VENUE_MONTH').amountMinor).toBe(169_900)
    expect(price('PREMIUM', 'VENUE_YEAR').amountMinor).toBe(1_699_000)
    expect(product('ENTERPRISE')).toMatchObject({ salesMode: 'CONTACT', prices: [] })
    expect(price('POS', 'VENUE_MONTH')).toMatchObject({ amountMinor: 24_900, currency: 'MXN' })
    expect(product('POS').limits).toEqual({ users: 'UNLIMITED', devices: 'UNLIMITED' })
  })

  it('freezes six standard modules, three advanced modules and the nine-module bundle', () => {
    const modules = fixture.products.filter((candidate: { kind: string }) => candidate.kind === 'MODULE')
    expect(modules).toHaveLength(9)
    expect(
      modules.filter((candidate: { prices: Array<{ amountMinor: number }> }) => candidate.prices[0].amountMinor === 17_900),
    ).toHaveLength(6)
    expect(
      modules.filter((candidate: { prices: Array<{ amountMinor: number }> }) => candidate.prices[0].amountMinor === 26_900),
    ).toHaveLength(3)
    expect(fixture.bundles).toEqual([
      expect.objectContaining({
        code: 'ALL_MODULES',
        itemProductCodes: expect.arrayContaining(modules.map((row: { code: string }) => row.code)),
      }),
    ])
    expect(fixture.bundles[0].itemProductCodes).toHaveLength(9)
    expect(fixture.bundles[0].prices[0].amountMinor).toBe(199_900)
  })

  it('contains no campaign-only base amount, founder offer or sensitive commercial field', () => {
    const amounts = [
      ...fixture.products.flatMap((row: { prices: Array<{ amountMinor: number }> }) => row.prices.map(priceRow => priceRow.amountMinor)),
      ...fixture.bundles.flatMap((row: { prices: Array<{ amountMinor: number }> }) => row.prices.map(priceRow => priceRow.amountMinor)),
    ]
    expect(amounts).not.toContain(2_200)
    expect(amounts).not.toContain(5_000)
    expect(JSON.stringify(fixture)).not.toMatch(/fundadores?/i)
    expect(keys(fixture).filter(key => /cost|payout|commission|margin/i.test(key))).toEqual([])
  })

  it.each([
    [
      'fractional amount',
      (copy: any) => {
        copy.products[0].prices[0].amountMinor = 1.5
      },
    ],
    [
      'negative amount',
      (copy: any) => {
        copy.products[0].prices[0].amountMinor = -1
      },
    ],
    [
      'unknown root field',
      (copy: any) => {
        copy.internalCost = 100
      },
    ],
    [
      'unknown product kind',
      (copy: any) => {
        copy.products[0].kind = 'UNKNOWN'
      },
    ],
    [
      'positive tax-exempt price',
      (copy: any) => {
        const posPrice = copy.products.find((candidate: { code: string }) => candidate.code === 'POS').prices[0]
        posPrice.taxBehavior = 'NOT_APPLICABLE'
        posPrice.taxRateBasisPoints = 0
      },
    ],
    [
      'zero price with IVA',
      (copy: any) => {
        const freePrice = copy.products.find((candidate: { code: string }) => candidate.code === 'FREE').prices[0]
        freePrice.taxBehavior = 'EXCLUSIVE'
        freePrice.taxRateBasisPoints = 1600
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const invalid = structuredClone(fixture)
    mutate(invalid)
    expect(validate(invalid)).toBe(false)
  })
})
