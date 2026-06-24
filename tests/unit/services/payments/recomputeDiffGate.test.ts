/**
 * Recompute-diff gate (PR-2 · T5) — categorization + STOP logic.
 *
 * Mocks the resolver context (resolveRosterCostContext) per payment but uses the
 * REAL cost math (computeCostAmounts) so the MATCH/DIFF/STOP decisions and the net
 * delta are exercised end-to-end against the actual formulas.
 */

import { PaymentMethod, CardBrand, OriginSystem } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

// Partial mock: keep computeCostAmounts + determineTransactionCardType REAL, stub
// only the roster resolver so we can drive each payment's context deterministically.
jest.mock('@/services/payments/transactionCost.service', () => {
  const actual = jest.requireActual('@/services/payments/transactionCost.service')
  return { ...actual, resolveRosterCostContext: jest.fn() }
})

import { recomputeTransactionCostDiff } from '@/services/payments/recomputeDiffGate.service'
import { resolveRosterCostContext } from '@/services/payments/transactionCost.service'

const mockResolve = resolveRosterCostContext as jest.Mock

const VENUE_ID = 'venue-1'

function structure(rate: string, fixedKey: 'fixedCostPerTransaction' | 'fixedFeePerTransaction') {
  return {
    id: `s-${rate}`,
    creditRate: { toString: () => rate },
    debitRate: { toString: () => rate },
    amexRate: { toString: () => rate },
    internationalRate: { toString: () => rate },
    includesTax: true, // effective rate == base rate (clean assertions)
    taxRate: { toString: () => '0.16' },
    [fixedKey]: { toString: () => '0' },
  }
}

function mkPayment(id: string, storedVenueCharge: number | null) {
  return {
    id,
    venueId: VENUE_ID,
    amount: { toString: () => '500.00' },
    tipAmount: { toString: () => '0.00' },
    method: PaymentMethod.CREDIT_CARD,
    cardBrand: CardBrand.VISA,
    type: 'SALE',
    processorData: null,
    createdAt: new Date('2026-02-15T18:00:00Z'),
    merchantAccountId: 'm-1',
    transactionCost:
      storedVenueCharge === null ? null : { venueChargeAmount: { toString: () => String(storedVenueCharge) }, providerCostAmount: { toString: () => '9' } },
  }
}

// ctx where pricing resolves to `rate` (venue charge = 500 * rate)
function ctxWithRate(rate: string, overrides?: any) {
  return {
    merchantAccount: { id: 'm-1' },
    providerCostStructure: structure('0.018', 'fixedCostPerTransaction'),
    venuePricingStructure: structure(rate, 'fixedFeePerTransaction'),
    pricingStructureSource: 'VENUE',
    organizationPricingStructureId: null,
    providerCostFallbackUsed: false,
    venuePricingFallbackUsed: false,
    ...overrides,
  }
}

describe('recomputeTransactionCostDiff (T5)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('MATCH when the recomputed venue charge equals the stored one (within tolerance)', async () => {
    prismaMock.payment.findMany.mockResolvedValue([mkPayment('p1', 40)] as any) // 500 * 8% = 40
    mockResolve.mockResolvedValue(ctxWithRate('0.08'))

    const res = await recomputeTransactionCostDiff(VENUE_ID)

    expect(res.total).toBe(1)
    expect(res.matched).toBe(1)
    expect(res.diffs).toBe(0)
    expect(res.stops).toBe(0)
    expect(res.safeToEnable).toBe(true)
    expect(res.rows[0].status).toBe('MATCH')
  })

  it('DIFF (amaena class): stored under-charge (4.18%) vs recomputed 8% → flagged with the peso delta', async () => {
    prismaMock.payment.findMany.mockResolvedValue([mkPayment('p2', 20.9)] as any) // stored 500 * 4.18%
    mockResolve.mockResolvedValue(ctxWithRate('0.08')) // recompute at the correct 8%

    const res = await recomputeTransactionCostDiff(VENUE_ID)

    expect(res.diffs).toBe(1)
    expect(res.matched).toBe(0)
    expect(res.stops).toBe(0)
    expect(res.safeToEnable).toBe(true) // diffs are explainable, not a hard stop
    expect(res.rows[0].status).toBe('DIFF')
    expect(res.rows[0].reason).toBe('rate_change')
    expect(res.rows[0].deltaVenueCharge).toBeCloseTo(19.1, 2) // 40 − 20.9
    expect(res.netVenueChargeDelta).toBeCloseTo(19.1, 2)
  })

  it('STOP when the resolver cannot find venue pricing → not safe to enable', async () => {
    prismaMock.payment.findMany.mockResolvedValue([mkPayment('p3', 40)] as any)
    mockResolve.mockResolvedValue(ctxWithRate('0.08', { venuePricingStructure: null }))

    const res = await recomputeTransactionCostDiff(VENUE_ID)

    expect(res.stops).toBe(1)
    expect(res.safeToEnable).toBe(false)
    expect(res.stopReasons).toContain('no_venue_pricing')
    expect(res.rows[0].status).toBe('STOP')
  })

  it('STOP when the account is not attributable (no merchant account)', async () => {
    prismaMock.payment.findMany.mockResolvedValue([mkPayment('p4', 40)] as any)
    mockResolve.mockResolvedValue(ctxWithRate('0.08', { merchantAccount: null }))

    const res = await recomputeTransactionCostDiff(VENUE_ID)

    expect(res.stops).toBe(1)
    expect(res.safeToEnable).toBe(false)
    expect(res.stopReasons).toContain('no_merchant_account')
  })

  it('counts pricing fallbacks and aggregates a mixed batch', async () => {
    prismaMock.payment.findMany.mockResolvedValue([mkPayment('a', 40), mkPayment('b', 20.9), mkPayment('c', 40)] as any)
    mockResolve
      .mockResolvedValueOnce(ctxWithRate('0.08')) // a → MATCH
      .mockResolvedValueOnce(ctxWithRate('0.08', { venuePricingFallbackUsed: true })) // b → DIFF (fallback)
      .mockResolvedValueOnce(ctxWithRate('0.08', { venuePricingStructure: null })) // c → STOP

    const res = await recomputeTransactionCostDiff(VENUE_ID)

    expect(res.total).toBe(3)
    expect(res.matched).toBe(1)
    expect(res.diffs).toBe(1)
    expect(res.stops).toBe(1)
    expect(res.fallbackCount).toBe(1)
    expect(res.safeToEnable).toBe(false) // one STOP blocks the flip
    expect(res.rows[1].reason).toBe('pricing_fallback_to_primary')
  })

  it('eligibility: scans only AVOQADO non-cash payments', async () => {
    prismaMock.payment.findMany.mockResolvedValue([] as any)

    await recomputeTransactionCostDiff(VENUE_ID)

    expect(prismaMock.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: VENUE_ID,
          originSystem: OriginSystem.AVOQADO,
          method: { not: PaymentMethod.CASH },
        }),
      }),
    )
  })
})
