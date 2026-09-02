import moneyLimits from '@/contracts/commercial/vectors/v2/money-limits.json'
import {
  MAX_COMMERCIAL_MONEY_MINOR,
  MAX_LINE_LIST_SUBTOTAL_MINOR,
  MAX_QUANTITY,
  MAX_QUOTE_DISCOUNT_MINOR,
  MAX_QUOTE_LINES,
  MAX_QUOTE_LIST_SUBTOTAL_MINOR,
  MAX_QUOTE_TAX_MINOR,
  MAX_QUOTE_TOTAL_MINOR,
  MAX_STRIPE_AMOUNT_MINOR,
  MAX_UNIT_AMOUNT_MINOR,
  MIN_STRIPE_NON_ZERO_AMOUNT_MINOR,
} from '@/contracts/commercial/commercialContractV2.constants'
import {
  assertCommercialMoneyLimitV2,
  formatCommercialMoneyV2,
  parseCommercialMoneyV2,
  roundCommercialBasisPointsV2,
  toStripeMinorAmountV2,
} from '@/services/commercial/commercialMoneyV2.service'

describe('commercialMoneyV2', () => {
  describe('new v2 money behavior', () => {
    it.each([
      ['0.00', 0n],
      ['0.01', 1n],
      ['249.00', 24_900n],
      [moneyLimits.genericMaximum.wire, BigInt(moneyLimits.genericMaximum.minor)],
    ])('parses canonical MXN wire money %s without Number coercion', (wire, expected) => {
      expect(parseCommercialMoneyV2(wire)).toBe(expected)
    })

    it.each(['', '0', '0.0', '.50', '1.', '01.00', '-0.00', '+1.00', ' 1.00', '1.00 ', '1,000.00', '1e2', '1.000', 249, null, undefined])(
      'rejects a non-canonical wire value %#',
      value => {
        expect(() => parseCommercialMoneyV2(value)).toThrow('COMMERCIAL_MONEY_V2_INVALID')
      },
    )

    it('rejects the exact bigint overflow immediately above PostgreSQL int8', () => {
      expect(() => parseCommercialMoneyV2('92233720368547758.08')).toThrow('COMMERCIAL_MONEY_V2_LIMIT_EXCEEDED')
    })

    it.each([
      [0n, '0.00'],
      [1n, '0.01'],
      [24_900n, '249.00'],
      [MAX_COMMERCIAL_MONEY_MINOR, moneyLimits.genericMaximum.wire],
    ])('formats %s minor units as canonical MXN wire money', (minor, expected) => {
      expect(formatCommercialMoneyV2(minor)).toBe(expected)
    })

    it.each([-1n, MAX_COMMERCIAL_MONEY_MINOR + 1n, 24_900 as unknown as bigint])(
      'rejects an invalid minor-unit formatter input %#',
      minor => {
        expect(() => formatCommercialMoneyV2(minor)).toThrow('COMMERCIAL_MONEY_V2_INVALID')
      },
    )

    it.each([
      ['UNIT_AMOUNT' as const, MAX_UNIT_AMOUNT_MINOR],
      ['LINE_LIST_SUBTOTAL' as const, MAX_LINE_LIST_SUBTOTAL_MINOR],
      ['QUOTE_LIST_SUBTOTAL' as const, MAX_QUOTE_LIST_SUBTOTAL_MINOR],
      ['QUOTE_DISCOUNT' as const, MAX_QUOTE_DISCOUNT_MINOR],
      ['QUOTE_TAX' as const, MAX_QUOTE_TAX_MINOR],
      ['QUOTE_TOTAL' as const, MAX_QUOTE_TOTAL_MINOR],
      ['RENEWAL_SUBTOTAL' as const, MAX_QUOTE_LIST_SUBTOTAL_MINOR],
      ['RENEWAL_TAX' as const, MAX_QUOTE_TAX_MINOR],
      ['RENEWAL_TOTAL' as const, MAX_QUOTE_TOTAL_MINOR],
    ])('accepts the exact %s limit and rejects one cent above it', (kind, limit) => {
      expect(assertCommercialMoneyLimitV2(kind, limit)).toBe(limit)
      expect(() => assertCommercialMoneyLimitV2(kind, limit + 1n)).toThrow('COMMERCIAL_MONEY_V2_LIMIT_EXCEEDED')
    })

    it('rounds basis points half-up using bigint intermediates', () => {
      expect(roundCommercialBasisPointsV2(1n, 4_999)).toBe(0n)
      expect(roundCommercialBasisPointsV2(1n, 5_000)).toBe(1n)
      expect(roundCommercialBasisPointsV2(24_900n, 1_600)).toBe(3_984n)
      expect(roundCommercialBasisPointsV2(MAX_QUOTE_LIST_SUBTOTAL_MINOR, 1_600)).toBe(MAX_QUOTE_TAX_MINOR)
    })

    it.each([
      [-1n, 1_600],
      [1n, -1],
      [1n, 10_001],
      [1n, 1.5],
    ] as const)('rejects invalid basis-point inputs (%s, %s)', (minor, basisPoints) => {
      expect(() => roundCommercialBasisPointsV2(minor, basisPoints)).toThrow('COMMERCIAL_BASIS_POINTS_V2_INVALID')
    })

    it('allows zero at the Stripe boundary only for an explicit free subscription cycle', () => {
      expect(() => toStripeMinorAmountV2(0n, {})).toThrow('COMMERCIAL_STRIPE_AMOUNT_V2_INVALID')
      expect(() => toStripeMinorAmountV2(0n, { allowZeroSubscriptionCycle: false })).toThrow('COMMERCIAL_STRIPE_AMOUNT_V2_INVALID')
      expect(toStripeMinorAmountV2(0n, { allowZeroSubscriptionCycle: true })).toBe(0)
    })

    it.each([
      [999n, false],
      [MIN_STRIPE_NON_ZERO_AMOUNT_MINOR, true],
      [MAX_STRIPE_AMOUNT_MINOR, true],
      [MAX_STRIPE_AMOUNT_MINOR + 1n, false],
    ])('enforces the Stripe minor-unit boundary for %s', (minor, accepted) => {
      if (accepted) expect(toStripeMinorAmountV2(minor, {})).toBe(Number(minor))
      else expect(() => toStripeMinorAmountV2(minor, {})).toThrow('COMMERCIAL_STRIPE_AMOUNT_V2_INVALID')
    })
  })

  describe('regression guardrails and frozen limits', () => {
    it('matches every master-brief money limit frozen in the fixture', () => {
      expect(MAX_COMMERCIAL_MONEY_MINOR.toString()).toBe(moneyLimits.genericMaximum.minor)
      expect(MAX_UNIT_AMOUNT_MINOR.toString()).toBe(moneyLimits.limitsMinor.unitAmount)
      expect(MAX_QUANTITY).toBe(moneyLimits.limitsMinor.quantity)
      expect(MAX_LINE_LIST_SUBTOTAL_MINOR.toString()).toBe(moneyLimits.limitsMinor.lineListSubtotal)
      expect(MAX_QUOTE_LINES).toBe(moneyLimits.limitsMinor.quoteLines)
      expect(MAX_QUOTE_LIST_SUBTOTAL_MINOR.toString()).toBe(moneyLimits.limitsMinor.quoteListSubtotal)
      expect(MAX_QUOTE_DISCOUNT_MINOR.toString()).toBe(moneyLimits.limitsMinor.quoteDiscount)
      expect(MAX_QUOTE_TAX_MINOR.toString()).toBe(moneyLimits.limitsMinor.quoteTax)
      expect(MAX_QUOTE_TOTAL_MINOR.toString()).toBe(moneyLimits.limitsMinor.quoteTotal)
      expect(MIN_STRIPE_NON_ZERO_AMOUNT_MINOR.toString()).toBe(moneyLimits.stripeMinor.minimumNonZero)
      expect(MAX_STRIPE_AMOUNT_MINOR.toString()).toBe(moneyLimits.stripeMinor.maximum)
    })

    it('round-trips the generic maximum without precision loss', () => {
      expect(formatCommercialMoneyV2(parseCommercialMoneyV2(moneyLimits.genericMaximum.wire))).toBe(moneyLimits.genericMaximum.wire)
    })
  })
})
