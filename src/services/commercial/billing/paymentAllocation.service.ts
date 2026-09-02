import { MAX_COMMERCIAL_MONEY_MINOR } from '@/contracts/commercial/commercialContractV2.constants'
import type {
  CommercialBillingAllocationPlan,
  CommercialBillingAllocationPlanInput,
} from '@/types/commercialBilling'

function assertMinorUnits(value: bigint, code: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_COMMERCIAL_MONEY_MINOR) {
    throw new Error(code)
  }
}

function lesser(left: bigint, right: bigint): bigint {
  return left < right ? left : right
}

/**
 * Builds a deterministic write plan without asserting that money exists.
 * Callers must supply amounts read under the same database locks used to write
 * the resulting allocations.
 */
export function buildCommercialBillingAllocationPlan(
  input: CommercialBillingAllocationPlanInput,
): CommercialBillingAllocationPlan {
  assertMinorUnits(input.receiptAmountMinor, 'COMMERCIAL_BILLING_RECEIPT_AMOUNT_INVALID')
  assertMinorUnits(input.receiptAllocatedMinor, 'COMMERCIAL_BILLING_RECEIPT_ALLOCATED_INVALID')

  if (input.receiptAllocatedMinor > input.receiptAmountMinor) {
    throw new Error('COMMERCIAL_BILLING_RECEIPT_OVERALLOCATED')
  }

  const seenReceivableIds = new Set<string>()
  let receiptAvailableMinor = input.receiptAmountMinor - input.receiptAllocatedMinor
  let newlyAllocatedMinor = 0n
  const allocations: CommercialBillingAllocationPlan['allocations'] = []

  for (const target of input.targets) {
    if (typeof target.receivableId !== 'string' || target.receivableId.trim() === '') {
      throw new Error('COMMERCIAL_BILLING_RECEIVABLE_ID_INVALID')
    }
    if (seenReceivableIds.has(target.receivableId)) {
      throw new Error('COMMERCIAL_BILLING_RECEIVABLE_DUPLICATED')
    }
    seenReceivableIds.add(target.receivableId)

    assertMinorUnits(target.amountMinor, 'COMMERCIAL_BILLING_RECEIVABLE_AMOUNT_INVALID')
    assertMinorUnits(target.allocatedMinor, 'COMMERCIAL_BILLING_RECEIVABLE_ALLOCATED_INVALID')
    if (target.allocatedMinor > target.amountMinor) {
      throw new Error('COMMERCIAL_BILLING_RECEIVABLE_OVERALLOCATED')
    }

    const outstandingMinor = target.amountMinor - target.allocatedMinor
    const allocationMinor = lesser(receiptAvailableMinor, outstandingMinor)
    if (allocationMinor === 0n) continue

    receiptAvailableMinor -= allocationMinor
    newlyAllocatedMinor += allocationMinor
    const receivableOutstandingMinor = outstandingMinor - allocationMinor
    allocations.push({
      receivableId: target.receivableId,
      amountMinor: allocationMinor,
      receivableOutstandingMinor,
      becomesCovered: receivableOutstandingMinor === 0n,
    })
  }

  if (input.receiptAllocatedMinor + newlyAllocatedMinor + receiptAvailableMinor !== input.receiptAmountMinor) {
    throw new Error('COMMERCIAL_BILLING_ALLOCATION_CONSERVATION_FAILED')
  }

  return {
    allocations,
    newlyAllocatedMinor,
    receiptUnallocatedMinor: receiptAvailableMinor,
  }
}
