import { Decimal } from '@prisma/client/runtime/library'

import { serializeShiftCashReconciliation } from '@/services/dashboard/shift.dashboard.service'

describe('serializeShiftCashReconciliation', () => {
  it('preserves a real zero count and balanced zero difference', () => {
    expect(
      serializeShiftCashReconciliation({
        endingCash: new Decimal('0.00'),
        cashDeclared: new Decimal('0.00'),
        cashDifference: new Decimal('0.00'),
      }),
    ).toEqual({ endingCash: 0, cashDeclared: 0, cashDifference: 0 })
  })

  it('keeps an absent count distinguishable from a counted empty drawer', () => {
    expect(
      serializeShiftCashReconciliation({
        endingCash: null,
        cashDeclared: null,
        cashDifference: null,
      }),
    ).toEqual({ endingCash: null, cashDeclared: null, cashDifference: null })
  })

  it('serializes negative and positive values without truthiness shortcuts', () => {
    expect(
      serializeShiftCashReconciliation({
        endingCash: new Decimal('5900.00'),
        cashDeclared: new Decimal('5900.00'),
        cashDifference: new Decimal('-100.00'),
      }),
    ).toEqual({ endingCash: 5900, cashDeclared: 5900, cashDifference: -100 })
  })
})
