import { Prisma } from '@prisma/client'
import {
  computeCountCorrection,
  countCorrectionBlock,
  describeDifference,
  normalizeCorrectionInput,
} from '../../../../src/services/dashboard/cashCountCorrection.rules'

const cerrado = { status: 'CLOSED', originSystem: 'AVOQADO', cashDeclared: 20000, cashDifference: 18000 }
const caja = { linkedToShift: true, status: 'CLOSED', actualAmount: 20000, overShort: 18000 }

describe('cashCountCorrection.rules', () => {
  it('par ligado, cerrado y contado: se puede corregir', () => expect(countCorrectionBlock(cerrado, caja)).toBeNull())
  it.each([
    [{ ...cerrado, status: 'CLOSING' }, caja, 'SHIFT_NOT_CLOSED'],
    [{ ...cerrado, originSystem: 'POS_SOFTRESTAURANT' }, caja, 'EXTERNAL_POS'],
    [{ ...cerrado, cashDeclared: null }, caja, 'NOT_COUNTED'],
    [cerrado, null, 'NO_LINKED_DRAWER'],
    [cerrado, { ...caja, linkedToShift: false }, 'NO_LINKED_DRAWER'],
    [cerrado, { ...caja, status: 'OPEN' }, 'DRAWER_NOT_CLOSED'],
    [cerrado, { ...caja, actualAmount: null }, 'DRAWER_NOT_CLOSED'],
    [{ ...cerrado, cashDifference: null }, caja, 'NO_SIGNED_DIFFERENCE'],
    [cerrado, { ...caja, overShort: null }, 'NO_SIGNED_DIFFERENCE'],
    [cerrado, { ...caja, actualAmount: '20000.01' }, 'COUNT_MISMATCH'],
  ])('bloquea %#', (s, d, code) => expect(countCorrectionBlock(s as never, d as never)).toBe(code))
  it('el primero de la tabla gana (abierto y sin contar ⇒ SHIFT_NOT_CLOSED)', () =>
    expect(countCorrectionBlock({ ...cerrado, status: 'OPEN', cashDeclared: null }, null)).toBe('SHIFT_NOT_CLOSED'))
  it.each([1999.995, -1, Number.NaN, 100000000, '2000'])('monto inválido %p ⇒ CASH_COUNT_INVALID_AMOUNT', countedCash =>
    expect(() => normalizeCorrectionInput({ countedCash, reason: 'error de dedo' })).toThrow(
      expect.objectContaining({ code: 'CASH_COUNT_INVALID_AMOUNT', statusCode: 400 }),
    ))
  it.each(['   ', ' ok ', 'x'.repeat(301), undefined])('motivo inválido %p ⇒ CASH_COUNT_INVALID_REASON', reason =>
    expect(() => normalizeCorrectionInput({ countedCash: 2000, reason })).toThrow(expect.objectContaining({ code: 'CASH_COUNT_INVALID_REASON' })),
  )
  it('recorta el motivo y acepta 2 decimales', () => {
    const r = normalizeCorrectionInput({ countedCash: 2000.5, reason: '  error de dedo ' })
    expect([r.countedCash.toFixed(2), r.reason]).toEqual(['2000.50', 'error de dedo'])
  })
  it('el resultado sale de los movimientos de la caja (cierre de la PAX con foto vieja)', () => {
    const r = computeCountCorrection({ countedBefore: '20000.00', countedAfter: new Prisma.Decimal('2100'), expectedAmount: 2100 })
    expect([r.countedAfter.toFixed(2), r.differenceAfter.toFixed(2)]).toEqual(['2100.00', '0.00'])
  })
  it('ruido de punto flotante en el esperado no deja centavos', () =>
    expect(
      computeCountCorrection({ countedBefore: 20000, countedAfter: new Prisma.Decimal('2100'), expectedAmount: 2099.9999999999995 }).differenceAfter.toFixed(2),
    ).toBe('0.00'))
  it('mismo monto ⇒ 400 CASH_COUNT_SAME', () =>
    expect(() => computeCountCorrection({ countedBefore: '2000.00', countedAfter: new Prisma.Decimal('2000'), expectedAmount: 2000 })).toThrow(
      expect.objectContaining({ code: 'CASH_COUNT_SAME', statusCode: 400 }),
    ))
  it('justo en el tope de Decimal(10,2) no lanza', () =>
    expect(() => computeCountCorrection({ countedBefore: 1, countedAfter: new Prisma.Decimal('99999999.99'), expectedAmount: 0 })).not.toThrow())
  it('diferencia que se pasa del tope ⇒ 400 CASH_COUNT_OVERFLOW', () =>
    expect(() => computeCountCorrection({ countedBefore: 1, countedAfter: new Prisma.Decimal('0'), expectedAmount: 100000000.5 })).toThrow(
      expect.objectContaining({ code: 'CASH_COUNT_OVERFLOW' }),
    ))
  it('describe la diferencia en español', () => {
    expect(describeDifference(0)).toBe('Cuadró')
    expect(describeDifference(18000)).toBe('Sobrante $18,000.00')
    expect(describeDifference(-50)).toBe('Faltante $50.00')
  })
})
