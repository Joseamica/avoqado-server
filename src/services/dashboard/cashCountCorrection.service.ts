import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { ConflictError, NotFoundError } from '../../errors/AppError'
import { lockShiftLifecycleForVenue } from '../shared/shiftLifecycleLock'
import { calculateExpectedAmount } from '../mobile/cash-drawer.mobile.service'
import { writeLegacyActivityAuditTx } from '../activityAudit.service'
import {
  DecimalLike,
  MAX_CORRECTIONS_PER_SHIFT,
  computeCountCorrection,
  countCorrectionBlock,
  countCorrectionConflict,
  normalizeCorrectionInput,
} from './cashCountCorrection.rules'

/**
 * «Corregir conteo» (spec 2026-11-10, §5): el gerente corrige el efectivo contado de un corte YA cerrado y contado.
 *
 * Turno (`Shift`) y caja física (`CashDrawerSession`) cambian juntos, en UNA transacción. El resultado se recalcula con los
 * movimientos de la caja, con la MISMA fórmula con que el movimiento tardío reescribe un corte cerrado
 * (`createEventUnderSessionLock`, `cashDrawerPosting.ts`): así una corrección y un tardío posterior nunca se contradicen.
 *
 * Candados, en el orden que ya usa el código (evita el 40P01): ciclo del negocio (advisory) → fila de la caja → fila del turno.
 * Con la caja tomada, ningún movimiento tardío se mete entre la lectura y la escritura; con el ciclo tomado, `deleteShift`
 * (turno → caja por su `SET NULL`) espera en vez de cruzarse.
 */

export interface CorrectCashCountInput {
  venueId: string
  shiftId: string
  countedCash: unknown
  reason: unknown
  /** El conteo que el gerente estaba viendo. */
  expectedCurrentCount: number
  /** La diferencia que la vista previa le enseñó. */
  expectedResultingDifference: number
  /** Cuántas correcciones llevaba el corte (otro gerente pudo corregir dos veces y dejar el mismo número). */
  expectedCorrectionCount: number
  staffId: string
  source: 'DASHBOARD' | 'MCP'
  provenance?: Record<string, string>
}

export interface CashCountCorrectionResult {
  shiftId: string
  cashDrawerSessionId: string
  countedBefore: number
  countedAfter: number
  /** El `cashDifference` del turno (lo que enseña el resumen del corte), no el `overShort` de la caja. */
  differenceBefore: number
  differenceAfter: number
  expectedAmount: number
  correctionsBefore: number
}

const changed = () => new ConflictError('Alguien cambió este conteo mientras lo corregías; recarga la página', 'CASH_COUNT_CHANGED')
const tooMany = () => new ConflictError('Este corte ya tiene 50 correcciones; pide ayuda a soporte', 'CASH_COUNT_TOO_MANY')

const dec = (v: DecimalLike) => new Prisma.Decimal(v.toString())
/** Igualdad de dinero a 2 decimales contra lo que mandó el cliente; un valor que no es número finito nunca coincide. */
const sameMoney = (a: DecimalLike, b: number) =>
  typeof b === 'number' && Number.isFinite(b) && dec(a).toDecimalPlaces(2).equals(dec(b).toDecimalPlaces(2))

const SHIFT_FACTS = { status: true, originSystem: true, cashDeclared: true, cashDifference: true } as const
const DRAWER_FACTS = {
  id: true,
  status: true,
  actualAmount: true,
  overShort: true,
  startingAmount: true,
  events: { select: { type: true, amount: true } },
} as const

/**
 * Pasos 3–5: lee el corte y aplica las reglas. Con `lock` (la corrección), toma la fila de la caja ANTES de leer sus montos y
 * movimientos, y relee el turno bajo ese candado: un tardío pudo reescribir su `cashDifference` justo antes. Sin `lock` (la
 * vista previa) sólo lee. Nunca escribe montos.
 */
async function readCorte(db: Prisma.TransactionClient, venueId: string, shiftId: string, lock: boolean) {
  const readShift = () => db.shift.findFirst({ where: { id: shiftId, venueId }, select: SHIFT_FACTS })
  let shift = await readShift()
  if (!shift) throw new NotFoundError('Corte no encontrado')

  // La caja se busca por su liga explícita al turno, nunca por horario.
  const linked = await db.cashDrawerSession.findFirst({ where: { venueId, shiftId }, select: { id: true } })
  if (linked && lock) {
    // El mismo candado de fila con que el movimiento tardío toma la caja (`createEventUnderSessionLock`).
    await db.cashDrawerSession.updateMany({ where: { id: linked.id, venueId }, data: { updatedAt: new Date() } })
  }
  const drawer = linked && (await db.cashDrawerSession.findFirst({ where: { id: linked.id, venueId, shiftId }, select: DRAWER_FACTS }))
  if (linked && lock) {
    shift = await readShift()
    if (!shift) throw new NotFoundError('Corte no encontrado')
  }

  const block = countCorrectionBlock(shift, drawer && { linkedToShift: true, ...drawer })
  if (block) throw countCorrectionConflict(block)
  // `countCorrectionBlock` ya garantizó: caja ligada y cerrada, conteo, las dos diferencias firmadas y caja = turno.
  return { drawer: drawer!, countedBefore: shift.cashDeclared!, differenceBefore: shift.cashDifference! }
}

