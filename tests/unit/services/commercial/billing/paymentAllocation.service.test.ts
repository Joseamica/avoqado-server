import { buildCommercialBillingAllocationPlan } from '@/services/commercial/billing/paymentAllocation.service'

describe('buildCommercialBillingAllocationPlan', () => {
  it('covers one receivable exactly and marks it eligible to become PAID', () => {
    const result = buildCommercialBillingAllocationPlan({
      receiptAmountMinor: 28_884n,
      receiptAllocatedMinor: 0n,
      targets: [{ receivableId: 'ar-month-1', amountMinor: 28_884n, allocatedMinor: 0n }],
    })

    expect(result).toEqual({
      allocations: [
        {
          receivableId: 'ar-month-1',
          amountMinor: 28_884n,
          receivableOutstandingMinor: 0n,
          becomesCovered: true,
        },
      ],
      newlyAllocatedMinor: 28_884n,
      receiptUnallocatedMinor: 0n,
    })
  })

  it('keeps a partially covered receivable open', () => {
    const result = buildCommercialBillingAllocationPlan({
      receiptAmountMinor: 10_000n,
      receiptAllocatedMinor: 0n,
      targets: [{ receivableId: 'ar-month-1', amountMinor: 28_884n, allocatedMinor: 0n }],
    })

    expect(result.allocations).toEqual([
      {
        receivableId: 'ar-month-1',
        amountMinor: 10_000n,
        receivableOutstandingMinor: 18_884n,
        becomesCovered: false,
      },
    ])
    expect(result.newlyAllocatedMinor).toBe(10_000n)
    expect(result.receiptUnallocatedMinor).toBe(0n)
  })

  it('leaves an overpayment unallocated instead of inventing another paid period', () => {
    const result = buildCommercialBillingAllocationPlan({
      receiptAmountMinor: 30_000n,
      receiptAllocatedMinor: 0n,
      targets: [{ receivableId: 'ar-month-1', amountMinor: 28_884n, allocatedMinor: 0n }],
    })

    expect(result.newlyAllocatedMinor).toBe(28_884n)
    expect(result.receiptUnallocatedMinor).toBe(1_116n)
    expect(result.allocations[0]?.becomesCovered).toBe(true)
  })

  it('conserves one receipt while allocating across multiple receivables in explicit order', () => {
    const result = buildCommercialBillingAllocationPlan({
      receiptAmountMinor: 30_000n,
      receiptAllocatedMinor: 0n,
      targets: [
        { receivableId: 'ar-month-1', amountMinor: 10_000n, allocatedMinor: 0n },
        { receivableId: 'ar-month-2', amountMinor: 25_000n, allocatedMinor: 5_000n },
      ],
    })

    expect(result.allocations).toEqual([
      {
        receivableId: 'ar-month-1',
        amountMinor: 10_000n,
        receivableOutstandingMinor: 0n,
        becomesCovered: true,
      },
      {
        receivableId: 'ar-month-2',
        amountMinor: 20_000n,
        receivableOutstandingMinor: 0n,
        becomesCovered: true,
      },
    ])
    expect(result.newlyAllocatedMinor + result.receiptUnallocatedMinor).toBe(30_000n)
  })

  it('rejects impossible pre-existing money states before planning a write', () => {
    expect(() =>
      buildCommercialBillingAllocationPlan({
        receiptAmountMinor: 10_000n,
        receiptAllocatedMinor: 10_001n,
        targets: [{ receivableId: 'ar-month-1', amountMinor: 10_000n, allocatedMinor: 0n }],
      }),
    ).toThrow('COMMERCIAL_BILLING_RECEIPT_OVERALLOCATED')

    expect(() =>
      buildCommercialBillingAllocationPlan({
        receiptAmountMinor: 10_000n,
        receiptAllocatedMinor: 0n,
        targets: [{ receivableId: 'ar-month-1', amountMinor: 10_000n, allocatedMinor: 10_001n }],
      }),
    ).toThrow('COMMERCIAL_BILLING_RECEIVABLE_OVERALLOCATED')
  })
})
