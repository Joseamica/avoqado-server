import { MAX_COMMERCIAL_MONEY_MINOR } from '@/contracts/commercial/commercialContractV2.constants'
import type {
  CommercialSubscriptionPeriodCoverage,
  CommercialSubscriptionPeriodCoverageInput,
  CommercialSubscriptionPeriodStatus,
} from '@/types/commercialBilling'

const PERIOD_STATUSES: ReadonlySet<CommercialSubscriptionPeriodStatus> = new Set([
  'OPEN',
  'PAST_DUE',
  'EXPIRED',
  'PAID',
])

function assertMoney(value: bigint, code: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_COMMERCIAL_MONEY_MINOR) {
    throw new Error(code)
  }
}

function dateMillis(value: Date, code: string): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(code)
  return value.getTime()
}

export function evaluateCommercialSubscriptionPeriodCoverage(
  input: CommercialSubscriptionPeriodCoverageInput,
): CommercialSubscriptionPeriodCoverage {
  if (!PERIOD_STATUSES.has(input.previousStatus)) {
    throw new Error('COMMERCIAL_BILLING_PERIOD_STATUS_INVALID')
  }
  assertMoney(input.amountDueMinor, 'COMMERCIAL_BILLING_PERIOD_AMOUNT_INVALID')
  assertMoney(input.activeAllocatedMinor, 'COMMERCIAL_BILLING_PERIOD_ALLOCATION_INVALID')
  if (input.activeAllocatedMinor > input.amountDueMinor) {
    throw new Error('COMMERCIAL_BILLING_PERIOD_OVERCOVERED')
  }

  const dueAt = dateMillis(input.dueAt, 'COMMERCIAL_BILLING_PERIOD_DUE_AT_INVALID')
  const graceEndsAt = dateMillis(input.graceEndsAt, 'COMMERCIAL_BILLING_PERIOD_GRACE_END_INVALID')
  const now = dateMillis(input.now, 'COMMERCIAL_BILLING_PERIOD_NOW_INVALID')
  if (graceEndsAt < dueAt) throw new Error('COMMERCIAL_BILLING_PERIOD_GRACE_INVALID')

  const outstandingMinor = input.amountDueMinor - input.activeAllocatedMinor
  let status: CommercialSubscriptionPeriodStatus
  if (outstandingMinor === 0n) status = 'PAID'
  else if (now <= dueAt) status = 'OPEN'
  else if (now <= graceEndsAt) status = 'PAST_DUE'
  else status = 'EXPIRED'

  const transition =
    input.previousStatus !== 'PAID' && status === 'PAID'
      ? 'PAYMENT_RECONCILED'
      : input.previousStatus === 'PAID' && status !== 'PAID'
        ? 'PAYMENT_COVERAGE_REVERSED'
        : 'NONE'

  return { status, outstandingMinor, transition }
}