type Corte = Awaited<ReturnType<typeof readCorte>>

const countCorrections = (db: Prisma.TransactionClient, venueId: string, shiftId: string) =>
  db.activityLog.count({ where: { venueId, entity: 'Shift', entityId: shiftId, action: 'CASH_COUNT_CORRECTED' } })

/** Paso 8: el esperado sale de los movimientos de la caja; la diferencia, de `computeCountCorrection` (Decimal a 2 decimales). */
function compute(corte: Corte, countedAfter: Prisma.Decimal) {
  const expectedAmount = calculateExpectedAmount({ startingAmount: corte.drawer.startingAmount, events: corte.drawer.events })
  const { differenceAfter } = computeCountCorrection({ countedBefore: corte.countedBefore, countedAfter, expectedAmount })
  return { expectedAmount, differenceAfter }
}

const toResult = (
  shiftId: string,
  corte: Corte,
  correctionsBefore: number,
  countedAfter: Prisma.Decimal,
  { expectedAmount, differenceAfter }: ReturnType<typeof compute>,
): CashCountCorrectionResult => ({
  shiftId,
  cashDrawerSessionId: corte.drawer.id,
  countedBefore: dec(corte.countedBefore).toNumber(),
  countedAfter: countedAfter.toNumber(),
  differenceBefore: dec(corte.differenceBefore).toNumber(),
  differenceAfter: differenceAfter.toNumber(),
  expectedAmount,
  correctionsBefore,
})

/** Lo que guardaría la corrección, sin candados ni escritura. Mismos errores, salvo `CASH_COUNT_CHANGED`. */
export async function previewCashCountCorrection(
  venueId: string,
  shiftId: string,
  countedCash: unknown,
): Promise<CashCountCorrectionResult> {
  // La vista previa no lleva motivo: se valida sólo el monto, con la misma regla que la corrección.
  const { countedCash: countedAfter } = normalizeCorrectionInput({ countedCash, reason: 'vista previa' })
  const corte = await readCorte(prisma, venueId, shiftId, false)
  const correctionsBefore = await countCorrections(prisma, venueId, shiftId)
  if (correctionsBefore >= MAX_CORRECTIONS_PER_SHIFT) throw tooMany()
  return toResult(shiftId, corte, correctionsBefore, countedAfter, compute(corte, countedAfter))
}

export async function correctCashCount(input: CorrectCashCountInput): Promise<CashCountCorrectionResult> {
  const { venueId, shiftId } = input
  // 1. Antes de tocar la base.
  const { countedCash: countedAfter, reason } = normalizeCorrectionInput({ countedCash: input.countedCash, reason: input.reason })

  return prisma.$transaction(async tx => {
    await lockShiftLifecycleForVenue(tx, venueId) // 2.
    const corte = await readCorte(tx, venueId, shiftId, true) // 3–5.

    if (!sameMoney(corte.countedBefore, input.expectedCurrentCount)) throw changed() // 6.
    const correctionsBefore = await countCorrections(tx, venueId, shiftId) // 7.
    if (correctionsBefore !== input.expectedCorrectionCount) throw changed()
    if (correctionsBefore >= MAX_CORRECTIONS_PER_SHIFT) throw tooMany()

    const computed = compute(corte, countedAfter) // 8.
    const { differenceAfter } = computed
    // 9. Un cobro tardío pudo mover el esperado sin mover el conteo: no se guarda un resultado que el gerente no vio.
    if (!sameMoney(differenceAfter, input.expectedResultingDifference)) throw changed()

    // 10. CAS sobre lo leído bajo el candado de la caja.
    const drawerWritten = await tx.cashDrawerSession.updateMany({
      where: { id: corte.drawer.id, venueId, status: 'CLOSED', actualAmount: corte.drawer.actualAmount, overShort: corte.drawer.overShort },
      data: { actualAmount: countedAfter, overShort: differenceAfter },
    })
    if (drawerWritten.count !== 1) throw changed()

    // 11. Si este CAS pierde, al lanzar se deshace también el 10.
    const shiftWritten = await tx.shift.updateMany({
      where: { id: shiftId, venueId, status: 'CLOSED', cashDeclared: corte.countedBefore, cashDifference: corte.differenceBefore },
      data: { cashDeclared: countedAfter, endingCash: countedAfter, cashDifference: differenceAfter },
    })
    if (shiftWritten.count !== 1) throw changed()

    // 12. Dentro de la transacción y sin tragar errores: es el registro que enseña el panel, no un aviso best-effort.
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.staffId,
      venueId,
      action: 'CASH_COUNT_CORRECTED',
      entity: 'Shift',
      entityId: shiftId,
      data: {
        cashDrawerSessionId: corte.drawer.id,
        countedBefore: dec(corte.countedBefore).toFixed(2),
        countedAfter: countedAfter.toFixed(2),
        differenceBefore: dec(corte.differenceBefore).toFixed(2),
        differenceAfter: differenceAfter.toFixed(2),
        expectedAmount: dec(computed.expectedAmount).toFixed(2),
        reason,
        source: input.source,
        ...(input.provenance ? { mcp: input.provenance } : {}),
      },
    })

    return toResult(shiftId, corte, correctionsBefore, countedAfter, computed)
  })
}
