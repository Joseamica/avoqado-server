import { Prisma, ShiftStatus } from '@prisma/client'

export type CapturedPaymentChannel = 'recordOrderPayment' | 'recordFastPayment' | 'payCashOrder'
export type PendingPaymentShiftReason = 'NO_SHIFT' | 'SHIFT_NOT_OPEN' | 'CLAIM_LOST'

type PaymentShiftTransaction = Pick<Prisma.TransactionClient, 'shift' | 'activityLog'>

export interface CapturedPaymentShiftClaim {
  shiftId: string | null
  candidateShiftId: string | null
  observedStatus: string | null
  pendingReason: PendingPaymentShiftReason | null
}

interface ClaimCapturedPaymentShiftInput {
  venueId: string
  amountPesos: Prisma.Decimal
  tipPesos: Prisma.Decimal
}

/**
 * Resuelve y reclama el turno dentro de la transacción que registra el cobro.
 *
 * El `updateMany` ES el incremento: su filtro toma el candado sólo si la fila
 * todavía pertenece al venue y sigue OPEN/sin fin. Por eso el id devuelto es
 * seguro para estamparse en Order/Payment; un candidato que perdió contra el
 * cierre se conserva únicamente como evidencia de conciliación.
 */
export async function claimShiftForCapturedPayment(
  tx: PaymentShiftTransaction,
  input: ClaimCapturedPaymentShiftInput,
): Promise<CapturedPaymentShiftClaim> {
  const candidate = await tx.shift.findFirst({
    where: { venueId: input.venueId, endTime: null },
    orderBy: { startTime: 'desc' },
    select: { id: true, status: true },
  })

  if (!candidate) {
    return { shiftId: null, candidateShiftId: null, observedStatus: null, pendingReason: 'NO_SHIFT' }
  }

  if (candidate.status !== ShiftStatus.OPEN) {
    return {
      shiftId: null,
      candidateShiftId: candidate.id,
      observedStatus: candidate.status,
      pendingReason: 'SHIFT_NOT_OPEN',
    }
  }

  const claimed = await tx.shift.updateMany({
    where: {
      id: candidate.id,
      venueId: input.venueId,
      status: ShiftStatus.OPEN,
      endTime: null,
    },
    data: {
      totalSales: { increment: input.amountPesos },
      totalTips: { increment: input.tipPesos },
      totalOrders: { increment: 1 },
    },
  })

  if (claimed.count === 1) {
    return {
      shiftId: candidate.id,
      candidateShiftId: candidate.id,
      observedStatus: candidate.status,
      pendingReason: null,
    }
  }

  return {
    shiftId: null,
    candidateShiftId: candidate.id,
    observedStatus: candidate.status,
    pendingReason: 'CLAIM_LOST',
  }
}

interface RecordPendingPaymentShiftReconciliationInput {
  claim: CapturedPaymentShiftClaim
  venueId: string
  paymentId: string
  orderId: string | null
  staffId: string | null
  channel: CapturedPaymentChannel
  amountPesos: Prisma.Decimal
  tipPesos: Prisma.Decimal
}

/**
 * Hace visible un cobro que no pudo reclamar turno. Se llama después de crear
 * el Payment, usando el mismo `tx`: un rollback/P2002 borra claim y bitácora
 * juntos, y un reintento idempotente que devuelve el ganador nunca llega aquí.
 */
export async function recordPendingPaymentShiftReconciliation(
  tx: PaymentShiftTransaction,
  input: RecordPendingPaymentShiftReconciliationInput,
): Promise<void> {
  if (!input.claim.pendingReason) return

  await tx.activityLog.create({
    data: {
      action: 'PAYMENT_PENDING_POST_CLOSE_RECONCILIATION',
      entity: 'Payment',
      entityId: input.paymentId,
      staffId: input.staffId,
      venueId: input.venueId,
      data: {
        status: 'PENDING',
        reason: input.claim.pendingReason,
        candidateShiftId: input.claim.candidateShiftId,
        observedShiftStatus: input.claim.observedStatus,
        paymentId: input.paymentId,
        orderId: input.orderId,
        channel: input.channel,
        amountPesos: input.amountPesos.toFixed(2),
        tipPesos: input.tipPesos.toFixed(2),
      },
    },
  })
}
