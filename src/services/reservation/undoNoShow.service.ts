/**
 * D4 — «Sí llegó»: deshacer un «No asistió».
 *
 * Revierte EXACTAMENTE lo que hizo el «No asistió» (`markNoShow` + el trabajo automático), según lo que dejó escrito:
 *   - la clase que se le devolvió (REFUND «No-show refund…») se vuelve a descontar del MISMO saldo, si todavía hay de
 *     dónde (compra ACTIVE, no vencida, con saldo — la regla de `redeemForReservation`);
 *   - la multa anotada y NO cobrada (`noShowFeeAmount` sin `noShowFeeCapturedAt`) se anula;
 *   - el depósito retenido (`FORFEITED`) vuelve a `PAID`.
 * Lo que no se puede revertir solo queda como pendiente para una persona en la corrección.
 *
 * La reserva queda `CHECKED_IN` y nace UNA `ReservationNoShowCorrection` (su `reservationId` es único): es la
 * idempotencia en la base, el rastro y el pendiente con «Marcar resuelto». No abre cuenta (decisión 2 del plan).
 * `VALID_TRANSITIONS` no cambia: NO_SHOW → CHECKED_IN sólo existe aquí.
 */
import { Prisma, PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { NO_SHOW_REFUND_REASON_PREFIX, RESERVATION_INCLUDE } from '@/services/dashboard/reservation.dashboard.service'
import { activityActorFields, actorLabel, venueOrganizationId, type CheckInActor, type CheckInSource } from './checkIn.service'
import { ALIVE_ORDER_EXCLUDED_STATUSES } from './createOrderFromReservation'

export const NO_SHOW_UNDO_NOT_APPLICABLE = 'NO_SHOW_UNDO_NOT_APPLICABLE'
export const NO_SHOW_UNDO_PASS_BOOKING = 'NO_SHOW_UNDO_PASS_BOOKING'

/** El re-descuento de la corrección. Contarlo es lo que impide descontar dos veces. */
const NO_SHOW_UNDO_REASON = 'No-show undo'
/** Depósito que sí pagó la visita. */
const PAID_DEPOSIT = ['PAID', 'FORFEITED']

export type UndoNoShowPending = 'CREDIT_NOT_RECONSUMED' | 'CLASS_UNPAID' | 'FEE_CAPTURED'
export interface UndoNoShowPlan {
  creditToReconsume: number
  clearFee: boolean
  restoreDeposit: boolean
  /** Pesos de la multa que se anula (sólo si `clearFee`); null si no hay. Para que la ventana diga «la multa de $50». */
  feeAmount: number | null
  /** Pesos del depósito que vuelve a ser parte de la visita (sólo si `restoreDeposit`); null si no hay o no se anotó el monto. */
  depositAmount: number | null
  /** Paquete de la clase que se vuelve a descontar (sólo si `creditToReconsume > 0`); con varios, el de menor id de saldo. */
  packName: string | null
  pending: UndoNoShowPending[]
}

type PlanCreditTx = { type: string; quantity: number; reason: string | null; creditItemBalanceId: string | null }
type PlanBalance = { id: string; remainingQuantity: number; purchaseStatus: string; expiresAt: Date | null; packName?: string | null }
type PlanInput = {
  reservation: {
    /** Sólo una reserva de CLASE puede quedar «clase no pagada»; una mesa o una cita no tiene clase que cobrar. */
    classSessionId?: string | null
    depositStatus: string | null
    /** Lo que la reserva guardó al reservar (también «paga en sucursal», con `depositStatus` null). Si existe, manda sobre el precio de hoy. */
    depositAmount?: unknown | null
    noShowFeeAmount: unknown | null
    noShowFeeCapturedAt: Date | null
    /** Sin `depositAmount`: una clase cuyo producto cuesta $0 o menos hoy no se debe. Sin producto no se sabe ⇒ no es gratis. */
    product?: { price: unknown } | null
  }
  /** Hay una venta VIVA ligada a la reserva ya cobrada (PAID o PARTIAL): «Inscribir y cobrar» del POS. */
  paidOrder?: boolean
  creditTxs: PlanCreditTx[]
  balances: PlanBalance[]
  now: Date
}

/** Por saldo: Σ devoluciones del «No asistió» − Σ re-descuentos ya hechos. Sólo los que siguen debiendo (> 0). */
function owedByBalance(creditTxs: PlanCreditTx[]): Map<string, number> {
  const owed = new Map<string, number>()
  for (const t of creditTxs) {
    if (!t.creditItemBalanceId) continue
    const noShowRefund = t.type === 'REFUND' && (t.reason ?? '').startsWith(NO_SHOW_REFUND_REASON_PREFIX)
    const undo = t.type === 'REDEEM' && t.reason === NO_SHOW_UNDO_REASON // quantity negativa
    if (noShowRefund || undo) owed.set(t.creditItemBalanceId, (owed.get(t.creditItemBalanceId) ?? 0) + t.quantity)
  }
  for (const [id, n] of owed) if (n <= 0) owed.delete(id)
  return owed
}

/** Decimal de Prisma (o número) → número con 2 decimales; null si no hay monto. Sólo para mostrar: nada se suma con esto. */
const pesos = (v: unknown): number | null => (v == null ? null : Math.round(Number(v) * 100) / 100)

function computePlan({ reservation: r, paidOrder, creditTxs, balances, now }: PlanInput) {
  // En orden de id de saldo: así «el primer paquete» no depende del orden de las transacciones.
  const takes = [...owedByBalance(creditTxs)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, owed]) => {
      const b = balances.find(x => x.id === id)
      const usable = b && b.purchaseStatus === 'ACTIVE' && !(b.expiresAt && b.expiresAt < now) ? Math.max(0, b.remainingQuantity) : 0
      return { id, owed, take: Math.min(owed, usable) }
    })
  const pending: UndoNoShowPending[] = []
  if (takes.some(t => t.take < t.owed)) pending.push('CREDIT_NOT_RECONSUMED')
  // Una clase se paga con paquete, con depósito o con una venta en caja; una de $0 no se debe. Si no, «cóbrala en caja».
  // «De $0» lo dice primero lo que la reserva guardó al reservar (`depositAmount`, p. ej. «paga en sucursal» con
  // `depositStatus` null), no el catálogo de hoy (Codex r4 #1).
  // ponytail: sin monto guardado, el precio de HOY del producto es la única señal: un cambio de precio entre reservar y
  // corregir puede equivocar el aviso. El arreglo de raíz es guardar el precio en la reserva al reservar.
  const free = r.depositAmount != null ? Number(r.depositAmount) <= 0 : r.product != null && Number(r.product.price) <= 0
  const paid = creditTxs.some(t => t.type === 'REDEEM') || PAID_DEPOSIT.includes(r.depositStatus ?? '') || paidOrder || free
  if (r.classSessionId && !paid) pending.push('CLASS_UNPAID')
  if (r.noShowFeeCapturedAt) pending.push('FEE_CAPTURED')
  const clearFee = r.noShowFeeAmount != null && !r.noShowFeeCapturedAt
  const restoreDeposit = r.depositStatus === 'FORFEITED'
  const taken = takes.filter(t => t.take > 0)
  const plan: UndoNoShowPlan = {
    creditToReconsume: takes.reduce((s, t) => s + t.take, 0),
    clearFee,
    restoreDeposit,
    feeAmount: clearFee ? pesos(r.noShowFeeAmount) : null,
    depositAmount: restoreDeposit ? pesos(r.depositAmount) : null,
    packName: (taken[0] && balances.find(b => b.id === taken[0].id)?.packName) || null,
    pending,
  }
  return { plan, takes: taken }
}

