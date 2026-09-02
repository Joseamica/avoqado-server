import fixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import resolutionFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-resolution-v2.json'
import {
  CommercialOfferResolutionError,
  resolveCommercialOfferV3,
  validateCommercialOfferResolutionV2,
} from '@/services/commercial/offers/commercialOfferStacking.service'
import { validateCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'

const offer = validateCommercialOfferV3(fixture)
const resolvedAt = '2026-08-15T12:00:00.000Z'

function resolve(overrides: Record<string, unknown> = {}) {
  return resolveCommercialOfferV3({
    offer,
    resolvedAt,
    saasMatches: [{ lineKey: 'line-pos', ruleCodes: ['POS_FIXED_50'] }],
    hardwareSelections: [
      { catalogKey: 'NEXGO_N62', quantity: 1 },
      { catalogKey: 'PAX_A910S', quantity: 1 },
    ],
    rateBlockers: [],
    ...overrides,
  })
}

describe('Commercial Offer v3 deterministic stacking', () => {
  it('accounts for a partial hardware benefit with explicit applied and excluded quantities', () => {
    const result = resolve(resolutionFixture.input)

    expect(result).toEqual(resolutionFixture.expected)
    expect(result.resolutionVersion).toBe(2)
    expect(result.applied).toContainEqual({
      subjectKind: 'HARDWARE_SKU',
      subjectKey: 'NEXGO_N62',
      benefitCode: 'HARDWARE_N62_FIXED',
      appliedQuantity: 2,
    })
    expect(result.exclusions).toContainEqual({
      subjectKind: 'HARDWARE_SKU',
      subjectKey: 'NEXGO_N62',
      benefitCode: 'HARDWARE_N62_FIXED',
      excludedQuantity: 3,
      accountingEffect: 'LIST_PRICE_EXCESS',
      reasonCode: 'HARDWARE_QUANTITY_EXCEEDED',
    })
    expect(result.applied.some(item => 'quantity' in item)).toBe(false)
    expect(result.exclusions.some(item => 'quantity' in item)).toBe(false)
  })

  it('keeps partial applied/excluded entries stable under real input permutations', () => {
    const first = resolve({
      saasMatches: [],
      hardwareSelections: [
        { catalogKey: 'NEXGO_N62', quantity: 5 },
        { catalogKey: 'PAX_A910S', quantity: 2 },
      ],
    })
    const second = resolve({
      saasMatches: [],
      hardwareSelections: [
        { catalogKey: 'PAX_A910S', quantity: 2 },
        { catalogKey: 'NEXGO_N62', quantity: 5 },
      ],
    })

    expect(second).toEqual(first)
    expect(first.applied.filter(item => item.subjectKind === 'HARDWARE_SKU')).toHaveLength(2)
    expect(first.exclusions.filter(item => item.reasonCode === 'HARDWARE_QUANTITY_EXCEEDED')).toHaveLength(2)
  })

  it('applies one SaaS rule and each eligible hardware benefit, and excludes the unavailable rate authority', () => {
    expect(resolve()).toEqual({
      schemaVersion: 3,
      resolutionVersion: 2,
      campaignVersionId: offer.campaignVersionId,
      resolvedAt,
      applied: [
        {
          subjectKind: 'HARDWARE_SKU',
          subjectKey: 'NEXGO_N62',
          benefitCode: 'HARDWARE_N62_FIXED',
          appliedQuantity: 1,
        },
        {
          subjectKind: 'HARDWARE_SKU',
          subjectKey: 'PAX_A910S',
          benefitCode: 'HARDWARE_PAX_10_OFF',
          appliedQuantity: 1,
        },
        {
          subjectKind: 'SAAS_LINE',
          subjectKey: 'line-pos',
          benefitCode: 'SAAS_POS_50',
          ruleCode: 'POS_FIXED_50',
        },
      ],
      exclusions: [
        {
          subjectKind: 'PAYMENTS_RATE',
          subjectKey: 'payments-rate-schedule-version-starter-2026-v1',
          benefitCode: 'PAYMENTS_STARTER_RATE',
          accountingEffect: 'EXPLANATORY',
          reasonCode: 'RATE_SCHEDULE_AUTHORITY_UNAVAILABLE',
        },
      ],
    })
    expect(Object.isFrozen(resolve())).toBe(true)
    expect(Object.isFrozen(resolve().applied)).toBe(true)
  })

  it('chooses the highest-priority SaaS rule and records every lower candidate', () => {
    const value = JSON.parse(JSON.stringify(fixture))
    const saas = value.benefits.find((benefit: any) => benefit.kind === 'SAAS_PRICE')
    saas.rules.push({
      ...JSON.parse(JSON.stringify(saas.rules[0])),
      code: 'POS_TEN_PERCENT',
      type: 'PERCENT_OFF',
      priority: 10,
      percentBasisPoints: 1000,
    })
    delete saas.rules[1].amount
    saas.rules.sort((left: any, right: any) => left.code.localeCompare(right.code))
    const competingOffer = validateCommercialOfferV3(value)

    const result = resolve({
      offer: competingOffer,
      saasMatches: [{ lineKey: 'line-pos', ruleCodes: ['POS_TEN_PERCENT', 'POS_FIXED_50'] }],
      hardwareSelections: [],
    })

    expect(result.applied).toEqual([
      {
        subjectKind: 'SAAS_LINE',
        subjectKey: 'line-pos',
        benefitCode: 'SAAS_POS_50',
        ruleCode: 'POS_FIXED_50',
      },
    ])
    expect(result.exclusions).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleCode: 'POS_TEN_PERCENT', reasonCode: 'LOWER_PRIORITY_SAAS_RULE' })]),
    )
  })

  it('fails closed when multiple unstacked SaaS rules tie for the highest priority', () => {
    const value = JSON.parse(JSON.stringify(fixture))
    const saas = value.benefits.find((benefit: any) => benefit.kind === 'SAAS_PRICE')
    saas.rules.push({
      ...JSON.parse(JSON.stringify(saas.rules[0])),
      code: 'ZZ_SAME_TOP_PRIORITY',
    })
    saas.rules.sort((left: any, right: any) => left.code.localeCompare(right.code))
    const ambiguousOffer = validateCommercialOfferV3(value)

    expect(() =>
      resolve({
        offer: ambiguousOffer,
        saasMatches: [{ lineKey: 'line-pos', ruleCodes: ['ZZ_SAME_TOP_PRIORITY', 'POS_FIXED_50'] }],
        hardwareSelections: [],
      }),
    ).toThrow(expect.objectContaining({ rule: 'SAAS_PRIORITY_TIE' }) as CommercialOfferResolutionError)
  })

  it('applies an explicitly published SaaS v2 stacking group in its published order', () => {
    const value = JSON.parse(JSON.stringify(fixture))
    const saas = value.benefits.find((benefit: any) => benefit.kind === 'SAAS_PRICE')
    saas.rules[0].code = 'ZZ_FIXED_PRICE'
    saas.rules.push({
      ...JSON.parse(JSON.stringify(saas.rules[0])),
      code: 'AA_PERCENT_OFF',
      type: 'PERCENT_OFF',
      priority: 10,
      percentBasisPoints: 1000,
    })
    delete saas.rules[1].amount
    saas.rules.sort((left: any, right: any) => left.code.localeCompare(right.code))
    saas.stackingGroups = [
      {
        code: 'POS_INTRO_STACK',
        steps: [
          { position: 1, ruleCode: 'ZZ_FIXED_PRICE' },
          { position: 2, ruleCode: 'AA_PERCENT_OFF' },
        ],
      },
    ]
    const stackedOffer = validateCommercialOfferV3(value)

    const result = resolve({
      offer: stackedOffer,
      saasMatches: [{ lineKey: 'line-pos', ruleCodes: ['AA_PERCENT_OFF', 'ZZ_FIXED_PRICE'] }],
      hardwareSelections: [],
    })

    expect(result.applied.filter(item => item.subjectKind === 'SAAS_LINE').map(item => item.ruleCode)).toEqual([
      'ZZ_FIXED_PRICE',
      'AA_PERCENT_OFF',
    ])
  })

  it('fails closed instead of degrading a published stacking group matched with extra rules', () => {
    const value = JSON.parse(JSON.stringify(fixture))
    const saas = value.benefits.find((benefit: any) => benefit.kind === 'SAAS_PRICE')
    saas.rules[0].code = 'ZZ_FIXED_PRICE'
    for (const [code, priority] of [
      ['AA_PERCENT_OFF', 10],
      ['MM_EXTRA_RULE', 5],
    ] as const) {
      saas.rules.push({
        ...JSON.parse(JSON.stringify(saas.rules[0])),
        code,
        type: 'PERCENT_OFF',
        priority,
        percentBasisPoints: 1000,
      })
      delete saas.rules.at(-1).amount
    }
    saas.rules.sort((left: any, right: any) => left.code.localeCompare(right.code))
    saas.stackingGroups = [
      {
        code: 'POS_INTRO_STACK',
        steps: [
          { position: 1, ruleCode: 'ZZ_FIXED_PRICE' },
          { position: 2, ruleCode: 'AA_PERCENT_OFF' },
        ],
      },
    ]
    const ambiguousOffer = validateCommercialOfferV3(value)

    expect(() =>
      resolve({
        offer: ambiguousOffer,
        saasMatches: [{ lineKey: 'line-pos', ruleCodes: ['MM_EXTRA_RULE', 'AA_PERCENT_OFF', 'ZZ_FIXED_PRICE'] }],
        hardwareSelections: [],
      }),
    ).toThrow(expect.objectContaining({ rule: 'SAAS_STACKING_MATCH_AMBIGUOUS' }) as CommercialOfferResolutionError)
  })

  it('fails closed when a published stack is matched with an extra rule from another benefit', () => {
    const value = JSON.parse(JSON.stringify(fixture))
    const firstSaas = value.benefits.find((benefit: any) => benefit.kind === 'SAAS_PRICE')
    firstSaas.rules[0].code = 'ZZ_FIXED_PRICE'
    firstSaas.rules.push({
      ...JSON.parse(JSON.stringify(firstSaas.rules[0])),
      code: 'AA_PERCENT_OFF',
      type: 'PERCENT_OFF',
      priority: 10,
      percentBasisPoints: 1000,
    })
    delete firstSaas.rules[1].amount
    firstSaas.rules.sort((left: any, right: any) => left.code.localeCompare(right.code))
    firstSaas.stackingGroups = [
      {
        code: 'POS_INTRO_STACK',
        steps: [
          { position: 1, ruleCode: 'ZZ_FIXED_PRICE' },
          { position: 2, ruleCode: 'AA_PERCENT_OFF' },
        ],
      },
    ]
    const secondSaas = JSON.parse(JSON.stringify(firstSaas))
    secondSaas.benefitCode = 'ZZ_SECOND_SAAS'
    secondSaas.stackingGroups = []
    secondSaas.rules = [{ ...JSON.parse(JSON.stringify(firstSaas.rules[0])), code: 'MM_OTHER_BENEFIT', priority: 5 }]
    value.benefits.push(secondSaas)
    value.benefits.sort((left: any, right: any) => left.benefitCode.localeCompare(right.benefitCode))
    const ambiguousOffer = validateCommercialOfferV3(value)

    expect(() =>
      resolve({
        offer: ambiguousOffer,
        saasMatches: [{ lineKey: 'line-pos', ruleCodes: ['MM_OTHER_BENEFIT', 'AA_PERCENT_OFF', 'ZZ_FIXED_PRICE'] }],
        hardwareSelections: [],
      }),
    ).toThrow(expect.objectContaining({ rule: 'SAAS_STACKING_MATCH_AMBIGUOUS' }) as CommercialOfferResolutionError)
  })

  it('fails closed when multiple published stacking groups match the same rule set', () => {
    const value = JSON.parse(JSON.stringify(fixture))
    const saas = value.benefits.find((benefit: any) => benefit.kind === 'SAAS_PRICE')
    saas.rules[0].code = 'ZZ_FIXED_PRICE'
    saas.rules.push({
      ...JSON.parse(JSON.stringify(saas.rules[0])),
      code: 'AA_PERCENT_OFF',
      type: 'PERCENT_OFF',
      priority: 10,
      percentBasisPoints: 1000,
    })
    delete saas.rules[1].amount
    saas.rules.sort((left: any, right: any) => left.code.localeCompare(right.code))
    saas.stackingGroups = ['AA_STACK', 'ZZ_STACK'].map(code => ({
      code,
      steps: [
        { position: 1, ruleCode: 'ZZ_FIXED_PRICE' },
        { position: 2, ruleCode: 'AA_PERCENT_OFF' },
      ],
    }))
    const ambiguousOffer = validateCommercialOfferV3(value)

    expect(() =>
      resolve({
        offer: ambiguousOffer,
        saasMatches: [{ lineKey: 'line-pos', ruleCodes: ['AA_PERCENT_OFF', 'ZZ_FIXED_PRICE'] }],
        hardwareSelections: [],
      }),
    ).toThrow(expect.objectContaining({ rule: 'SAAS_STACKING_MATCH_AMBIGUOUS' }) as CommercialOfferResolutionError)
  })

  it('is invariant to real candidate and line insertion permutations', () => {
    const value = JSON.parse(JSON.stringify(fixture))
    const saas = value.benefits.find((benefit: any) => benefit.kind === 'SAAS_PRICE')
    saas.rules.push({
      ...JSON.parse(JSON.stringify(saas.rules[0])),
      code: 'POS_TEN_PERCENT',
      type: 'PERCENT_OFF',
      priority: 10,
      percentBasisPoints: 1000,
    })
    delete saas.rules[1].amount
    saas.rules.sort((left: any, right: any) => left.code.localeCompare(right.code))
    const competingOffer = validateCommercialOfferV3(value)
    const first = resolve({
      offer: competingOffer,
      saasMatches: [
        { lineKey: 'line-z', ruleCodes: ['POS_FIXED_50', 'POS_TEN_PERCENT'] },
        { lineKey: 'line-a', ruleCodes: ['POS_TEN_PERCENT', 'POS_FIXED_50'] },
      ],
    })
    const second = resolve({
      offer: competingOffer,
      saasMatches: [
        { lineKey: 'line-a', ruleCodes: ['POS_FIXED_50', 'POS_TEN_PERCENT'] },
        { lineKey: 'line-z', ruleCodes: ['POS_TEN_PERCENT', 'POS_FIXED_50'] },
      ],
      hardwareSelections: [
        { catalogKey: 'PAX_A910S', quantity: 1 },
        { catalogKey: 'NEXGO_N62', quantity: 1 },
      ],
    })

    expect(second).toEqual(first)
  })

  it('accounts adjacent same-SKU windows per benefit and exposes list-price excess only for the active benefit', () => {
    const value = JSON.parse(JSON.stringify(fixture))
    const firstWindow = value.benefits.find((benefit: any) => benefit.benefitCode === 'HARDWARE_N62_FIXED')
    const secondWindow = JSON.parse(JSON.stringify(firstWindow))
    secondWindow.benefitCode = 'HARDWARE_N62_SECOND'
    secondWindow.benefitStartsAt = firstWindow.benefitEndsAt
    secondWindow.benefitEndsAt = '2026-10-01T06:00:00.000Z'
    value.claimEndsAt = secondWindow.benefitEndsAt
    value.benefits.push(secondWindow)
    value.benefits.sort((left: any, right: any) => left.benefitCode.localeCompare(right.benefitCode))
    const adjacentOffer = validateCommercialOfferV3(value)

    const result = resolve({
      offer: adjacentOffer,
      saasMatches: [],
      hardwareSelections: [{ catalogKey: 'NEXGO_N62', quantity: 5 }],
    })
    const applied = result.applied.find(item => item.benefitCode === 'HARDWARE_N62_FIXED')
    const excess = result.exclusions.find(
      item => item.benefitCode === applied?.benefitCode && item.reasonCode === 'HARDWARE_QUANTITY_EXCEEDED',
    )
    const inactive = result.exclusions.find(item => item.benefitCode === 'HARDWARE_N62_SECOND')

    expect(applied).toMatchObject({ appliedQuantity: 2 })
    expect(excess).toMatchObject({ excludedQuantity: 3, accountingEffect: 'LIST_PRICE_EXCESS' })
    expect(inactive).toMatchObject({
      accountingEffect: 'EXPLANATORY',
      reasonCode: 'HARDWARE_WINDOW_INACTIVE',
    })
    expect(inactive).not.toHaveProperty('excludedQuantity')

    const boundary = resolve({
      offer: adjacentOffer,
      resolvedAt: firstWindow.benefitEndsAt,
      saasMatches: [],
      hardwareSelections: [{ catalogKey: 'NEXGO_N62', quantity: 1 }],
    })
    expect(boundary.applied.filter(item => item.subjectKind === 'HARDWARE_SKU')).toEqual([
      expect.objectContaining({ benefitCode: 'HARDWARE_N62_SECOND', appliedQuantity: 1 }),
    ])
    expect(boundary.exclusions).toContainEqual(
      expect.objectContaining({
        benefitCode: 'HARDWARE_N62_FIXED',
        accountingEffect: 'EXPLANATORY',
        reasonCode: 'HARDWARE_WINDOW_INACTIVE',
      }),
    )
  })

  it('totally orders tied SaaS exclusions by rule code', () => {
    const value = JSON.parse(JSON.stringify(fixture))
    const saas = value.benefits.find((benefit: any) => benefit.kind === 'SAAS_PRICE')
    for (const code of ['ZZ_SAME_PRIORITY', 'MM_SAME_PRIORITY']) {
      saas.rules.push({ ...JSON.parse(JSON.stringify(saas.rules[0])), code, priority: 50 })
    }
    saas.rules.sort((left: any, right: any) => left.code.localeCompare(right.code))
    const tiedOffer = validateCommercialOfferV3(value)

    const result = resolve({
      offer: tiedOffer,
      saasMatches: [
        {
          lineKey: 'line-pos',
          ruleCodes: ['ZZ_SAME_PRIORITY', 'POS_FIXED_50', 'MM_SAME_PRIORITY'],
        },
      ],
      hardwareSelections: [],
    })

    expect(result.exclusions.filter(item => item.subjectKind === 'SAAS_LINE').map(item => item.ruleCode)).toEqual([
      'MM_SAME_PRIORITY',
      'ZZ_SAME_PRIORITY',
    ])
  })

  it('marks candidates from distinct SaaS benefits as non-stackable regardless of priority', () => {
    const value = JSON.parse(JSON.stringify(fixture))
    const firstSaas = value.benefits.find((benefit: any) => benefit.kind === 'SAAS_PRICE')
    const secondSaas = JSON.parse(JSON.stringify(firstSaas))
    secondSaas.benefitCode = 'ZZ_SAAS_SECOND'
    secondSaas.rules[0].code = 'POS_SECOND_PRICE'
    secondSaas.rules[0].priority = 200
    value.benefits.push(secondSaas)
    const multiBenefitOffer = validateCommercialOfferV3(value)

    const result = resolve({
      offer: multiBenefitOffer,
      saasMatches: [{ lineKey: 'line-pos', ruleCodes: ['POS_FIXED_50', 'POS_SECOND_PRICE'] }],
      hardwareSelections: [],
    })

    expect(result.applied).toEqual([
      {
        subjectKind: 'SAAS_LINE',
        subjectKey: 'line-pos',
        benefitCode: 'ZZ_SAAS_SECOND',
        ruleCode: 'POS_SECOND_PRICE',
      },
    ])
    expect(result.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          benefitCode: 'SAAS_POS_50',
          ruleCode: 'POS_FIXED_50',
          reasonCode: 'SAAS_STACKING_NOT_ALLOWED',
        }),
      ]),
    )
  })

  it.each([
    ['missing selection', [], 'HARDWARE_SKU_NOT_SELECTED'],
    ['quantity overflow', [{ catalogKey: 'NEXGO_N62', quantity: 3 }], 'HARDWARE_QUANTITY_EXCEEDED'],
  ])('records hardware exclusion for %s', (_label, hardwareSelections, reasonCode) => {
    const result = resolve({
      hardwareSelections,
      saasMatches: [],
    })
    expect(result.exclusions).toEqual(expect.arrayContaining([expect.objectContaining({ benefitCode: 'HARDWARE_N62_FIXED', reasonCode })]))
  })

  it('records an inactive hardware window while the Offer claim window is still active', () => {
    const value = JSON.parse(JSON.stringify(fixture))
    const hardware = value.benefits.find((benefit: any) => benefit.benefitCode === 'HARDWARE_N62_FIXED')
    hardware.benefitStartsAt = '2026-08-20T06:00:00.000Z'
    const offerWithLaterHardware = validateCommercialOfferV3(value)

    const result = resolve({
      offer: offerWithLaterHardware,
      hardwareSelections: [{ catalogKey: 'NEXGO_N62', quantity: 1 }],
      saasMatches: [],
    })

    expect(result.exclusions).toContainEqual(
      expect.objectContaining({ benefitCode: 'HARDWARE_N62_FIXED', reasonCode: 'HARDWARE_WINDOW_INACTIVE' }),
    )
  })

  it.each([
    ['NEGOTIATED_RATE', 'NEGOTIATED_RATE_PRESENT'],
    ['ENTERPRISE_RATE', 'ENTERPRISE_RATE_PRESENT'],
    ['PRIOR_PROMOTION', 'PRIOR_PROMOTION_PRESENT'],
    ['CHANNEL_AGREEMENT', 'CHANNEL_AGREEMENT_PRESENT'],
  ])('records the strongest explicit rate blocker %s', (blocker, reasonCode) => {
    const result = resolve({ rateBlockers: [blocker] })
    expect(result.exclusions).toEqual(
      expect.arrayContaining([expect.objectContaining({ benefitCode: 'PAYMENTS_STARTER_RATE', reasonCode })]),
    )
  })

  it('uses the documented strongest rate blocker when multiple blockers are present', () => {
    const result = resolve({ rateBlockers: ['CHANNEL_AGREEMENT', 'PRIOR_PROMOTION', 'NEGOTIATED_RATE'] })

    expect(result.exclusions).toContainEqual(
      expect.objectContaining({ benefitCode: 'PAYMENTS_STARTER_RATE', reasonCode: 'NEGOTIATED_RATE_PRESENT' }),
    )
  })

  it('is invariant to hardware selection permutations', () => {
    const first = resolve()
    const second = resolve({
      hardwareSelections: [
        { catalogKey: 'PAX_A910S', quantity: 1 },
        { catalogKey: 'NEXGO_N62', quantity: 1 },
      ],
    })
    expect(second).toEqual(first)
  })

  it('fails closed when resolvedAt is outside the Offer claim window', () => {
    expect(() =>
      resolve({
        resolvedAt: '2026-10-01T12:00:00.000Z',
        hardwareSelections: [],
      }),
    ).toThrow(expect.objectContaining({ rule: 'OFFER_CLAIM_WINDOW' }) as CommercialOfferResolutionError)
  })

  it('rejects an inactive Offer instead of applying its benefits', () => {
    const value = JSON.parse(JSON.stringify(fixture))
    value.status = 'INACTIVE'
    const inactiveOffer = validateCommercialOfferV3(value)

    expect(() => resolve({ offer: inactiveOffer })).toThrow(
      expect.objectContaining({ rule: 'OFFER_INACTIVE' }) as CommercialOfferResolutionError,
    )
  })

  it('never emits an applied payments-rate entry in resolver revision 2', () => {
    expect(resolve().applied).not.toContainEqual(expect.objectContaining({ subjectKind: 'PAYMENTS_RATE' }))
  })

  it('marks every non-billable exclusion as explanatory', () => {
    const result = resolve({
      saasMatches: [
        {
          lineKey: 'line-pos',
          ruleCodes: ['POS_FIXED_50'],
        },
      ],
      hardwareSelections: [],
    })

    expect(result.exclusions.filter(item => item.reasonCode !== 'HARDWARE_QUANTITY_EXCEEDED')).toEqual(
      expect.arrayContaining([expect.objectContaining({ accountingEffect: 'EXPLANATORY' })]),
    )
    expect(result.exclusions.every(item => 'accountingEffect' in item)).toBe(true)
  })

  it.each([1, 2, 3, 5, 1000])('partitions active hardware quantity %i exactly once', quantity => {
    const result = resolve({
      saasMatches: [],
      hardwareSelections: [{ catalogKey: 'NEXGO_N62', quantity }],
    })
    const applied = result.applied.find(item => item.subjectKind === 'HARDWARE_SKU' && item.benefitCode === 'HARDWARE_N62_FIXED')
    if (applied?.subjectKind !== 'HARDWARE_SKU') throw new Error('EXPECTED_APPLIED_HARDWARE')
    const appliedQuantity = applied.appliedQuantity
    const excludedQuantity = result.exclusions.find(
      item => item.reasonCode === 'HARDWARE_QUANTITY_EXCEEDED' && item.benefitCode === 'HARDWARE_N62_FIXED',
    )

    expect(appliedQuantity).toBe(Math.min(quantity, 2))
    expect((excludedQuantity && 'excludedQuantity' in excludedQuantity ? excludedQuantity.excludedQuantity : 0) + appliedQuantity).toBe(
      quantity,
    )
  })

  it('exposes typed diagnostics when the runtime resolution schema rejects output', () => {
    expect(() => validateCommercialOfferResolutionV2({ schemaVersion: 3 })).toThrow(
      expect.objectContaining({
        name: 'CommercialOfferResolutionError',
        code: 'COMMERCIAL_OFFER_RESOLUTION_INVALID',
        rule: 'RESOLUTION_SCHEMA',
        diagnostics: expect.any(Array),
      }) as CommercialOfferResolutionError,
    )
  })

  it('rejects malformed time, quantity, duplicate selections and unknown candidate rules', () => {
    expect(() => resolve({ resolvedAt: 'not-a-time' })).toThrow('COMMERCIAL_OFFER_RESOLUTION_INVALID')
    expect(() => resolve({ resolvedAt: Symbol('not-a-time') })).toThrow('COMMERCIAL_OFFER_RESOLUTION_INVALID')
    expect(() => resolve({ hardwareSelections: [{ catalogKey: 'NEXGO_N62', quantity: 0 }] })).toThrow('COMMERCIAL_OFFER_RESOLUTION_INVALID')
    expect(() =>
      resolve({
        hardwareSelections: [
          { catalogKey: 'NEXGO_N62', quantity: 1 },
          { catalogKey: 'NEXGO_N62', quantity: 1 },
        ],
      }),
    ).toThrow('COMMERCIAL_OFFER_RESOLUTION_INVALID')
    expect(() => resolve({ saasMatches: [{ lineKey: 'line-pos', ruleCodes: ['UNKNOWN_RULE'] }] })).toThrow(
      'COMMERCIAL_OFFER_RESOLUTION_INVALID',
    )
    expect(() => resolve({ saasMatches: [{ lineKey: 'line-pos', ruleCodes: 'ABC' }] })).toThrow('COMMERCIAL_OFFER_RESOLUTION_INVALID')
    expect(() => resolve({ saasMatches: [null] })).toThrow('COMMERCIAL_OFFER_RESOLUTION_INVALID')
    expect(() =>
      resolve({
        saasMatches: [
          { lineKey: 'line-pos', ruleCodes: ['POS_FIXED_50'] },
          { lineKey: 'line-pos', ruleCodes: ['POS_FIXED_50'] },
        ],
      }),
    ).toThrow('COMMERCIAL_OFFER_RESOLUTION_INVALID')
    expect(() => resolve({ hardwareSelections: [null] })).toThrow('COMMERCIAL_OFFER_RESOLUTION_INVALID')
    expect(() => resolve({ hardwareSelections: [{ catalogKey: 'UNKNOWN_SKU', quantity: 1 }] })).toThrow(
      expect.objectContaining({ rule: 'HARDWARE_SKU_NOT_IN_OFFER' }) as CommercialOfferResolutionError,
    )
    expect(() => resolve({ rateBlockers: [null] })).toThrow('COMMERCIAL_OFFER_RESOLUTION_INVALID')
    expect(() =>
      resolve({
        saasMatches: Array.from({ length: 51 }, (_, index) => ({
          lineKey: `line-${index}`,
          ruleCodes: ['POS_FIXED_50'],
        })),
      }),
    ).toThrow(expect.objectContaining({ rule: 'INPUT' }) as CommercialOfferResolutionError)
    expect(() =>
      resolve({
        saasMatches: [
          {
            lineKey: 'line-pos',
            ruleCodes: Array.from({ length: 101 }, (_, index) => `RULE_${index}`),
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ rule: 'INPUT' }) as CommercialOfferResolutionError)
    expect(() =>
      resolve({
        hardwareSelections: Array.from({ length: 51 }, (_, index) => ({
          catalogKey: `SKU_${index}`,
          quantity: 1,
        })),
      }),
    ).toThrow(expect.objectContaining({ rule: 'INPUT' }) as CommercialOfferResolutionError)
  })
})
