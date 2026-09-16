/**
 * S4 del checkpoint 1 (webhook como primer confirmador, Codex 13-sep-2026): WORKER PROPIO para los eventos PENDING de
 * AngelPay — no el vigía de 30 s, que usa un `isRunning` en memoria y corre en serie (no excluye otra instancia y una
 * pasada lenta retrasa las siguientes). Mismo patrón que `PaymentEffect` y el outbox del kiosco:
 *  · selección y claim ATÓMICOS en una sola sentencia (`FOR UPDATE SKIP LOCKED`), lote acotado, orden estable;
 *  · lease recuperable (`leaseUntil`) y token de dueño (`claimToken`): las escrituras finales sólo valen con el token
 *    vigente (`reconciliarEventoPendiente` recibe el token y lo pone en el `where`);
 *  · reintentos espaciados (backoff exponencial, tope 1 h): los eventos sin vínculo o con discrepancia no monopolizan;
 *  · exclusión frente al receptor inmediato: un evento nace con `nextAttemptAt` 60 s en el futuro (RECEIVER_FIRST_WINDOW_MS);
 *  · fallos agotados VISIBLES y recuperables: `ERROR/RETRIES_EXHAUSTED` conserva la fila y no toca la solicitud —
 *    nunca se convierte en «no cobrado»; volverla a PENDING con `attempts: 0` la reencola.
 * 🔴 El lease NO sustituye la idempotencia financiera: dos workers sobre el mismo evento acaban en el MISMO registrador
 * (S0), que devuelve el ganador en vez de crear otro Payment. Los eventos legacy (`nextAttemptAt` NULL, anteriores a
 * este worker) no se tocan: siguen siendo del backfill de siempre.
 */
import { randomUUID } from 'crypto'
import { Prisma, PrismaClient, ProviderEventLog } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import logger from '@/config/logger'
import type { AngelPayWebhookPayload } from './angelpay-webhook.service'

export const ANGELPAY_EVENT_LEASE_MS = 120_000
export const ANGELPAY_EVENT_MAX_ATTEMPTS = 40
export const RETRIES_EXHAUSTED = 'RETRIES_EXHAUSTED'
export const RECEIVER_MERCHANT_UNKNOWN = 'RECEIVER_MERCHANT_UNKNOWN'

export type AngelPayEventClaim = {
  id: string
  eventId: string
  payload: unknown
  venueId: string | null
  attempts: number
  claimToken: string
  leaseUntil: Date
}

/** 2 min, 4, 8, 16, 32, 64 → tope 1 h. Espaciado para que lo que no tiene vínculo no monopolice los lotes. */
export function backoffPendiente(attempts: number): number {
  return Math.min(3_600_000, 120_000 * 2 ** Math.max(0, Math.min(attempts - 1, 6)))
}

export async function claimPendingAngelPayEvents(input: { now: Date; limit?: number; db?: PrismaClient }): Promise<AngelPayEventClaim[]> {
  const db = input.db ?? prisma
  const limit = Number.isFinite(input.limit) ? Math.min(25, Math.max(1, Math.floor(input.limit!))) : 25
  const token = randomUUID()
  const leaseUntil = new Date(input.now.getTime() + ANGELPAY_EVENT_LEASE_MS)
  // El lote se elige en orden (lo más antiguo primero) y se reclama de una vez; el `RETURNING` de un UPDATE … FROM no conserva
  // ese orden (depende del plan: con dos filas puede salir invertido), así que la selección final vuelve a ordenar lo reclamado —
  // el worker procesa los claims en el orden que devuelve esta consulta.
  const rows = await db.$queryRaw<ProviderEventLog[]>(Prisma.sql`
    WITH picked AS (
      SELECT id FROM "ProviderEventLog"
      WHERE provider = 'PAYMENT_PROCESSOR' AND status = 'PENDING' AND type = 'send_transaction'
        AND "eventId" LIKE 'angelpay-%'
        AND "nextAttemptAt" IS NOT NULL AND "nextAttemptAt" <= ${utcTs(input.now)}
        AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${utcTs(input.now)})
      ORDER BY "nextAttemptAt", "createdAt", id
      LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ),
    reclamados AS (
      UPDATE "ProviderEventLog" e SET
        status = CASE WHEN e.attempts >= ${ANGELPAY_EVENT_MAX_ATTEMPTS} THEN 'ERROR'::"EventStatus" ELSE e.status END,
        "errorReason" = CASE WHEN e.attempts >= ${ANGELPAY_EVENT_MAX_ATTEMPTS} THEN ${RETRIES_EXHAUSTED} ELSE e."errorReason" END,
        "processedAt" = CASE WHEN e.attempts >= ${ANGELPAY_EVENT_MAX_ATTEMPTS} THEN ${utcTs(input.now)} ELSE e."processedAt" END,
        attempts = CASE WHEN e.attempts >= ${ANGELPAY_EVENT_MAX_ATTEMPTS} THEN e.attempts ELSE e.attempts + 1 END,
        "claimToken" = CASE WHEN e.attempts >= ${ANGELPAY_EVENT_MAX_ATTEMPTS} THEN NULL ELSE ${token} END,
        "leaseUntil" = CASE WHEN e.attempts >= ${ANGELPAY_EVENT_MAX_ATTEMPTS} THEN NULL ELSE ${utcTs(leaseUntil)} END
      FROM picked WHERE e.id = picked.id RETURNING e.*
    )
    SELECT * FROM reclamados ORDER BY "nextAttemptAt", "createdAt", id
  `)
  const agotados = rows.filter(row => row.status === 'ERROR')
  if (agotados.length > 0) {
    logger.error(
      '🚨 [AngelPay worker] Eventos con los intentos AGOTADOS: quedan ERROR/RETRIES_EXHAUSTED, visibles y recuperables; la solicitud no se toca',
      {
        eventLogIds: agotados.map(row => row.id),
      },
    )
  }
  return rows
    .filter(row => row.status === 'PENDING' && row.claimToken === token)
    .map(row => ({
      id: row.id,
      eventId: row.eventId ?? '',
      payload: row.payload,
      venueId: row.venueId,
      attempts: row.attempts,
      claimToken: token,
      leaseUntil,
    }))
}

