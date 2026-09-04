import type { PrismaClient } from '@prisma/client'
import { Prisma, ShiftStatus } from '@prisma/client'

import logger from '../../config/logger'

export type CapturedPaymentChannel = 'recordOrderPayment' | 'recordFastPayment' | 'payCashOrder'
export type RefundPaymentChannel = 'recordRefund' | 'issueRefund' | 'createRefund'
export type PaymentShiftReconciliationChannel =
  | CapturedPaymentChannel
  | RefundPaymentChannel
  | 'b4bitWebhook'
  | 'manualPayment'
  | 'posSyncOrder'
  | 'settleOrder'
  | 'settleCustomerBalance'
export type PendingPaymentShiftReason = 'NO_SHIFT' | 'SHIFT_NOT_OPEN' | 'CLAIM_LOST' | 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY'

type PaymentShiftTransaction = Pick<Prisma.TransactionClient, 'shift' | 'activityLog'>
type PaymentShiftSettingsReader = Pick<PrismaClient, 'venueSettings'> | Pick<Prisma.TransactionClient, 'venueSettings'>
type ExistingOrderLockTransaction = Pick<Prisma.TransactionClient, '$queryRaw'>
type ActivityLogReader = Pick<PrismaClient, 'activityLog'> | Pick<Prisma.TransactionClient, 'activityLog'>

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
  /** Los carriles cuya Order ya contó el turno (B4Bit/manual) no vuelven a incrementarla. */
  incrementTotalOrders: boolean
}

/**
 * Lock order global para dinero ligado a una Order durable:
 *
 *   Order → Payment (si el carril necesita serializar uno) → Shift
 *
 * Un carril de orden nueva/sombra puede reclamar Shift antes de insertar la
 * Order porque todavía no existe una fila Order que otro writer pueda poseer.
 * Toda ruta de orden EXISTENTE llama este helper antes de esperar Payment/Shift.
 */
