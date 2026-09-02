import {
  COMMERCIAL_MONEY_V2_PATTERN,
  MAX_COMMERCIAL_MONEY_MINOR,
  MAX_LINE_LIST_SUBTOTAL_MINOR,
  MAX_QUOTE_DISCOUNT_MINOR,
  MAX_QUOTE_LIST_SUBTOTAL_MINOR,
  MAX_QUOTE_TAX_MINOR,
  MAX_QUOTE_TOTAL_MINOR,
  MAX_STRIPE_AMOUNT_MINOR,
  MAX_UNIT_AMOUNT_MINOR,
  MIN_STRIPE_NON_ZERO_AMOUNT_MINOR,
} from '@/contracts/commercial/commercialContractV2.constants'

export type CommercialMoneyLimitKindV2 =
  | 'UNIT_AMOUNT'
  | 'LINE_LIST_SUBTOTAL'
  | 'QUOTE_LIST_SUBTOTAL'
  | 'QUOTE_DISCOUNT'
  | 'QUOTE_TAX'
  | 'QUOTE_TOTAL'
  | 'RENEWAL_SUBTOTAL'
  | 'RENEWAL_TAX'
  | 'RENEWAL_TOTAL'

export interface StripeMinorAmountOptionsV2 {
  allowZeroSubscriptionCycle?: boolean
}

const LIMIT_BY_KIND: Readonly<Record<CommercialMoneyLimitKindV2, bigint>> = Object.freeze({
  UNIT_AMOUNT: MAX_UNIT_AMOUNT_MINOR,
  LINE_LIST_SUBTOTAL: MAX_LINE_LIST_SUBTOTAL_MINOR,
  QUOTE_LIST_SUBTOTAL: MAX_QUOTE_LIST_SUBTOTAL_MINOR,
  QUOTE_DISCOUNT: MAX_QUOTE_DISCOUNT_MINOR,
  QUOTE_TAX: MAX_QUOTE_TAX_MINOR,
  QUOTE_TOTAL: MAX_QUOTE_TOTAL_MINOR,
  RENEWAL_SUBTOTAL: MAX_QUOTE_LIST_SUBTOTAL_MINOR,
  RENEWAL_TAX: MAX_QUOTE_TAX_MINOR,
  RENEWAL_TOTAL: MAX_QUOTE_TOTAL_MINOR,
})

function invalidMoney(): never {
  throw new Error('COMMERCIAL_MONEY_V2_INVALID')
}

function moneyLimitExceeded(): never {
  throw new Error('COMMERCIAL_MONEY_V2_LIMIT_EXCEEDED')
}

export function parseCommercialMoneyV2(value: unknown): bigint {
  if (typeof value !== 'string' || !COMMERCIAL_MONEY_V2_PATTERN.test(value)) invalidMoney()

  const [whole, fraction] = value.split('.') as [string, string]
  const minor = BigInt(whole) * 100n + BigInt(fraction)
  if (minor > MAX_COMMERCIAL_MONEY_MINOR) moneyLimitExceeded()
  return minor
}

export function formatCommercialMoneyV2(minor: bigint): string {
  if (typeof minor !== 'bigint' || minor < 0n || minor > MAX_COMMERCIAL_MONEY_MINOR) invalidMoney()

  const whole = minor / 100n
  const fraction = (minor % 100n).toString().padStart(2, '0')
  return `${whole.toString()}.${fraction}`
}

export function assertCommercialMoneyLimitV2(kind: CommercialMoneyLimitKindV2, minor: bigint): bigint {
  if (typeof minor !== 'bigint' || minor < 0n) invalidMoney()
  if (!Object.prototype.hasOwnProperty.call(LIMIT_BY_KIND, kind)) invalidMoney()
  if (minor > LIMIT_BY_KIND[kind]) moneyLimitExceeded()
  return minor
}

export function roundCommercialBasisPointsV2(minor: bigint, basisPoints: number): bigint {
  if (
    typeof minor !== 'bigint' ||
    minor < 0n ||
    minor > MAX_COMMERCIAL_MONEY_MINOR ||
    !Number.isInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > 10_000
  ) {
    throw new Error('COMMERCIAL_BASIS_POINTS_V2_INVALID')
  }

  return (minor * BigInt(basisPoints) + 5_000n) / 10_000n
}

export function toStripeMinorAmountV2(minor: bigint, options: StripeMinorAmountOptionsV2): number {
  if (typeof minor !== 'bigint' || minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('COMMERCIAL_STRIPE_AMOUNT_V2_INVALID')
  }
  if (minor === 0n) {
    if (options?.allowZeroSubscriptionCycle !== true) throw new Error('COMMERCIAL_STRIPE_AMOUNT_V2_INVALID')
    return 0
  }
  if (minor < MIN_STRIPE_NON_ZERO_AMOUNT_MINOR || minor > MAX_STRIPE_AMOUNT_MINOR) {
    throw new Error('COMMERCIAL_STRIPE_AMOUNT_V2_INVALID')
  }

  return Number(minor)
}