/** Devuelve el estado del evento al terminar (o `SKIPPED` si el lease ya no era nuestro). Nunca lanza. */
export async function runClaimedAngelPayEvent(
  claim: AngelPayEventClaim,
  db: PrismaClient = prisma,
): Promise<'PROCESSED' | 'PENDING' | 'ERROR' | 'SKIPPED'> {
  const row = await db.providerEventLog.findFirst({
    where: { id: claim.id, claimToken: claim.claimToken, status: 'PENDING' },
    select: { id: true, eventId: true, payload: true, venueId: true },
  })
  if (!row) return 'SKIPPED'
  const payload = row.payload as unknown as AngelPayWebhookPayload & { _avoqado?: { receivedByMerchantAccountId?: string } }
  const merchantId = payload?._avoqado?.receivedByMerchantAccountId
  const merchant = merchantId
    ? await db.merchantAccount.findFirst({
        where: { id: merchantId, provider: { code: 'ANGELPAY' } },
        select: { id: true, externalMerchantId: true, angelpayUserAccount: { select: { venueId: true } } },
      })
    : null
  if (!merchant) {
    // Sin el merchant del secreto no hay venue ni correlación posible: visible, final, sin tocar nada de dinero.
    await db.providerEventLog.updateMany({
      where: { id: row.id, claimToken: claim.claimToken },
      data: { status: 'ERROR', errorReason: RECEIVER_MERCHANT_UNKNOWN, processedAt: new Date(), claimToken: null, leaseUntil: null },
    })
    return 'ERROR'
  }
  const rawEventId = (row.eventId ?? '').replace(/^angelpay-/, '')
  try {
    const { ordenarIngresosSinCandado, reconciliarEventoPendiente } = await import('./angelpay-webhook.service')
    // Codex R15-1: ANTES de reconciliar, la recuperación de los ingresos sin candado del intento en transacción PROPIA (candado
    // del intento → revalidación del claim → orden de recuperación). Si la espera del candado vence, el evento sigue PENDING.
    await ordenarIngresosSinCandado({ llave: payload?.payload?.integratorReference, eventLogId: row.id, claimToken: claim.claimToken })
    await reconciliarEventoPendiente({
      payload,
      eventLogId: row.id,
      rawEventId,
      merchantAccount: { id: merchant.id, externalMerchantId: merchant.externalMerchantId },
      receiverVenueId: merchant.angelpayUserAccount?.venueId ?? row.venueId ?? null,
      correlationId: `angelpay-worker-${rawEventId}`,
      retryDelaysMs: [0],
      claimToken: claim.claimToken,
    })
  } catch (error) {
    await failClaimedAngelPayEvent(claim, new Date(), error, db)
    return 'PENDING'
  }
  const despues = await db.providerEventLog.findFirst({ where: { id: row.id }, select: { status: true } })
  await db.providerEventLog.updateMany({
    where: { id: row.id, claimToken: claim.claimToken },
    data: {
      claimToken: null,
      leaseUntil: null,
      ...(despues?.status === 'PENDING' ? { nextAttemptAt: new Date(Date.now() + backoffPendiente(claim.attempts)) } : {}),
    },
  })
  return despues?.status ?? 'SKIPPED'
}

export async function failClaimedAngelPayEvent(
  claim: AngelPayEventClaim,
  now: Date,
  error: unknown,
  db: PrismaClient = prisma,
): Promise<boolean> {
  const mensaje = error instanceof Error ? error.message : String(error)
  logger.error('⚠️ [AngelPay worker] El evento falló al reconciliar — sigue PENDING con backoff', {
    eventLogId: claim.id,
    attempts: claim.attempts,
    error: mensaje,
  })
  const result = await db.providerEventLog.updateMany({
    where: { id: claim.id, claimToken: claim.claimToken, status: 'PENDING' },
    data: {
      claimToken: null,
      leaseUntil: null,
      nextAttemptAt: new Date(now.getTime() + backoffPendiente(claim.attempts)),
      // Sin texto arbitrario de excepciones en la fila: puede traer datos de tarjeta del procesador.
      lastError: 'ANGELPAY_EVENT_WORKER_FAILED',
    },
  })
  return result.count === 1
}
