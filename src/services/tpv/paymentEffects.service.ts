import { randomUUID } from 'crypto'
import { PaymentEffect, Prisma, PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'

export type PaymentEffectKind = 'REVIEW' | 'RECEIPT' | 'REFERRAL' | 'COMMISSION' | 'TRANSACTION_COST'
export type PaymentEffectInput = {
  venueId: string
  paymentId: string
  orderId: string | null
  kind: PaymentEffectKind
  dedupeKey: string
  payload: Prisma.InputJsonValue
  /** Codex R4-4: una obligación que su propio registrador va a cumplir en la misma petición puede nacer con el primer intento diferido. */
  nextAttemptAt?: Date
}
export type PaymentEffectClaim = PaymentEffectInput & { id: string; attempts: number; claimToken: string; leaseUntil: Date }
const COMMISSION_REVIEW_REASON = 'COMMISSION_SNAPSHOT_REQUIRES_REVIEW'
const MAX_ATTEMPTS = 6
const LEASE_MS = 120_000

/** Must be invoked from the financial transaction; dedupe never rewrites its snapshot. */
export async function enqueuePaymentEffect(tx: Prisma.TransactionClient, input: PaymentEffectInput): Promise<void> {
  const source = await tx.payment.findFirst({
    where: { id: input.paymentId, venueId: input.venueId, orderId: input.orderId ?? undefined, status: 'COMPLETED' },
    select: { orderId: true },
  })
  if (!source || source.orderId !== input.orderId) throw new Error('PAYMENT_EFFECT_SOURCE_MISMATCH')
  await tx.paymentEffect.createMany({ data: [{ ...input, version: 1 }], skipDuplicates: true })
}

/** Both pending and abandoned work are bounded and claimed atomically across processes. */
export async function claimPaymentEffects(input: { now: Date; limit?: number; db?: PrismaClient }): Promise<PaymentEffectClaim[]> {
  const db = input.db ?? prisma
  const limit = Number.isFinite(input.limit) ? Math.min(25, Math.max(1, Math.floor(input.limit!))) : 25
  // Retry only this entry read. Claim increments attempts and is never blindly retried.
  const pending = await retry(
    () =>
      db.paymentEffect.findFirst({
        where: {
          OR: [
            { status: 'PENDING', nextAttemptAt: { lte: input.now } },
            { status: 'PROCESSING', leaseUntil: { lte: input.now } },
          ],
        },
        select: { id: true },
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'payment-effects.entry' },
  )
  if (!pending) return []
  const token = randomUUID()
  const leaseUntil = new Date(input.now.getTime() + LEASE_MS)
  const rows = await db.$queryRaw<PaymentEffect[]>(Prisma.sql`
    WITH picked AS (
      SELECT id FROM "PaymentEffect"
      WHERE (status = 'PENDING' AND "nextAttemptAt" <= ${utcTs(input.now)})
         OR (status = 'PROCESSING' AND "leaseUntil" <= ${utcTs(input.now)})
      ORDER BY "nextAttemptAt", id
      LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    UPDATE "PaymentEffect" e SET
      status = CASE WHEN e.attempts >= ${MAX_ATTEMPTS} THEN 'DEAD_LETTER' ELSE 'PROCESSING' END,
      attempts = CASE WHEN e.attempts >= ${MAX_ATTEMPTS} THEN e.attempts ELSE e.attempts + 1 END,
      "claimToken" = CASE WHEN e.attempts >= ${MAX_ATTEMPTS} THEN NULL ELSE ${token} END,
      "leaseUntil" = CASE WHEN e.attempts >= ${MAX_ATTEMPTS} THEN NULL ELSE ${utcTs(leaseUntil)} END,
      "lastError" = CASE WHEN e.attempts >= ${MAX_ATTEMPTS} THEN COALESCE(e."lastError", 'LEASE_ATTEMPTS_EXHAUSTED') ELSE e."lastError" END,
      "updatedAt" = ${utcTs(input.now)}
    FROM picked WHERE e.id = picked.id RETURNING e.*
  `)
  return rows
    .filter(row => row.status === 'PROCESSING')
    .map(row => ({
      ...row,
      kind: row.kind as PaymentEffectKind,
      payload: row.payload as Prisma.InputJsonValue,
      claimToken: row.claimToken!,
      leaseUntil: row.leaseUntil!,
    }))
}

/** DB side effects and completion share a transaction. A reclaimed token cannot mutate either. */
export async function runClaimedPaymentEffect(claim: PaymentEffectClaim, db: PrismaClient = prisma): Promise<boolean> {
  const external = await db.paymentEffect.findFirst({
    where: { id: claim.id, claimToken: claim.claimToken, status: 'PROCESSING', kind: { in: ['RECEIPT', 'REFERRAL', 'TRANSACTION_COST'] } },
  })
  if (external) {
    // These existing consumers own their transaction and dedupe. In particular,
    // referral qualification must reread an already-committed PAID order.
    if (external.kind === 'RECEIPT') {
      const { generateDigitalReceipt } = await import('./digitalReceipt.tpv.service')
      await generateDigitalReceipt(external.paymentId)
    } else if (external.kind === 'TRANSACTION_COST') {
      // S2 (Codex P2): costo PENDIENTE de un Payment nacido del webhook. Esperar la marca NO es un fallo: se reprograma
      // sin consumir intentos; el plazo del payload acota la espera y un error REAL sí cuenta y llega a DEAD_LETTER.
      const { settleDeferredTransactionCost } = await import('../payments/deferredTransactionCost.service')
      // Codex R6 (diseño B): la transición a DONE la hace la propia unidad de convergencia, con ESTE token, bajo la fila del
      // Payment; el CAS de abajo la encuentra hecha (count 0 con la fila DONE) y no la repite.
      const listo = await settleDeferredTransactionCost(external.paymentId, external.payload as Record<string, unknown>, new Date(), {
        tipo: 'WORKER',
        effectId: external.id,
        claimToken: claim.claimToken,
      })
      if (!listo) {
        await db.paymentEffect.updateMany({
          where: { id: external.id, claimToken: claim.claimToken, status: 'PROCESSING' },
          data: { status: 'PENDING', nextAttemptAt: new Date(Date.now() + 5 * 60_000), claimToken: null, leaseUntil: null, attempts: 0 },
        })
        return false
      }
    } else if ((external.payload as { operation?: string }).operation === 'REFUND') {
      const { revertQualifiedReferral } = await import('../referrals/referralRefund.service')
      await revertQualifiedReferral({ orderId: external.orderId!, venueId: external.venueId, reason: 'ORDER_REFUNDED' })
    } else {
      const paid = await db.order.findFirst({
        where: { id: external.orderId ?? '', venueId: external.venueId, paymentStatus: 'PAID' },
        select: { id: true },
      })
      if (!paid) throw new Error('REFERRAL_AWAITS_SETTLEMENT')
      const { onOrderPaid } = await import('../referrals/referralQualification.service')
      await onOrderPaid({ orderId: paid.id, venueId: external.venueId })
    }
    // A crash after consumer commit can replay safely; a stale lease cannot mark DONE.
    const completed = await db.paymentEffect.updateMany({
      where: { id: external.id, claimToken: claim.claimToken, status: 'PROCESSING' },
      data: { status: 'DONE', completedAt: new Date(), claimToken: null, leaseUntil: null, lastError: null },
    })
    if (completed.count === 1) return true
    // Codex R6: el costo cierra DONE dentro de su unidad de convergencia (con este mismo token). Sólo cuenta como terminado
    // si la fila quedó DONE de verdad; un lease perdido (otro token) sigue sin poder marcar nada.
    if (external.kind === 'TRANSACTION_COST') {
      const fila = await db.paymentEffect.findUnique({ where: { id: external.id }, select: { status: true } })
      return fila?.status === 'DONE'
    }
    return false
  }
  return db.$transaction(async tx => {
    // Use the same lock order as financial producers (Order before its effect rows).
    if (claim.orderId)
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "Order" WHERE id = ${claim.orderId} AND "venueId" = ${claim.venueId} FOR UPDATE`)
    const [effect] = await tx.$queryRaw<PaymentEffect[]>(Prisma.sql`
      SELECT * FROM "PaymentEffect" WHERE id = ${claim.id} AND "claimToken" = ${claim.claimToken}
      AND status = 'PROCESSING' FOR UPDATE
    `)
    if (!effect) return false
    const payload = effect.payload as Record<string, unknown>
    if (effect.kind === 'REVIEW') {
      const rating = Number(payload.rating)
      const servedById = typeof payload.servedById === 'string' ? payload.servedById : null
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('INVALID_REVIEW_SNAPSHOT')
      if (
        servedById &&
        !(await tx.staffVenue.findFirst({ where: { venueId: effect.venueId, staffId: servedById }, select: { id: true } }))
      ) {
        throw new Error('INVALID_REVIEW_RECIPIENT')
      }
      await tx.review.createMany({
        data: [{ venueId: effect.venueId, paymentId: effect.paymentId, source: 'TPV', overallRating: rating, servedById }],
        skipDuplicates: true,
      })
    } else if (effect.kind === 'COMMISSION') {
      const { applyFrozenCommissionInTx } = await import('../dashboard/commission/commission-calculation.service')
      await applyFrozenCommissionInTx(tx, effect)
    } else {
      throw new Error('UNSUPPORTED_PAYMENT_EFFECT')
    }
    await tx.paymentEffect.update({
      where: { id: effect.id },
      data: { status: 'DONE', completedAt: new Date(), claimToken: null, leaseUntil: null, lastError: null },
    })
    return true
  })
}

export async function failClaimedPaymentEffect(
  claim: PaymentEffectClaim,
  now: Date,
  _error: unknown,
  db: PrismaClient = prisma,
): Promise<boolean> {
  const effect = await db.paymentEffect.findFirst({
    where: { id: claim.id, claimToken: claim.claimToken, status: 'PROCESSING' },
    select: { lastError: true },
  })
  if (!effect) return false
  const result = await db.paymentEffect.updateMany({
    where: { id: claim.id, claimToken: claim.claimToken, status: 'PROCESSING' },
    data: {
      status: claim.attempts >= MAX_ATTEMPTS ? 'DEAD_LETTER' : 'PENDING',
      nextAttemptAt: new Date(now.getTime() + Math.min(3_600_000, 30_000 * 2 ** Math.max(0, claim.attempts - 1))),
      leaseUntil: null,
      claimToken: null,
      // Do not persist arbitrary exception text: SDK/processor errors may contain card data.
      lastError: effect.lastError === COMMISSION_REVIEW_REASON ? COMMISSION_REVIEW_REASON : 'PAYMENT_EFFECT_EXECUTION_FAILED',
    },
  })
  return result.count === 1
}

export async function enqueuePaymentCommissionInTx(tx: Prisma.TransactionClient, paymentId: string): Promise<void> {
  const { freezePaymentCommissionInTx } = await import('../dashboard/commission/commission-calculation.service')
  // Optional policy reads must not abort already-captured money; an actual lost
  // DB connection still fails the financial commit and is recovered by its caller.
  await tx.$executeRawUnsafe('SAVEPOINT payment_commission_snapshot')
  try {
    await freezePaymentCommissionInTx(tx, paymentId, plan => enqueuePaymentEffect(tx, plan))
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT payment_commission_snapshot')
  } catch {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT payment_commission_snapshot')
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { venueId: true, orderId: true } })
    await enqueuePaymentEffect(tx, {
      venueId: payment.venueId,
      paymentId,
      orderId: payment.orderId,
      kind: 'COMMISSION',
      dedupeKey: 'commission:' + paymentId + ':policy-error:v1',
      payload: { policyError: 'COMMISSION_SNAPSHOT_REQUIRES_REVIEW' },
    })
    await tx.paymentEffect.updateMany({
      where: { venueId: payment.venueId, paymentId, dedupeKey: 'commission:' + paymentId + ':policy-error:v1' },
      data: { lastError: COMMISSION_REVIEW_REASON },
    })
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT payment_commission_snapshot')
  }
}

/** Refund money and its deferred reversals commit together under the original Order lock. */
export async function enqueueRefundPaymentEffectsInTx(
  tx: Prisma.TransactionClient,
  refundPaymentId: string,
  originalPaymentId: string,
): Promise<void> {
  const { createRefundCommission } = await import('../dashboard/commission/commission-calculation.service')
  await createRefundCommission(refundPaymentId, originalPaymentId, {
    db: tx,
    sink: async data => {
      const dedupeKey = `commission:${refundPaymentId}:${data.configId}:${data.staffId}:v1`
      await enqueuePaymentEffect(tx, {
        venueId: data.venueId,
        paymentId: refundPaymentId,
        orderId: data.orderId ?? null,
        kind: 'COMMISSION',
        dedupeKey,
        payload: JSON.parse(JSON.stringify(data)),
      })
      return { id: dedupeKey }
    },
  })
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: refundPaymentId }, select: { venueId: true, orderId: true } })
  await enqueuePaymentEffect(tx, {
    venueId: payment.venueId,
    paymentId: refundPaymentId,
    orderId: payment.orderId,
    kind: 'REFERRAL',
    dedupeKey: `referral-refund:${refundPaymentId}:v1`,
    payload: { operation: 'REFUND' },
  })
}
