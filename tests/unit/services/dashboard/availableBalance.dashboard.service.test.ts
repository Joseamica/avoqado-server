/**
 * Regression guard for the Available Balance fee math.
 *
 * Bug (2026-07-04): getAvailableBalance netted only `venueChargeAmount` and
 * dropped `venueFixedFee`, so a venue with a per-transaction fixed fee saw an
 * overstated net / understated fees — and it disagreed with the Sales Summary
 * breakdown (which nets both) and the stored settlement net. These tests pin:
 *   - totalFees / net include venueFixedFee
 *   - card payments with NO TransactionCost are surfaced as uncosted{Count,Amount}
 *   - money is available AUTOMATICALLY once its settlement date passes (no manual
 *     "confirmar liquidación" needed)
 */

import { getAvailableBalance } from '@/services/dashboard/availableBalance.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

// getLastCloseoutDate hits its own prisma path — pin it so the cash query window
// is deterministic and the test focuses on the fee math.
jest.mock('@/services/dashboard/cashCloseout.dashboard.service', () => ({
  getLastCloseoutDate: jest.fn().mockResolvedValue(new Date('2000-01-01T00:00:00.000Z')),
}))

const VENUE = 'venue-amaena'

describe('getAvailableBalance — venueFixedFee + uncosted', () => {
  it('nets out venueChargeAmount + venueFixedFee (not just the percentage charge)', async () => {
    ;(prismaMock.payment.findMany as jest.Mock)
      // Card payments (first call)
      .mockResolvedValueOnce([
        {
          amount: 100,
          tipAmount: 0,
          transactionCost: { venueChargeAmount: 3, venueFixedFee: 2 },
          // Far-future settlement date → unambiguously still pending, regardless of the clock.
          transaction: { status: 'PENDING', estimatedSettlementDate: new Date('2099-01-01T00:00:00.000Z'), netSettlementAmount: null },
        },
      ])
      // Cash payments (second call)
      .mockResolvedValueOnce([])

    const summary = await getAvailableBalance(VENUE)

    // fee = 3 + 2 = 5 (the bug reported only 3)
    expect(summary.totalFees).toBe(5)
    // net = 100 - 5 = 95, pending (no stored netSettlementAmount → computed net)
    expect(summary.pendingSettlement).toBe(95)
    expect(summary.uncostedCount).toBe(0)
    expect(summary.uncostedAmount).toBe(0)
  })

  it('auto-settles by date: a PENDING transaction whose settlement date has passed counts as available', async () => {
    ;(prismaMock.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([
        // DB says PENDING, but its settlement date is in the PAST → the money landed.
        // No manual "confirmar liquidación" needed; it must show as available.
        {
          amount: 100,
          tipAmount: 0,
          transactionCost: { venueChargeAmount: 4, venueFixedFee: 0 },
          transaction: { status: 'PENDING', estimatedSettlementDate: new Date('2000-01-05T00:00:00.000Z'), netSettlementAmount: 96 },
        },
        // Future settlement date → genuinely still pending.
        {
          amount: 100,
          tipAmount: 0,
          transactionCost: { venueChargeAmount: 4, venueFixedFee: 0 },
          transaction: { status: 'PENDING', estimatedSettlementDate: new Date('2099-01-01T00:00:00.000Z'), netSettlementAmount: 96 },
        },
      ])
      .mockResolvedValueOnce([])

    const summary = await getAvailableBalance(VENUE)

    expect(summary.availableNow).toBe(96) // past-dated one landed (no cash here)
    expect(summary.pendingSettlement).toBe(96) // future-dated one still pending
  })

  it('surfaces card money with no TransactionCost as uncosted (fee 0, counted in balance)', async () => {
    ;(prismaMock.payment.findMany as jest.Mock)
      .mockResolvedValueOnce([
        // Costed
        {
          amount: 200,
          tipAmount: 0,
          transactionCost: { venueChargeAmount: 6, venueFixedFee: 2 },
          transaction: { status: 'SETTLED', estimatedSettlementDate: null, netSettlementAmount: 192 },
        },
        // Uncosted (e.g. merchant account without a VenuePricingStructure)
        {
          amount: 500,
          tipAmount: 0,
          transactionCost: null,
          transaction: null,
        },
      ])
      .mockResolvedValueOnce([{ amount: 30, tipAmount: 0 }])

    const summary = await getAvailableBalance(VENUE)

    expect(summary.uncostedCount).toBe(1)
    expect(summary.uncostedAmount).toBe(500)
    // Costed fee only (uncosted contributes 0 fee)
    expect(summary.totalFees).toBe(8)
    // Settled uses stored net (192); cash is immediately available (30)
    expect(summary.availableNow).toBe(222)
    // Uncosted card money is still owed → pending at fee 0
    expect(summary.pendingSettlement).toBe(500)
  })
})
