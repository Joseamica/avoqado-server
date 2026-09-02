import campaignFixture from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import quoteAcquisitionFixture from '@/contracts/commercial/fixtures/v2/quote-pos-50-acquisition.json'
import quoteVenueFixture from '@/contracts/commercial/fixtures/v2/quote-pos-50-venue.json'
import { validateCommercialCampaignV2 } from '@/services/commercial/commercialContractV2.service'
import {
  cloneJson as clone,
  expectTrustedSnapshot,
  productGrant,
  productLine,
  reconcileQuoteTotals,
  setCurrentSubtotal,
  validateCommercialQuoteV2,
  validateQuoteAgainst,
  validationRule,
} from './commercialContractV2.testSupport'

describe('commercial campaign contract v2', () => {
  it('validates the versioned POS $50 campaign without changing the base catalog', () => {
    expectTrustedSnapshot(validateCommercialCampaignV2(campaignFixture), campaignFixture)
    expect(campaignFixture.rules).toEqual([
      expect.objectContaining({ code: 'POS_FIXED_50', type: 'FIXED_PRICE', amount: '50.00', cycles: 3 }),
    ])
    expect(campaignFixture.stackingGroups).toEqual([])
  })

  it.each([
    ['FIXED_PRICE', { amount: '50.00' }],
    ['BUNDLE_PRICE', { amount: '50.00' }],
    ['AMOUNT_OFF', { amount: '10.00' }],
    ['PERCENT_OFF', { percentBasisPoints: 1000 }],
    ['FREE_PERIOD', {}],
  ])('accepts the legal %s discriminator fields', (type, fields) => {
    const value = clone(campaignFixture) as any
    value.rules[0] = { ...value.rules[0], type, ...fields }
    delete value.rules[0].amount
    delete value.rules[0].percentBasisPoints
    Object.assign(value.rules[0], fields)
    expectTrustedSnapshot(validateCommercialCampaignV2(value), value)
  })

  it.each([
    ['fixed without amount', 'FIXED_PRICE', {}],
    ['fixed with percent', 'FIXED_PRICE', { amount: '50.00', percentBasisPoints: 100 }],
    ['bundle without amount', 'BUNDLE_PRICE', {}],
    ['bundle with percent', 'BUNDLE_PRICE', { amount: '50.00', percentBasisPoints: 100 }],
    ['amount-off without amount', 'AMOUNT_OFF', {}],
    ['amount-off with percent', 'AMOUNT_OFF', { amount: '10.00', percentBasisPoints: 100 }],
    ['percent without basis points', 'PERCENT_OFF', {}],
    ['percent with amount', 'PERCENT_OFF', { amount: '1.00', percentBasisPoints: 100 }],
    ['free with amount', 'FREE_PERIOD', { amount: '0.00' }],
  ])('rejects %s', (_label, type, fields) => {
    const value = clone(campaignFixture) as any
    value.rules[0] = { ...value.rules[0], type }
    delete value.rules[0].amount
    delete value.rules[0].percentBasisPoints
    Object.assign(value.rules[0], fields)
    expect(validationRule(() => validateCommercialCampaignV2(value))).toBe('SCHEMA')
  })

  it.each([
    ['legacy money', (value: any) => (value.rules[0].amountMinor = 5000), 'SCHEMA'],
    ['numeric money', (value: any) => (value.rules[0].amount = 50), 'SCHEMA'],
    ['rule order', (value: any) => value.rules.push({ ...clone(value.rules[0]), code: 'AAA_RULE' }), 'CAMPAIGN_RULE_ORDER'],
    ['rule duplicate', (value: any) => value.rules.push(clone(value.rules[0])), 'CAMPAIGN_RULE_UNIQUE'],
    ['target order', (value: any) => (value.rules[0].target.productCodes = ['POS', 'FREE']), 'CAMPAIGN_TARGET_ORDER'],
  ])('rejects %s', (_label, mutate, rule) => {
    const value = clone(campaignFixture) as any
    mutate(value)
    expect(validationRule(() => validateCommercialCampaignV2(value))).toBe(rule)
  })

  it('rejects duplicate and noncanonical product-kind targets', () => {
    const duplicate = clone(campaignFixture) as any
    duplicate.rules[0].target = { productKinds: ['PLAN', 'PLAN'] }
    expect(validationRule(() => validateCommercialCampaignV2(duplicate))).toBe('CAMPAIGN_TARGET_UNIQUE')

    const reordered = clone(campaignFixture) as any
    reordered.rules[0].target = { productKinds: ['MODULE', 'POS'] }
    expect(validationRule(() => validateCommercialCampaignV2(reordered))).toBe('CAMPAIGN_TARGET_ORDER')

    const duplicateProduct = clone(campaignFixture) as any
    duplicateProduct.rules[0].target.productCodes = ['POS', 'POS']
    expect(validationRule(() => validateCommercialCampaignV2(duplicateProduct))).toBe('CAMPAIGN_TARGET_UNIQUE')

    const duplicateBundle = clone(campaignFixture) as any
    duplicateBundle.rules[0].target = { bundleCodes: ['ALL_MODULES', 'ALL_MODULES'] }
    expect(validationRule(() => validateCommercialCampaignV2(duplicateBundle))).toBe('CAMPAIGN_TARGET_UNIQUE')

    const reorderedBundle = clone(campaignFixture) as any
    reorderedBundle.rules[0].target = { bundleCodes: ['ZZZ_BUNDLE', 'ALL_MODULES'] }
    expect(validationRule(() => validateCommercialCampaignV2(reorderedBundle))).toBe('CAMPAIGN_TARGET_ORDER')
  })

  it('rejects illegal stacking order, positions, references and FREE_PERIOD participation', () => {
    const base = clone(campaignFixture) as any
    base.rules = [
      { ...clone(base.rules[0]), code: 'AMOUNT_LAST', type: 'AMOUNT_OFF', amount: '1.00' },
      { ...clone(base.rules[0]), code: 'BASE_FIRST', type: 'FIXED_PRICE', amount: '50.00' },
      { ...clone(base.rules[0]), code: 'PERCENT_MIDDLE', type: 'PERCENT_OFF', percentBasisPoints: 1000 },
    ]
    delete base.rules[2].amount
    base.stackingGroups = [
      {
        code: 'POS_STACK',
        steps: [
          { position: 1, ruleCode: 'BASE_FIRST' },
          { position: 2, ruleCode: 'PERCENT_MIDDLE' },
          { position: 3, ruleCode: 'AMOUNT_LAST' },
        ],
      },
    ]
    expectTrustedSnapshot(validateCommercialCampaignV2(base), base)

    const badPosition = clone(base) as any
    badPosition.stackingGroups[0].steps[1].position = 3
    expect(validationRule(() => validateCommercialCampaignV2(badPosition))).toBe('STACKING_POSITION')

    const badReference = clone(base) as any
    badReference.stackingGroups[0].steps[1].ruleCode = 'DOES_NOT_EXIST'
    expect(validationRule(() => validateCommercialCampaignV2(badReference))).toBe('STACKING_RULE_REFERENCE')

    const duplicateRule = clone(base) as any
    duplicateRule.stackingGroups[0].steps[1].ruleCode = duplicateRule.stackingGroups[0].steps[0].ruleCode
    expect(validationRule(() => validateCommercialCampaignV2(duplicateRule))).toBe('STACKING_RULE_UNIQUE')

    const badTypeOrder = clone(base) as any
    badTypeOrder.stackingGroups[0].steps.reverse()
    badTypeOrder.stackingGroups[0].steps.forEach((step: any, index: number) => (step.position = index + 1))
    expect(validationRule(() => validateCommercialCampaignV2(badTypeOrder))).toBe('STACKING_TYPE_ORDER')

    const free = clone(base) as any
    free.rules[1].type = 'FREE_PERIOD'
    delete free.rules[1].amount
    expect(validationRule(() => validateCommercialCampaignV2(free))).toBe('STACKING_FREE_PERIOD')
  })

  it('rejects duplicate/reordered stacking groups and mutually exclusive base rules', () => {
    const value = clone(campaignFixture) as any
    value.rules = [
      { ...clone(value.rules[0]), code: 'BASE_BUNDLE', type: 'BUNDLE_PRICE' },
      { ...clone(value.rules[0]), code: 'BASE_FIXED' },
      { ...clone(value.rules[0]), code: 'PERCENT', type: 'PERCENT_OFF', percentBasisPoints: 1000 },
    ]
    delete value.rules[2].amount
    value.stackingGroups = [
      {
        code: 'A_GROUP',
        steps: [
          { position: 1, ruleCode: 'BASE_FIXED' },
          { position: 2, ruleCode: 'PERCENT' },
        ],
      },
      {
        code: 'B_GROUP',
        steps: [
          { position: 1, ruleCode: 'BASE_BUNDLE' },
          { position: 2, ruleCode: 'PERCENT' },
        ],
      },
    ]
    expectTrustedSnapshot(validateCommercialCampaignV2(value), value)

    const duplicate = clone(value) as any
    duplicate.stackingGroups[1].code = 'A_GROUP'
    expect(validationRule(() => validateCommercialCampaignV2(duplicate))).toBe('STACKING_GROUP_UNIQUE')

    const reordered = clone(value) as any
    reordered.stackingGroups.reverse()
    expect(validationRule(() => validateCommercialCampaignV2(reordered))).toBe('STACKING_GROUP_ORDER')

    const twoBases = clone(value) as any
    twoBases.stackingGroups[0].steps = [
      { position: 1, ruleCode: 'BASE_BUNDLE' },
      { position: 2, ruleCode: 'BASE_FIXED' },
    ]
    expect(validationRule(() => validateCommercialCampaignV2(twoBases))).toBe('STACKING_BASE_CONFLICT')
  })
})