export async function lockExistingOrderForPayment(
  tx: ExistingOrderLockTransaction,
  input: { venueId: string; orderId: string },
): Promise<boolean> {
  // Algunos dobles unitarios históricos sólo implementan los modelos que usa
  // su escenario. El Prisma TransactionClient real siempre expone $queryRaw;
  // los tests de disciplina de locks usan un doble que sí lo implementa y
  // prueban el bloqueo/interleaving de manera explícita.
  if (typeof tx.$queryRaw !== 'function') return false
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "Order"
    WHERE id = ${input.orderId} AND "venueId" = ${input.venueId}
    FOR UPDATE
  `
  return Array.isArray(rows) && rows.length === 1
}

interface RefundAuthorityReconciliationInput {
  venueId: string
  paymentId: string
  expectedOrderId: string | null
  staffId: string | null
  channel: Extract<RefundPaymentChannel, 'recordRefund' | 'issueRefund'>
}

/**
 * Durable, server-owned signal for the requesting venue when refund authority
 * changes between the tenant-scoped pre-read and the transaction locks.
 *
 * ActivityLog has no unique/idempotency key, so this deliberately does not
 * pretend to offer concurrency deduplication. A rare retry can create a second
 * actionable signal; that is safer than suppressing the only evidence of money
 * already returned by a terminal/operator. The payload contains only ids the
 * requester already supplied or observed — never the replacement tenant.
 */
export async function recordRefundAuthorityReconciliation(
  db: Pick<PrismaClient, 'activityLog'>,
  input: RefundAuthorityReconciliationInput,
): Promise<void> {
  await db.activityLog.create({
    data: {
      action: 'REFUND_AUTHORITY_CHANGED',
      entity: 'Payment',
      entityId: input.paymentId,
      staffId: input.staffId,
      venueId: input.venueId,
      data: {
        status: 'PENDING',
        reason: 'TENANT_AUTHORITY_CHANGED',
        channel: input.channel,
        originalPaymentId: input.paymentId,
        expectedOrderId: input.expectedOrderId,
        resolution: 'Verificar la asignación vigente del cobro antes de registrar manualmente el reembolso.',
      },
    },
  })
}

/**
 * Confirma, sin leer el tenant nuevo, que el job server-owned movió esta
 * Order DESPUÉS de la foto tenant-scoped que abrió el flujo de refund.
 *
 * La fila origen `ORDER_VENUE_REASSIGNED` se escribe atómicamente junto con
 * Order+Payment. Filtrar por el venue solicitante y devolver sólo `id` evita
 * convertir esta comprobación en un oracle sobre el destino.
 */
export async function refundAuthorityReassignmentWasRecorded(
  db: ActivityLogReader,
  input: { venueId: string; orderId: string | null; observedAt: Date },
): Promise<boolean> {
  if (!input.orderId) return false
  const marker = await db.activityLog.findFirst({
    where: {
      action: 'ORDER_VENUE_REASSIGNED',
      entity: 'Order',
      entityId: input.orderId,
      venueId: input.venueId,
      createdAt: { gte: input.observedAt },
      data: { path: ['fromVenueId'], equals: input.venueId },
    },
    select: { id: true },
  })
  return marker !== null
}

/**
 * El procesador puede haber capturado dinero antes de que el servidor descubra
 * que la Order ya no pertenece al requester. No se inventa un Payment contra
 * otro tenant: queda una conciliación durable en el venue que hizo la petición.
 * Reusa la acción owner-facing canónica `PAYMENT_WITHOUT_SHIFT`.
 */
export async function recordCapturedPaymentOrderReconciliation(
  db: Pick<PrismaClient, 'activityLog'>,
  input: {
    venueId: string
    orderId: string
    staffId: string | null
    amountPesos: Prisma.Decimal
    tipPesos: Prisma.Decimal
  },
): Promise<void> {
  await db.activityLog.create({
    data: {
      action: 'PAYMENT_WITHOUT_SHIFT',
      entity: 'Order',
      entityId: input.orderId,
      staffId: input.staffId,
      venueId: input.venueId,
      data: {
        status: 'PENDING',
        reason: 'ORDER_AUTHORITY_UNAVAILABLE',
        channel: 'recordOrderPayment',
        paymentId: null,
        orderId: input.orderId,
        amountPesos: input.amountPesos.toFixed(2),
        tipPesos: input.tipPesos.toFixed(2),
        totalPesos: input.amountPesos.plus(input.tipPesos).toFixed(2),
        resolution: 'Verificar la asignación vigente de la orden y registrar manualmente el cobro capturado.',
      },
    },
  })
}

/**
 * Resuelve el gate ANTES de abrir la transacción de dinero. Una lectura fallida
 * nunca puede deshacer un Payment real: conserva el default habilitado que ya
 * usaba B4Bit y deja el fallo observable en logs.
 */
export async function resolvePaymentShiftReconciliationEnabled(db: PaymentShiftSettingsReader, venueId: string): Promise<boolean> {
  try {
    const settings = await db.venueSettings.findUnique({
      where: { venueId },
      select: { enableShifts: true },
    })
    return settings?.enableShifts ?? true
  } catch (error) {
    logger.warn('⚠️ No se pudo leer `enableShifts`; el cobro fuera de turno se registra igual', {
      venueId,
      error: error instanceof Error ? error.message : error,
    })
    return true
  }
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
      ...(input.incrementTotalOrders ? { totalOrders: { increment: 1 } } : {}),
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

/**
 * Status-aware entry point for rails that also persist non-terminal Payment
 * attempts. Keeping this branch inside a tested wrapper lets callers bind the
 * result directly to one canonical call: a compound/conditional initializer
 * can no longer make the structural audit claim provenance it did not execute.
 */
export async function claimShiftForCompletedPayment(
  tx: PaymentShiftTransaction,
  input: ClaimCapturedPaymentShiftInput & { paymentStatus: string },
): Promise<CapturedPaymentShiftClaim | null> {
  if (input.paymentStatus !== 'COMPLETED') return null
  const { paymentStatus: _paymentStatus, ...claimInput } = input
  return claimShiftForCapturedPayment(tx, claimInput)
}

interface ClaimRefundShiftInput {
  venueId: string
  salesRefundPesos: Prisma.Decimal
  tipRefundPesos: Prisma.Decimal
  /** Fuerza no atribuir cuando el total previo no puede clasificarse con seguridad entre venta/propina. */
  forcePendingReason?: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY'
}

/**
 * Reclama el turno para un reembolso sin cruzar el corte temporal `claimedAt`.
 *
 * El candidato incluye `CLOSING` para poder explicar por qué el dinero quedó
 * fuera del corte. Sólo un CAS ganador sobre OPEN autoriza el `shiftId`; el
 * decremento ocurre en ese mismo CAS y nunca reescribe un turno firmado.
 */
export async function claimShiftForRefund(tx: PaymentShiftTransaction, input: ClaimRefundShiftInput): Promise<CapturedPaymentShiftClaim> {
  const candidate = await tx.shift.findFirst({
    where: { venueId: input.venueId, endTime: null },
    orderBy: { startTime: 'desc' },
    select: { id: true, status: true },
  })

  if (input.forcePendingReason) {
    return {
      shiftId: null,
      candidateShiftId: candidate?.id ?? null,
      observedStatus: candidate?.status ?? null,
      pendingReason: input.forcePendingReason,
    }
  }

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
      totalSales: { decrement: input.salesRefundPesos },
      ...(input.tipRefundPesos.isZero() ? {} : { totalTips: { decrement: input.tipRefundPesos } }),
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
  channel: PaymentShiftReconciliationChannel
  amountPesos: Prisma.Decimal
  tipPesos: Prisma.Decimal
  /** Parte del total histórico autorizado que no tiene filas clasificables venta/propina. */
  unclassifiedPriorRefundPesos?: Prisma.Decimal
  reconciliationEnabled: boolean
}

/**
 * Hace visible un Payment que no pudo reclamar turno. Se llama después de crear
 * el Payment, usando el mismo `tx`: un rollback/P2002 borra claim y bitácora
 * juntos, y un reintento idempotente que devuelve el ganador nunca llega aquí.
 */
export async function recordPendingPaymentShiftReconciliation(
  tx: PaymentShiftTransaction,
  input: RecordPendingPaymentShiftReconciliationInput,
): Promise<void> {
  if (!input.claim.pendingReason) return

  if (!input.reconciliationEnabled) return

  await tx.activityLog.create({
    data: {
      action: 'PAYMENT_WITHOUT_SHIFT',
      entity: 'Payment',
      entityId: input.paymentId,
      staffId: input.staffId,
      venueId: input.venueId,
      data: {
        status: 'PENDING',
        reason: input.claim.pendingReason,
        paymentId: input.paymentId,
        orderId: input.orderId,
        channel: input.channel,
        amountPesos: input.amountPesos.toFixed(2),
        tipPesos: input.tipPesos.toFixed(2),
        totalPesos: input.amountPesos.add(input.tipPesos).toFixed(2),
        ...(input.claim.candidateShiftId ? { candidateShiftId: input.claim.candidateShiftId } : {}),
        ...(input.claim.observedStatus ? { observedShiftStatus: input.claim.observedStatus } : {}),
        ...(input.unclassifiedPriorRefundPesos
          ? {
              shiftAttributionStatus: 'PENDING',
              unclassifiedPriorRefundPesos: input.unclassifiedPriorRefundPesos.toFixed(2),
            }
          : {}),
      },
    },
  })
}
