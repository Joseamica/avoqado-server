export type PaymentEffectStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'DEAD_LETTER'
export type PaymentEffectListInput = {
  venueId: string
  status?: PaymentEffectStatus
  kind?: 'REVIEW' | 'RECEIPT' | 'REFERRAL' | 'COMMISSION' | 'TRANSACTION_COST'
  paymentId?: string
  limit?: number
  cursor?: string
}

/** Read-only operational visibility. Frozen monetary policy and claim tokens stay private. */
export async function listPaymentEffects(input: PaymentEffectListInput) {
  const limit = Number.isFinite(input.limit) ? Math.min(100, Math.max(1, Math.floor(input.limit!))) : 50
  const where: Prisma.PaymentEffectWhereInput = {
    venueId: input.venueId,
    status: input.status ?? 'PENDING',
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.paymentId ? { paymentId: input.paymentId } : {}),
  }
  let after: Prisma.PaymentEffectWhereInput = {}
  if (input.cursor) {
    const anchor = await prisma.paymentEffect.findFirst({
      // A worker may change status after page one. Its immutable position remains valid.
      where: { venueId: input.venueId, id: input.cursor },
      select: { id: true, createdAt: true },
    })
    if (!anchor) throw new BadRequestError('La página ya no está disponible con estos filtros. Vuelve a consultar desde el inicio.')
    after = { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }] }
  }
  const [rows, total] = await Promise.all([
    prisma.paymentEffect.findMany({
      where: { ...where, ...after },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One lookahead row proves that the next page exists; at most 100 rows are returned.
      take: limit + 1,
      select: {
        id: true,
        venueId: true,
        paymentId: true,
        orderId: true,
        kind: true,
        status: true,
        attempts: true,
        nextAttemptAt: true,
        leaseUntil: true,
        completedAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.paymentEffect.count({ where }),
  ])
  const hasMore = rows.length > limit
  // Codex R4 (P2): los motivos por los que un costo de transacción sigue pendiente son OBLIGACIONES del negocio (configurar
  // la liquidación; acreditar EXPLÍCITAMENTE un cargo cuya tarifa no consta — configurar una tarifa hoy no repara la historia,
  // Codex R9-1/R12-18) — se muestran tal cual; ocultarlos tras «requiere revisión»
  // dejaba al operador sin saber qué hacer.
  const publicErrors = new Set([
    'PAYMENT_EFFECT_EXECUTION_FAILED',
    'LEASE_ATTEMPTS_EXHAUSTED',
    'COMMISSION_SNAPSHOT_REQUIRES_REVIEW',
    'AWAITING_SETTLEMENT_CONFIGURATION',
    'AFFILIATION_PRICING_UNRESOLVED',
    'REFUND_COSTS_CONTINUE_NEXT_RUN',
    'TRANSACTION_COST_FAILED',
    // Codex R6 (i) / R7 (P2): «falta la fila financiera» y «el snapshot de tarifa es ilegible» también son obligaciones
    // del negocio con nombre; taparlas con «requiere revisión» dejaba al operador sin saber qué corregir.
    'VENUE_TRANSACTION_MISSING',
    'INVALID_PRICING_SNAPSHOT',
    'PRICING_CAPTURE_FAILED',
    // Codex R12-3: el método sigue provisional (nacido del webhook) — se espera el registro de la terminal; vencido el plazo,
    // la espera se ESCALA (OVERDUE) en vez de calcular con un método inventado.
    'AWAITING_ACCREDITED_CARD_DATA',
    'AWAITING_ACCREDITED_CARD_DATA_OVERDUE',
  ])
  const items = rows.slice(0, limit).map(row => ({
    ...row,
    lastError: row.lastError && !publicErrors.has(row.lastError) ? 'PAYMENT_EFFECT_REQUIRES_REVIEW' : row.lastError,
  }))
  return { items, total, hasMore, nextCursor: hasMore ? items[items.length - 1].id : null }
}
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