describe('commercial quote contract v2', () => {
  it('validates acquisition preview and derived venue fixtures with exact POS totals', () => {
    expectTrustedSnapshot(validateCommercialQuoteV2(quoteAcquisitionFixture), quoteAcquisitionFixture)
    expectTrustedSnapshot(validateCommercialQuoteV2(quoteVenueFixture), quoteVenueFixture)
    expect(quoteAcquisitionFixture.lines[0]).toMatchObject({
      unitAmount: '249.00',
      subtotal: '50.00',
      tax: '8.00',
      total: '58.00',
      renewalSubtotal: '249.00',
      renewalTax: '39.84',
      renewalTotal: '288.84',
    })
  })

  it('accepts the direct VENUE lineage branch', () => {
    const direct = clone(quoteVenueFixture) as any
    direct.acquisitionContextId = null
    direct.derivedFromPreview = null
    expectTrustedSnapshot(validateCommercialQuoteV2(direct), direct)
  })

  it.each([
    ['acquisition with null root id', (value: any) => (value.acquisitionContextId = null)],
    ['acquisition with derived lineage', (value: any) => (value.derivedFromPreview = clone(quoteVenueFixture.derivedFromPreview))],
    ['direct venue with acquisition id', (value: any) => (value.acquisitionContextId = 'acquisition-pos-50-v2')],
    ['direct venue with derived lineage only', (value: any) => (value.derivedFromPreview = clone(quoteVenueFixture.derivedFromPreview))],
    ['derived venue with null acquisition id', (value: any) => (value.acquisitionContextId = null)],
  ])('rejects invalid lineage: %s', (_label, mutate) => {
    const source = _label.startsWith('acquisition') ? quoteAcquisitionFixture : quoteVenueFixture
    const value = clone(source) as any
    if (_label.startsWith('direct')) {
      value.acquisitionContextId = null
      value.derivedFromPreview = null
    }
    mutate(value)
    expect(validationRule(() => validateCommercialQuoteV2(value))).toBe('QUOTE_LINEAGE')
  })

  it.each([
    ['missing property', (value: any) => delete value.currency, 'SCHEMA'],
    ['extra nested property', (value: any) => (value.lines[0].totals = {}), 'SCHEMA'],
    ['wrong schema version', (value: any) => (value.schemaVersion = 3), 'SCHEMA_VERSION'],
    ['wrong contract version', (value: any) => (value.contractVersion = '2.0.0-alpha'), 'CONTRACT_VERSION'],
    ['legacy money property', (value: any) => (value.lines[0].totalMinor = 5800), 'SCHEMA'],
    ['numeric money', (value: any) => (value.lines[0].total = 58), 'SCHEMA'],
    ['malformed money', (value: any) => (value.lines[0].total = '58.0'), 'SCHEMA'],
  ])('rejects quote %s', (_label, mutate, rule) => {
    const value = clone(quoteAcquisitionFixture) as any
    mutate(value)
    expect(validationRule(() => validateCommercialQuoteV2(value))).toBe(rule)
  })

  it.each([
    ['campaign pair', (value: any) => (value.campaignCode = null), 'QUOTE_CAMPAIGN_PAIR'],
    ['step root mismatch', (value: any) => (value.lines[0].appliedCampaigns[0].campaignCode = 'OTHER'), 'QUOTE_CAMPAIGN_STEP_ROOT'],
    ['step position', (value: any) => (value.lines[0].appliedCampaigns[0].position = 2), 'QUOTE_CAMPAIGN_POSITION'],
    ['step chain', (value: any) => (value.lines[0].appliedCampaigns[0].inputAmount = '248.00'), 'QUOTE_CAMPAIGN_CHAIN'],
    ['line key', (value: any) => (value.lines[0].lineKey = 'PRODUCT:POS:OTHER'), 'QUOTE_LINE_KEY'],
    ['line subtotal', (value: any) => (value.lines[0].listSubtotal = '248.00'), 'QUOTE_LINE_ARITHMETIC'],
    ['line tax', (value: any) => (value.lines[0].tax = '8.01'), 'QUOTE_LINE_TAX'],
    ['line renewal', (value: any) => (value.lines[0].renewalTotal = '288.83'), 'QUOTE_RENEWAL_ARITHMETIC'],
    ['root totals', (value: any) => (value.totals.total = '58.01'), 'QUOTE_TOTALS'],
    ['expiration order', (value: any) => (value.expiresAt = value.quotedAt), 'QUOTE_TIMESTAMP_ORDER'],
  ])('rejects mismatched %s', (_label, mutate, rule) => {
    const value = clone(quoteAcquisitionFixture) as any
    mutate(value)
    expect(validationRule(() => validateCommercialQuoteV2(value))).toBe(rule)
  })

  it('rejects an internally balanced discount when no campaign step authorizes it', () => {
    const value = clone(quoteAcquisitionFixture) as any
    value.campaignVersionId = null
    value.campaignCode = null
    value.lines[0].appliedCampaigns = []
    value.lines[0].promotionalCycles = null
    value.entitlementGrants[0].origins = [value.entitlementGrants[0].origins[0]]
    expect(validationRule(() => validateQuoteAgainst(value, null))).toBe('QUOTE_CAMPAIGN_CALCULATION')
  })

  it('recalculates fixed and bundle prices from the published amount and quantity', () => {
    for (const type of ['FIXED_PRICE', 'BUNDLE_PRICE']) {
      const authority = clone(campaignFixture) as any
      authority.rules[0].type = type
      authority.rules[0].amount = '40.00'
      const wrongPublishedAmount = clone(quoteAcquisitionFixture) as any
      wrongPublishedAmount.lines[0].appliedCampaigns[0].type = type
      expect(validationRule(() => validateQuoteAgainst(wrongPublishedAmount, authority))).toBe('QUOTE_CAMPAIGN_CALCULATION')

      const quantity = clone(quoteAcquisitionFixture) as any
      quantity.lines[0].quantity = 2
      quantity.lines[0].listSubtotal = '498.00'
      quantity.lines[0].appliedCampaigns[0].type = type
      quantity.lines[0].appliedCampaigns[0].inputAmount = '498.00'
      quantity.lines[0].appliedCampaigns[0].discountAmount = '398.00'
      quantity.lines[0].appliedCampaigns[0].outputAmount = '100.00'
      setCurrentSubtotal(quantity.lines[0], '100.00')
      quantity.lines[0].renewalSubtotal = '498.00'
      quantity.lines[0].renewalTax = '79.68'
      quantity.lines[0].renewalTotal = '577.68'
      reconcileQuoteTotals(quantity)
      expectTrustedSnapshot(
        validateQuoteAgainst(quantity, { ...clone(campaignFixture), rules: [{ ...authority.rules[0], amount: '50.00' }] }),
        quantity,
      )
    }
  })

  it('recalculates percent, capped amount-off and free-period output from published rules', () => {
    const cases = [
      { type: 'PERCENT_OFF', fields: { percentBasisPoints: 1000 }, output: '224.10', discount: '24.90' },
      { type: 'AMOUNT_OFF', fields: { amount: '300.00' }, output: '0.00', discount: '249.00' },
      { type: 'FREE_PERIOD', fields: {}, output: '0.00', discount: '249.00' },
    ]
    for (const scenario of cases) {
      const authority = clone(campaignFixture) as any
      authority.rules[0] = { ...authority.rules[0], type: scenario.type, ...scenario.fields }
      delete authority.rules[0].amount
      delete authority.rules[0].percentBasisPoints
      Object.assign(authority.rules[0], scenario.fields)
      const value = clone(quoteAcquisitionFixture) as any
      Object.assign(value.lines[0].appliedCampaigns[0], {
        type: scenario.type,
        discountAmount: scenario.discount,
        outputAmount: scenario.output,
      })
      setCurrentSubtotal(value.lines[0], scenario.output)
      reconcileQuoteTotals(value)
      expectTrustedSnapshot(validateQuoteAgainst(value, authority), value)
    }

    const wrongPercent = clone(quoteAcquisitionFixture) as any
    const percentAuthority = clone(campaignFixture) as any
    percentAuthority.rules[0].type = 'PERCENT_OFF'
    percentAuthority.rules[0].percentBasisPoints = 1000
    delete percentAuthority.rules[0].amount
    wrongPercent.lines[0].appliedCampaigns[0].type = 'PERCENT_OFF'
    expect(validationRule(() => validateQuoteAgainst(wrongPercent, percentAuthority))).toBe('QUOTE_CAMPAIGN_CALCULATION')

    const wrongFree = clone(quoteAcquisitionFixture) as any
    const freeAuthority = clone(campaignFixture) as any
    freeAuthority.rules[0].type = 'FREE_PERIOD'
    delete freeAuthority.rules[0].amount
    wrongFree.lines[0].appliedCampaigns[0].type = 'FREE_PERIOD'
    expect(validationRule(() => validateQuoteAgainst(wrongFree, freeAuthority))).toBe('QUOTE_CAMPAIGN_CALCULATION')
  })

  it('requires a multi-step quote to match one complete published stacking group', () => {
    const authority = clone(campaignFixture) as any
    authority.rules = [
      { ...clone(authority.rules[0]), code: 'POS_AMOUNT_10', type: 'AMOUNT_OFF', amount: '10.00' },
      { ...clone(authority.rules[0]), code: 'POS_FIXED_50', type: 'FIXED_PRICE', amount: '50.00' },
    ]
    authority.stackingGroups = []
    const value = clone(quoteAcquisitionFixture) as any
    value.lines[0].appliedCampaigns.push({
      ...value.lines[0].appliedCampaigns[0],
      ruleCode: 'POS_AMOUNT_10',
      type: 'AMOUNT_OFF',
      position: 2,
      inputAmount: '50.00',
      discountAmount: '10.00',
      outputAmount: '40.00',
    })
    setCurrentSubtotal(value.lines[0], '40.00')
    reconcileQuoteTotals(value)
    expect(validationRule(() => validateQuoteAgainst(value, authority))).toBe('QUOTE_CAMPAIGN_STACK')

    authority.stackingGroups = [
      {
        code: 'POS_STACK',
        steps: [
          { position: 1, ruleCode: 'POS_FIXED_50' },
          { position: 2, ruleCode: 'POS_AMOUNT_10' },
        ],
      },
    ]
    expectTrustedSnapshot(validateQuoteAgainst(value, authority), value)

    const incomplete = clone(value) as any
    authority.rules.push({
      ...clone(authority.rules[0]),
      code: 'POS_UNUSED_PERCENT',
      type: 'PERCENT_OFF',
      percentBasisPoints: 1000,
    })
    delete authority.rules.at(-1).amount
    authority.stackingGroups[0].steps = [
      { position: 1, ruleCode: 'POS_FIXED_50' },
      { position: 2, ruleCode: 'POS_UNUSED_PERCENT' },
      { position: 3, ruleCode: 'POS_AMOUNT_10' },
    ]
    expect(validationRule(() => validateQuoteAgainst(incomplete, authority))).toBe('QUOTE_CAMPAIGN_STACK')
  })

  it('requires one non-null promotional cycle count across all quote lines', () => {
    const value = clone(quoteAcquisitionFixture) as any
    const tableLine = productLine('TABLE_SERVICE_MODULE', 'TABLE_SERVICE_MONTHLY')
    tableLine.appliedCampaigns = [
      {
        ...value.lines[0].appliedCampaigns[0],
        ruleCode: 'TABLE_FIXED_100',
        cycles: 2,
        inputAmount: '269.00',
        discountAmount: '169.00',
        outputAmount: '100.00',
      },
    ]
    tableLine.promotionalCycles = 2
    setCurrentSubtotal(tableLine, '100.00')
    value.lines.push(tableLine)
    value.entitlementGrants.push(productGrant('TABLE_SERVICE_MODULE', tableLine.lineKey, true))
    reconcileQuoteTotals(value)

    const authority = clone(campaignFixture) as any
    authority.rules.push({
      ...authority.rules[0],
      code: 'TABLE_FIXED_100',
      target: { productCodes: ['TABLE_SERVICE_MODULE'] },
      cycles: 2,
      amount: '100.00',
    })
    expect(validationRule(() => validateQuoteAgainst(value, authority))).toBe('QUOTE_CAMPAIGN_CYCLES')
  })

  it('rejects noncanonical applied campaign type order and duplicate rule codes', () => {
    const value = clone(quoteAcquisitionFixture) as any
    value.lines[0].appliedCampaigns = [
      {
        ...value.lines[0].appliedCampaigns[0],
        ruleCode: 'PERCENT_FIRST',
        type: 'PERCENT_OFF',
        position: 1,
        inputAmount: '249.00',
        discountAmount: '24.90',
        outputAmount: '224.10',
      },
      {
        ...value.lines[0].appliedCampaigns[0],
        ruleCode: 'BASE_SECOND',
        type: 'FIXED_PRICE',
        position: 2,
        inputAmount: '224.10',
        discountAmount: '174.10',
        outputAmount: '50.00',
      },
    ]
    expect(validationRule(() => validateCommercialQuoteV2(value))).toBe('QUOTE_CAMPAIGN_TYPE_ORDER')

    const duplicate = clone(value) as any
    duplicate.lines[0].appliedCampaigns[1].ruleCode = 'PERCENT_FIRST'
    expect(validationRule(() => validateCommercialQuoteV2(duplicate))).toBe('QUOTE_CAMPAIGN_RULE_UNIQUE')
  })

  it('rejects FREE_PERIOD combined with another applied rule', () => {
    const value = clone(quoteAcquisitionFixture) as any
    value.lines[0].appliedCampaigns = [
      {
        ...value.lines[0].appliedCampaigns[0],
        type: 'FIXED_PRICE',
        position: 1,
        inputAmount: '249.00',
        discountAmount: '0.00',
        outputAmount: '249.00',
      },
      {
        ...value.lines[0].appliedCampaigns[0],
        ruleCode: 'FREE_PERIOD_SECOND',
        type: 'FREE_PERIOD',
        position: 2,
        inputAmount: '249.00',
        discountAmount: '199.00',
        outputAmount: '50.00',
      },
    ]
    expect(validationRule(() => validateCommercialQuoteV2(value))).toBe('QUOTE_CAMPAIGN_FREE_PERIOD')
  })

  it('rejects duplicate/reordered lines and grants before arithmetic can hide them', () => {
    const lines = clone(quoteAcquisitionFixture) as any
    lines.lines.push(clone(lines.lines[0]))
    expect(validationRule(() => validateCommercialQuoteV2(lines))).toBe('QUOTE_LINE_UNIQUE')

    const reorderedLines = clone(quoteAcquisitionFixture) as any
    const first = reorderedLines.lines[0]
    reorderedLines.lines.push({ ...clone(first), lineKey: 'PRODUCT:AAA:AAA_MONTHLY', targetCode: 'AAA', priceCode: 'AAA_MONTHLY' })
    expect(validationRule(() => validateCommercialQuoteV2(reorderedLines))).toBe('QUOTE_LINE_ORDER')

    const grants = clone(quoteAcquisitionFixture) as any
    grants.entitlementGrants.push(clone(grants.entitlementGrants[0]))
    expect(validationRule(() => validateCommercialQuoteV2(grants))).toBe('CAPABILITY_UNIQUE')

    const reorderedGrants = clone(quoteAcquisitionFixture) as any
    reorderedGrants.entitlementGrants.push({
      capabilityCode: 'CHATBOT',
      capabilityKind: 'FEATURE',
      origins: [{ kind: 'TRIAL', sourceId: 'trial-001' }],
      activationRequirement: { mode: 'NOT_REQUIRED' },
    })
    expect(validationRule(() => validateCommercialQuoteV2(reorderedGrants))).toBe('CAPABILITY_ORDER')
  })
})