/** Qué revertiría la corrección, sin escribir nada. */
export function planUndoNoShow(input: PlanInput): UndoNoShowPlan {
  return computePlan(input).plan
}

type Client = Prisma.TransactionClient | PrismaClient

/** Transacciones de clases de la reserva y los saldos que se deben re-descontar (con `FOR UPDATE` si `lock`). */
async function readCredits(client: Client, venueId: string, reservationId: string, lock: boolean) {
  // ponytail: take 100 — una reserva junta 1 REDEEM, sus devoluciones y a lo más 1 re-descuento; 100 no se alcanza.
  const creditTxs = await client.creditTransaction.findMany({
    where: { venueId, reservationId },
    select: { type: true, quantity: true, reason: true, creditItemBalanceId: true },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })
  const ids = [...owedByBalance(creditTxs).keys()].sort()
  if (ids.length === 0) return { creditTxs, rows: [], balances: [] }
  // En orden de id: siempre el mismo orden de candados, después del de la reserva (como la devolución de `markNoShow`).
  if (lock) await client.$queryRaw`SELECT id FROM "CreditItemBalance" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
  const rows = await client.creditItemBalance.findMany({
    where: { id: { in: ids }, creditPackPurchase: { venueId } },
    select: {
      id: true,
      remainingQuantity: true,
      creditPackPurchaseId: true,
      // Una sola lectura: el nombre del paquete viaja con el saldo (sin consulta aparte).
      creditPackPurchase: { select: { status: true, expiresAt: true, customerId: true, creditPack: { select: { name: true } } } },
    },
    take: ids.length,
  })
  const balances = rows.map(b => ({
    id: b.id,
    remainingQuantity: b.remainingQuantity,
    purchaseStatus: b.creditPackPurchase.status as string,
    expiresAt: b.creditPackPurchase.expiresAt,
    packName: b.creditPackPurchase.creditPack.name,
  }))
  return { creditTxs, rows, balances }
}

/**
 * ¿Se cobró la clase en caja? Una venta VIVA ligada a la reserva (el criterio del índice `Order_reservationId_alive_key`:
 * hay a lo más una) pagada o con abono. Sólo se pregunta para una clase: lo demás no puede quedar «clase no pagada».
 */
async function hasPaidOrder(client: Client, venueId: string, reservationId: string, classSessionId: string | null) {
  if (!classSessionId) return false
  const order = await client.order.findFirst({
    where: { venueId, reservationId, status: { notIn: ALIVE_ORDER_EXCLUDED_STATUSES }, paymentStatus: { in: ['PAID', 'PARTIAL'] } },
    select: { id: true },
  })
  return order != null
}

function notApplicable(status: string) {
  return new ConflictError(`La reservacion esta en estado ${status}: «Sí llegó» solo corrige un «No asistió»`, NO_SHOW_UNDO_NOT_APPLICABLE)
}
async function assertNotPassBooking(client: Client, reservationId: string) {
  if (await client.aggregatorBooking.findUnique({ where: { reservationId }, select: { id: true } })) {
    throw new ConflictError('Esta reserva vino de un pase (TotalPass/Wellhub); corrígela desde su app', NO_SHOW_UNDO_PASS_BOOKING)
  }
}

/**
 * Para la ventana de confirmación: sólo lee (sin `FOR UPDATE`). Con los mismos 409 que el POST: si no es NO_SHOW
 * (también una llegada ya corregida; sólo el POST contesta ALREADY_UNDONE) o si vino de un pase.
 */
export async function previewUndoNoShow(client: Client, venueId: string, reservationId: string, now: Date): Promise<UndoNoShowPlan> {
  const r = await client.reservation.findFirst({
    where: { id: reservationId, venueId },
    select: {
      status: true,
      classSessionId: true,
      depositStatus: true,
      depositAmount: true,
      noShowFeeAmount: true,
      noShowFeeCapturedAt: true,
      product: { select: { price: true } },
    },
  })
  if (!r) throw new NotFoundError('Reservacion no encontrada')
  if (r.status !== 'NO_SHOW') throw notApplicable(r.status)
  await assertNotPassBooking(client, reservationId)
  const { creditTxs, balances } = await readCredits(client, venueId, reservationId, false)
  const paidOrder = await hasPaidOrder(client, venueId, reservationId, r.classSessionId)
  return planUndoNoShow({ reservation: r, paidOrder, creditTxs, balances, now })
}

export interface UndoNoShowCommand {
  reservationId: string
  venueId: string
  actor: CheckInActor
  source: CheckInSource | 'MCP'
  now: Date
  /** Hora del toque del kiosco; a mano es la hora de la corrección (`now`). */
  arrivedAt?: Date
  reason?: string
}

export interface UndoNoShowResult {
  outcome: 'UNDONE' | 'ALREADY_UNDONE'
  reservation: unknown
  plan: UndoNoShowPlan
  correction: { id: string; pending: string[]; resolvedAt: Date | null }
}

/**
 * Aplica la corrección dentro de la transacción del caller.
 *
 * 🔴 Esa transacción debe ser READ COMMITTED (el default de `prisma.$transaction`): cada lectura después del candado ve
 * lo que la devolución o la retención de `markNoShow` ya confirmaron. En REPEATABLE READ la foto se tomaría antes de
 * esperar el candado y no vería una devolución recién escrita.
 *
 *   NO_SHOW                       → CHECKED_IN + corrección (UNDONE)
 *   CHECKED_IN con corrección     → la misma, sin escribir (ALREADY_UNDONE)
 *   CHECKED_IN sin corrección y el resto → 409 NO_SHOW_UNDO_NOT_APPLICABLE
 *   reserva de un pase            → 409 NO_SHOW_UNDO_PASS_BOOKING
 */
export async function undoNoShow(tx: Prisma.TransactionClient, cmd: UndoNoShowCommand): Promise<UndoNoShowResult> {
  const { reservationId, venueId, actor, source, now } = cmd

  // 🔴 El candado de la reserva va PRIMERO: la retención del depósito, la multa y la devolución de la clase de
  // `markNoShow` sólo escriben si la fila sigue en NO_SHOW bajo este mismo candado; o ya escribieron y aquí se ven, o
  // esperan y ya no escriben. Después, los saldos (en orden de id): el mismo orden que la devolución.
  const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, status FROM "Reservation" WHERE id = ${reservationId} AND "venueId" = ${venueId} FOR UPDATE`
  if (locked.length === 0) throw new NotFoundError('Reservacion no encontrada')

  const current = await tx.reservation.findFirst({
    where: { id: reservationId, venueId },
    include: { product: { select: { price: true } } },
  })
  if (!current) throw new NotFoundError('Reservacion no encontrada')
  const existing = await tx.reservationNoShowCorrection.findUnique({ where: { reservationId } })

  if (current.status === 'CHECKED_IN' && existing) {
    const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: RESERVATION_INCLUDE })
    return {
      outcome: 'ALREADY_UNDONE',
      reservation,
      plan: existing.plan as unknown as UndoNoShowPlan,
      correction: { id: existing.id, pending: existing.pending, resolvedAt: existing.resolvedAt },
    }
  }
  if (current.status !== 'NO_SHOW') throw notApplicable(current.status)
  if (existing) throw new ConflictError('Esta reservacion ya se corrigio una vez', NO_SHOW_UNDO_NOT_APPLICABLE)
  await assertNotPassBooking(tx, reservationId)

  const { creditTxs, rows, balances } = await readCredits(tx, venueId, reservationId, true)
  const paidOrder = await hasPaidOrder(tx, venueId, reservationId, current.classSessionId)
  const { plan, takes } = computePlan({ reservation: current, paidOrder, creditTxs, balances, now })

  const entries = Array.isArray(current.statusLog) ? (current.statusLog as Prisma.JsonArray) : []
  const statusLog = [
    ...entries,
    {
      status: 'CHECKED_IN',
      at: now.toISOString(),
      by: actorLabel(actor),
      source,
      correctionOf: 'NO_SHOW',
      ...(cmd.reason ? { reason: cmd.reason } : {}),
    },
  ]
  // CAS (con el candado puesto no puede perder; queda como red).
  const cas = await tx.reservation.updateMany({
    where: { id: reservationId, venueId, status: 'NO_SHOW' },
    data: {
      status: 'CHECKED_IN',
      noShowAt: null,
      checkedInAt: cmd.arrivedAt ?? now,
      statusLog,
      ...(plan.clearFee ? { noShowFeeAmount: null } : {}),
      ...(plan.restoreDeposit ? { depositStatus: 'PAID' as const } : {}),
    },
  })
  if (cas.count === 0) throw new ConflictError('La reservacion cambio mientras se corregia', NO_SHOW_UNDO_NOT_APPLICABLE)

  if (takes.length > 0) {
    // `CreditTransaction.createdById` apunta a StaffVenue; el kiosco no tiene.
    const createdById =
      actor.type === 'HUMAN'
        ? ((await tx.staffVenue.findFirst({ where: { staffId: actor.staffId, venueId }, select: { id: true } }))?.id ?? null)
        : null
    for (const t of takes) {
      const row = rows.find(r => r.id === t.id)!
      await tx.creditItemBalance.update({ where: { id: t.id }, data: { remainingQuantity: { decrement: t.take } } })
      await tx.creditTransaction.create({
        data: {
          venueId,
          customerId: row.creditPackPurchase.customerId,
          creditPackPurchaseId: row.creditPackPurchaseId,
          creditItemBalanceId: t.id,
          type: 'REDEEM',
          quantity: -t.take,
          reservationId,
          reason: NO_SHOW_UNDO_REASON,
          createdById,
        },
      })
      const left = await tx.creditItemBalance.count({
        where: { creditPackPurchaseId: row.creditPackPurchaseId, remainingQuantity: { gt: 0 } },
      })
      if (left === 0) {
        await tx.creditPackPurchase.updateMany({ where: { id: row.creditPackPurchaseId, status: 'ACTIVE' }, data: { status: 'EXHAUSTED' } })
      }
    }
  }

  const correction = await tx.reservationNoShowCorrection.create({
    data: {
      venueId,
      reservationId,
      source,
      actorStaffId: actor.type === 'HUMAN' ? actor.staffId : null,
      plan: { ...plan },
      pending: plan.pending,
    },
  })

  const organizationId = await venueOrganizationId(tx, venueId)
  await tx.activityLog.create({
    data: {
      ...activityActorFields(actor, organizationId),
      venueId,
      action: 'RESERVATION_NO_SHOW_UNDONE',
      entity: 'Reservation',
      entityId: reservationId,
      data: {
        from: 'NO_SHOW',
        to: 'CHECKED_IN',
        confirmationCode: current.confirmationCode,
        source,
        reason: cmd.reason ?? null,
        correctionId: correction.id,
        ...plan,
      },
    },
  })

  logger.info(
    `↩️ [NO_SHOW_UNDO] ${current.confirmationCode} NO_SHOW → CHECKED_IN source=${source} by=${actorLabel(actor)} ` +
      `credits=${plan.creditToReconsume} fee=${plan.clearFee} deposit=${plan.restoreDeposit} pending=${plan.pending.join(',') || '-'}`,
  )

  const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: RESERVATION_INCLUDE })
  return {
    outcome: 'UNDONE',
    reservation,
    plan,
    correction: { id: correction.id, pending: correction.pending, resolvedAt: correction.resolvedAt },
  }
}

