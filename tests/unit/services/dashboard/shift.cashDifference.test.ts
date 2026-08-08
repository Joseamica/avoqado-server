/**
 * Cash over/short on a shift.
 *
 * 🔴 The formula was `endingCash - startingCash`, which is not a cash difference — it is the
 * net change in the drawer. A shift that sold $5,000 in cash and balanced to the peso
 * reported "+$5,000 over". Every shift that sold anything looked like a huge surplus, so the
 * shift-difference report was noise rather than control.
 *
 * A cash difference is COUNTED − EXPECTED, where expected = float + cash taken in.
 *
 * The second half of this story is not fixable server-side: the TPV closes shifts WITHOUT
 * sending any declared cash (`CloseShiftData` is marked "NOT USED IN MVP" and
 * `ShiftViewModel.closeShift()` passes nothing), so for TPV-closed shifts nobody ever counts
 * the drawer. Hence the null contract below — it is the honest answer, and it is what tells
 * the report to show a blank instead of a fake zero.
 */

import { computeCashDifference } from '@/services/dashboard/shift.dashboard.service'

describe('computeCashDifference', () => {
  it('🔴 REGRESSION: a shift that balanced to the peso reports 0, not the cash sales', () => {
    // Float 1,000 + 5,000 in cash sales = 6,000 expected. Counted 6,000 → balanced.
    // The old formula returned 5,000 here and called it a surplus.
    expect(computeCashDifference({ countedCash: 6000, startingCash: 1000, cashSales: 5000 })).toBe(0)
  })

  it('a shortfall comes out negative', () => {
    expect(computeCashDifference({ countedCash: 5900, startingCash: 1000, cashSales: 5000 })).toBe(-100)
  })

  it('a surplus comes out positive', () => {
    expect(computeCashDifference({ countedCash: 6050, startingCash: 1000, cashSales: 5000 })).toBe(50)
  })

  it('🔴 nobody counted the drawer → null, never 0', () => {
    // A fabricated 0 reads as "balanced", which is the one answer we must never invent.
    // This is the live case for every TPV-closed shift today.
    expect(computeCashDifference({ countedCash: null, startingCash: 1000, cashSales: 5000 })).toBeNull()
  })

  it('a shift with no cash sales still reconciles against the float', () => {
    expect(computeCashDifference({ countedCash: 1000, startingCash: 1000, cashSales: 0 })).toBe(0)
    expect(computeCashDifference({ countedCash: 940, startingCash: 1000, cashSales: 0 })).toBe(-60)
  })

  it('rounds to cents instead of leaking floating-point dust', () => {
    // 0.1 + 0.2 in float is 0.30000000000000004. A centavo appearing from nowhere in a
    // cash-difference report sends someone to count a drawer for no reason.
    expect(computeCashDifference({ countedCash: 0.3, startingCash: 0.1, cashSales: 0.2 })).toBe(0)
  })

  it('counting zero is a real count, not a missing one', () => {
    // An empty drawer with 1,000 expected is a 1,000 shortfall — the single most important
    // case for this report to get right.
    expect(computeCashDifference({ countedCash: 0, startingCash: 1000, cashSales: 0 })).toBe(-1000)
  })
})

describe('both close paths share one formula', () => {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const tpv = fs.readFileSync(path.join(__dirname, '../../../../src/services/tpv/shift.tpv.service.ts'), 'utf8')

  it('the TPV close calls the shared function instead of copying it', () => {
    // The purchase-order totals lived in triplicate and the copies drifted — editing an
    // order silently dropped the commission from its total. One function, two callers.
    expect(tpv).toContain('computeCashDifference({')
    expect(tpv).not.toMatch(/cashDifference:\s*.*endingCash\s*-\s*startingCash/)
  })
})
