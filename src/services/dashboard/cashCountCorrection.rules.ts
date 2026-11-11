import { Prisma } from '@prisma/client'
import { BadRequestError, ConflictError } from '../../errors/AppError'

export type DecimalLike = { toString(): string } | number
export type CountCorrectionBlockCode =
  | 'SHIFT_NOT_CLOSED'
  | 'EXTERNAL_POS'
  | 'NOT_COUNTED'
  | 'NO_LINKED_DRAWER'
  | 'DRAWER_NOT_CLOSED'
  | 'NO_SIGNED_DIFFERENCE'
  | 'COUNT_MISMATCH'

export interface CountCorrectionShiftFacts {
  status: string
  originSystem: string
  cashDeclared: DecimalLike | null
  cashDifference: DecimalLike | null
}
export interface CountCorrectionDrawerFacts {
  linkedToShift: boolean
  status: string
  actualAmount: DecimalLike | null
  overShort: DecimalLike | null
}

export const MAX_CORRECTIONS_PER_SHIFT = 50
const MAX_AMOUNT = new Prisma.Decimal('99999999.99') // Decimal(10,2) de Shift

export const COUNT_CORRECTION_BLOCK_MESSAGES: Record<CountCorrectionBlockCode, string> = {
  SHIFT_NOT_CLOSED: 'El corte todavía no está cerrado',
  EXTERNAL_POS: 'Este corte viene de otro sistema (como SoftRestaurant); su conteo no se corrige desde Avoqado',
  NOT_COUNTED: 'Este corte se cerró sin contar; no hay conteo que corregir',
  NO_LINKED_DRAWER: 'Este corte no tiene caja ligada (es anterior al 3-sep o no usó caja); pídele la corrección a soporte',
  DRAWER_NOT_CLOSED: 'La caja de este corte sigue abierta o se cerró sin contar',
  NO_SIGNED_DIFFERENCE: 'Este corte no tiene una diferencia firmada que corregir',
  COUNT_MISMATCH: 'La caja y el turno no coinciden; avisa a soporte',
}

const dec = (v: DecimalLike) => new Prisma.Decimal(v.toString())

export function countCorrectionBlock(shift: CountCorrectionShiftFacts, drawer: CountCorrectionDrawerFacts | null): CountCorrectionBlockCode | null {
  if (shift.status !== 'CLOSED') return 'SHIFT_NOT_CLOSED'
  if (shift.originSystem !== 'AVOQADO') return 'EXTERNAL_POS'
  if (shift.cashDeclared == null) return 'NOT_COUNTED'
  if (!drawer || !drawer.linkedToShift) return 'NO_LINKED_DRAWER'
  if (drawer.status !== 'CLOSED' || drawer.actualAmount == null) return 'DRAWER_NOT_CLOSED'
  if (shift.cashDifference == null || drawer.overShort == null) return 'NO_SIGNED_DIFFERENCE'
  if (!dec(shift.cashDeclared).equals(dec(drawer.actualAmount))) return 'COUNT_MISMATCH'
  return null
}

export const countCorrectionConflict = (code: CountCorrectionBlockCode) =>
  new ConflictError(COUNT_CORRECTION_BLOCK_MESSAGES[code], `CASH_COUNT_${code}`)

export function normalizeCorrectionInput(input: { countedCash: unknown; reason: unknown }): { countedCash: Prisma.Decimal; reason: string } {
  const n = input.countedCash
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 99999999.99 || new Prisma.Decimal(String(n)).decimalPlaces() > 2) {
    throw new BadRequestError('El monto debe ser de $0 a $99,999,999.99, con máximo 2 decimales', 'CASH_COUNT_INVALID_AMOUNT')
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < 3 || reason.length > 300) {
    throw new BadRequestError('Escribe el motivo de la corrección (de 3 a 300 caracteres)', 'CASH_COUNT_INVALID_REASON')
  }
  return { countedCash: new Prisma.Decimal(String(n)), reason }
}

export function computeCountCorrection(input: { countedBefore: DecimalLike; countedAfter: Prisma.Decimal; expectedAmount: number }) {
  const { countedAfter } = input
  if (countedAfter.equals(dec(input.countedBefore))) {
    throw new BadRequestError('Es el mismo monto que ya tiene el corte', 'CASH_COUNT_SAME')
  }
  const differenceAfter = countedAfter.minus(new Prisma.Decimal(input.expectedAmount.toString())).toDecimalPlaces(2)
  if (differenceAfter.abs().greaterThan(MAX_AMOUNT)) {
    throw new BadRequestError('El monto es demasiado grande para un corte', 'CASH_COUNT_OVERFLOW')
  }
  return { countedAfter, differenceAfter }
}

const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })
export function describeDifference(pesos: number): string {
  if (pesos === 0) return 'Cuadró'
  return `${pesos > 0 ? 'Sobrante' : 'Faltante'} ${mxn.format(Math.abs(pesos))}`
}