/** «Marcar resuelto»: cierra el pendiente con quién, cuándo y una nota. Repetirlo devuelve la fecha de la primera vez. */
export async function resolveNoShowCorrection(
  venueId: string,
  reservationId: string,
  staffId: string,
  note?: string,
  source?: CheckInSource | 'MCP',
): Promise<{ resolvedAt: Date }> {
  const resolvedAt = new Date()
  return prisma.$transaction(async tx => {
    const { count } = await tx.reservationNoShowCorrection.updateMany({
      where: { venueId, reservationId, resolvedAt: null },
      data: { resolvedAt, resolvedByStaffId: staffId, resolvedNote: note ?? null },
    })
    if (count === 0) {
      const existing = await tx.reservationNoShowCorrection.findFirst({ where: { venueId, reservationId }, select: { resolvedAt: true } })
      if (!existing?.resolvedAt) throw new NotFoundError('Esta reservacion no tiene una correccion de «No asistió»')
      return { resolvedAt: existing.resolvedAt }
    }
    const organizationId = await venueOrganizationId(tx, venueId)
    await tx.activityLog.create({
      data: {
        ...activityActorFields({ type: 'HUMAN', staffId }, organizationId),
        venueId,
        action: 'RESERVATION_NO_SHOW_CORRECTION_RESOLVED',
        entity: 'Reservation',
        entityId: reservationId,
        data: { note: note ?? null, source: source ?? null },
      },
    })
    return { resolvedAt }
  })
}
