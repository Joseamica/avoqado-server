import Ajv from 'ajv'

import resolutionSchema from '@/contracts/commercial/commercial-offer-resolution-v2.schema.json'
import resolutionFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-resolution-v2.json'
import fixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import {
  COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS,
  resolveCommercialOfferV3,
} from '@/services/commercial/offers/commercialOfferStacking.service'
import {
  decodeAndVerifyStoredCommercialOfferV3,
  emitCommercialOfferV3,
  validateCommercialOfferV3,
} from '@/services/commercial/offers/commercialOfferV3.service'
import { createHardwareSkuSnapshotV3 } from '@/services/commercial/offers/hardwareSkuSnapshot.service'
import type { CommercialBenefitV3 } from '@/types/commercialOfferV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function expectInvalid(value: unknown, rule?: string): void {
  try {
    validateCommercialOfferV3(value)
    throw new Error('EXPECTED_COMMERCIAL_OFFER_V3_FAILURE')
  } catch (error) {
    expect(error).toMatchObject({ code: 'COMMERCIAL_OFFER_V3_INVALID', ...(rule ? { rule } : {}) })
  }
}

describe('Commercial Offer v3 contract', () => {
  it('ships a dedicated strict JSON Schema for resolver revision 2', () => {
    const validateResolution = new Ajv({ allErrors: true }).compile(resolutionSchema as object)
    expect(resolutionSchema.properties.applied.maxItems).toBe(COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS.maxAppliedItems)
    expect(resolutionSchema.properties.exclusions.maxItems).toBe(COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS.maxExcludedItems)
    expect(validateResolution(resolutionFixture.expected)).toBe(true)

    const missingHardwareQuantity = clone(resolutionFixture.expected) as any
    delete missingHardwareQuantity.applied[0].appliedQuantity
    expect(validateResolution(missingHardwareQuantity)).toBe(false)

    const unexpectedSaasQuantity = clone(resolutionFixture.expected) as any
    unexpectedSaasQuantity.applied.push({
      subjectKind: 'SAAS_LINE',
      subjectKey: 'line-pos',
      benefitCode: 'SAAS_POS_50',
      ruleCode: 'POS_FIXED_50',
      appliedQuantity: 1,
    })
    expect(validateResolution(unexpectedSaasQuantity)).toBe(false)

    const unexpectedUnselectedQuantity = clone(resolutionFixture.expected) as any
    unexpectedUnselectedQuantity.exclusions[1].excludedQuantity = 1
    expect(validateResolution(unexpectedUnselectedQuantity)).toBe(false)

    const unexpectedInactiveQuantity = clone(resolutionFixture.expected) as any
    unexpectedInactiveQuantity.exclusions.push({
      subjectKind: 'HARDWARE_SKU',
      subjectKey: 'NEXGO_N62',
      benefitCode: 'HARDWARE_N62_FIXED',
      excludedQuantity: 5,
      accountingEffect: 'EXPLANATORY',
      reasonCode: 'HARDWARE_WINDOW_INACTIVE',
    })
    expect(validateResolution(unexpectedInactiveQuantity)).toBe(false)

    const missingRateAccountingEffect = clone(resolutionFixture.expected) as any
    delete missingRateAccountingEffect.exclusions.at(-1).accountingEffect
    expect(validateResolution(missingRateAccountingEffect)).toBe(false)

    const unreachableAppliedRate = clone(resolutionFixture.expected) as any
    unreachableAppliedRate.applied.push({
      subjectKind: 'PAYMENTS_RATE',
      subjectKey: 'payments-rate-schedule-version-starter-2026-v1',
      benefitCode: 'PAYMENTS_STARTER_RATE',
    })
    expect(validateResolution(unreachableAppliedRate)).toBe(false)

    const actualSaasResolution = resolveCommercialOfferV3({
      offer: validateCommercialOfferV3(fixture),
      resolvedAt: '2026-08-15T12:00:00.000Z',
      saasMatches: [{ lineKey: 'line-pos', ruleCodes: ['POS_FIXED_50'] }],
      hardwareSelections: [],
      rateBlockers: [],
    })
    expect(validateResolution(actualSaasResolution)).toBe(true)
  })

  it('validates, freezes, emits and verifies the canonical four-benefit fixture', () => {
    const validated = validateCommercialOfferV3(fixture)
    const emitted = emitCommercialOfferV3(fixture)

    expect(validated).toEqual(fixture)
    expect(Object.isFrozen(validated)).toBe(true)
    expect(Object.isFrozen(validated.benefits)).toBe(true)
    expect(emitted.snapshot).toEqual(validated)
    expect(emitted.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(emitCommercialOfferV3(clone(fixture)).checksum).toBe(emitted.checksum)
    const decoded = decodeAndVerifyStoredCommercialOfferV3({
      rowSchemaVersion: 3,
      snapshot: emitted.snapshot,
      checksum: emitted.checksum,
      rowContext: {
        id: fixture.campaignVersionId,
        campaignCode: fixture.campaignCode,
        sourceRevision: fixture.version,
        schemaVersion: 3,
        publishedAt: new Date(fixture.publishedAt),
      },
    })
    expect(decoded.snapshot).toEqual(emitted.snapshot)
    expect(Object.isFrozen(decoded.snapshot)).toBe(true)
  })

  it('pins fixture hardware to the current authoritative TPV catalog bytes', () => {
    const hardwareBenefits = (fixture.benefits as unknown as CommercialBenefitV3[]).filter(
      (benefit): benefit is Extract<CommercialBenefitV3, { kind: 'HARDWARE_PERCENT_OFF' | 'HARDWARE_FIXED_PRICE' }> =>
        benefit.kind === 'HARDWARE_PERCENT_OFF' || benefit.kind === 'HARDWARE_FIXED_PRICE',
    )
    for (const benefit of hardwareBenefits) {
      expect(benefit.skuSnapshot).toEqual(createHardwareSkuSnapshotV3(benefit.skuSnapshot.catalogKey))
    }
  })

  it.each([
    ['unknown root field', (value: any) => Object.assign(value, { surprise: true })],
    ['unknown benefit field', (value: any) => Object.assign(value.benefits[0], { surprise: true })],
    ['unknown benefit kind', (value: any) => Object.assign(value.benefits[0], { kind: 'MYSTERY' })],
    ['schema mismatch', (value: any) => Object.assign(value, { schemaVersion: 2 })],
    ['contract mismatch', (value: any) => Object.assign(value, { contractVersion: '2.0.0' })],
  ])('rejects %s', (_label, mutate: (value: any) => void) => {
    const value = clone(fixture)
    mutate(value)
    expectInvalid(value)
  })

  it.each(['-1', '+1', '01', '1.0', '1e3', '1000000000000'])('rejects non-canonical or overflow minor amount %s', amount => {
    const value = clone(fixture)
    ;(value.benefits[0] as any).unitAmountMinor = amount
    expectInvalid(value)
  })

  it.each([0, 10001, 1.5])('rejects invalid basis points %s', basisPoints => {
    const value = clone(fixture)
    ;(value.benefits[1] as any).percentBasisPoints = basisPoints
    expectInvalid(value)
  })

  it.each([0, 1001, 1.5])('rejects invalid quantity %s', quantity => {
    const value = clone(fixture)
    ;(value.benefits[0] as any).quantityLimit = quantity
    expectInvalid(value)
  })

  it.each([
    ['inverted claim window', (value: any) => Object.assign(value, { claimEndsAt: value.claimStartsAt })],
    ['inverted benefit window', (value: any) => Object.assign(value.benefits[0], { benefitEndsAt: value.benefits[0].benefitStartsAt })],
    ['non-canonical timestamp', (value: any) => Object.assign(value, { claimStartsAt: '2026-08-01T06:00:00Z' })],
  ])('rejects %s', (_label, mutate: (value: any) => void) => {
    const value = clone(fixture)
    mutate(value)
    expectInvalid(value)
  })

  it('rejects duplicate codes and non-canonical benefit order', () => {
    const duplicate = clone(fixture)
    duplicate.benefits[1].benefitCode = duplicate.benefits[0].benefitCode
    expectInvalid(duplicate, 'BENEFIT_CODE_UNIQUE')

    const unordered = clone(fixture)
    unordered.benefits.reverse()
    expectInvalid(unordered, 'BENEFIT_ORDER')
  })

  it('rejects overlapping hardware price windows for one SKU but permits adjacent windows', () => {
    const overlap = clone(fixture)
    const second = clone(overlap.benefits[0]) as any
    second.benefitCode = 'HARDWARE_N62_SECOND'
    second.benefitStartsAt = '2026-08-15T06:00:00.000Z'
    second.benefitEndsAt = '2026-09-15T06:00:00.000Z'
    overlap.benefits.splice(1, 0, second)
    expectInvalid(overlap, 'HARDWARE_WINDOW_OVERLAP')

    second.benefitStartsAt = overlap.benefits[0].benefitEndsAt
    expect(validateCommercialOfferV3(overlap)).toEqual(overlap)
  })

  it('rejects adjacent benefits for one SKU when their frozen SKU snapshot bytes differ', () => {
    const value = clone(fixture)
    const second = clone(value.benefits[0]) as any
    second.benefitCode = 'HARDWARE_N62_SECOND'
    second.benefitStartsAt = value.benefits[0].benefitEndsAt
    second.benefitEndsAt = '2026-10-01T06:00:00.000Z'
    second.skuSnapshot.brand = 'NEXGO-MUTATED'
    value.benefits.splice(1, 0, second)

    expectInvalid(value, 'HARDWARE_SKU_SNAPSHOT_MISMATCH')
  })

  it('rejects a hardware fixed price above the frozen list price', () => {
    const value = clone(fixture)
    const fixed = value.benefits.find(benefit => benefit.kind === 'HARDWARE_FIXED_PRICE')!
    ;(fixed as any).unitAmountMinor = (BigInt((fixed as any).skuSnapshot.listUnitAmountMinor) + 1n).toString()

    expectInvalid(value, 'HARDWARE_FIXED_PRICE_ABOVE_LIST')
  })

  it('rejects rule and stacking-group code collisions across SaaS benefits', () => {
    const duplicateRule = clone(fixture)
    const firstSaas = duplicateRule.benefits.find(benefit => benefit.kind === 'SAAS_PRICE') as any
    duplicateRule.benefits.push({ ...clone(firstSaas), benefitCode: 'ZZ_SAAS_DUPLICATE' })
    expectInvalid(duplicateRule, 'SAAS_RULE_CODE_UNIQUE')

    const duplicateGroup = clone(fixture)
    const saas = duplicateGroup.benefits.find(benefit => benefit.kind === 'SAAS_PRICE') as any
    const secondRule = {
      ...clone(saas.rules[0]),
      code: 'POS_TEN_PERCENT',
      type: 'PERCENT_OFF',
      priority: 10,
      percentBasisPoints: 1000,
    }
    delete secondRule.amount
    saas.rules.push(secondRule)
    saas.rules.sort((left: any, right: any) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))
    saas.stackingGroups = [
      {
        code: 'SHARED_STACK',
        steps: [
          { position: 1, ruleCode: 'POS_FIXED_50' },
          { position: 2, ruleCode: 'POS_TEN_PERCENT' },
        ],
      },
    ]
    const secondSaas = clone(saas)
    secondSaas.benefitCode = 'ZZ_SAAS_SECOND'
    secondSaas.rules = secondSaas.rules.map((rule: any) => ({ ...rule, code: `SECOND_${rule.code}` }))
    secondSaas.stackingGroups[0].steps = secondSaas.stackingGroups[0].steps.map((step: any) => ({
      ...step,
      ruleCode: `SECOND_${step.ruleCode}`,
    }))
    duplicateGroup.benefits.push(secondSaas)

    expectInvalid(duplicateGroup, 'SAAS_STACKING_GROUP_CODE_UNIQUE')
  })

  it.each(['payments-rate-schedule', 'starter', 'rate-v1'])('rejects a mutable or ambiguous rate schedule reference %s', reference => {
    const value = clone(fixture)
    ;(value.benefits[2] as any).paymentsRateScheduleVersionId = reference
    expectInvalid(value, 'RATE_SCHEDULE_VERSION_REFERENCE')
  })

  it('classifies an invalid rate reference by its field path instead of a fixture-specific benefit index', () => {
    const value = clone(fixture)
    const rate = value.benefits.find(benefit => benefit.kind === 'PAYMENTS_RATE_SCHEDULE')!
    rate.benefitCode = 'A_PAYMENTS_RATE'
    ;(rate as any).paymentsRateScheduleVersionId = 'mutable-rate'
    value.benefits.sort((left, right) => (left.benefitCode < right.benefitCode ? -1 : left.benefitCode > right.benefitCode ? 1 : 0))
    expectInvalid(value, 'RATE_SCHEDULE_VERSION_REFERENCE')
  })

  it('rejects checksum, row identity and unsupported persisted schema mismatches', () => {
    const emitted = emitCommercialOfferV3(fixture)
    const base = {
      rowSchemaVersion: 3,
      snapshot: emitted.snapshot,
      checksum: emitted.checksum,
      rowContext: {
        id: fixture.campaignVersionId,
        campaignCode: fixture.campaignCode,
        sourceRevision: fixture.version,
        schemaVersion: 3,
        publishedAt: new Date(fixture.publishedAt),
      },
    }

    expect(() => decodeAndVerifyStoredCommercialOfferV3({ ...base, checksum: '0'.repeat(64) })).toThrow()
    expect(() => decodeAndVerifyStoredCommercialOfferV3({ ...base, rowContext: { ...base.rowContext, id: 'different-version' } })).toThrow()
    expect(() => decodeAndVerifyStoredCommercialOfferV3({ ...base, rowSchemaVersion: 4 })).toThrow()
  })
})
