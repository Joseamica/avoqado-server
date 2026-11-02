import { Prisma } from '@prisma/client'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import socketManager from '@/communication/sockets'
import { SocketEventType } from '@/communication/sockets/types'
import { normalizeLegacyActivityActor, preserveUnknownStaffId } from '@/lib/activityAuditActor'
import { revertQualifiedReferral } from '@/services/referrals/referralRefund.service'
import { ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import { HTTP_TYPE, envelopeSchema } from './http-operation.mobile.service'

const effectsSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(['PENDING', 'AUDITED']),
    orderId: z.string(),
    staffId: z.string().nullable(),
    reason: z.string().nullable(),
    tableIds: z.array(z.string()),
    valesSoltados: z.object({ sessionId: z.string(), ticketIds: z.array(z.string()) }).nullable(),
  })
  .strict()
export type CancellationEffects = z.infer<typeof effectsSchema>
type ReceiptKey = { venueId: string; idempotencyKey: string }

function readEffects(row: {
  type: string
  status: string
  staffId: string | null
  resultJson: Prisma.JsonValue
  cancelEffectsJson: Prisma.JsonValue
}) {
  if (row.type !== HTTP_TYPE || row.status !== 'ACKED' || row.cancelEffectsJson === null) return null
  const effects = effectsSchema.parse(row.cancelEffectsJson)
  const receipt = envelopeSchema.parse(row.resultJson)
  if (
    receipt.outcome !== 'APPLIED' ||
    receipt.action !== 'cancelOrder' ||
    receipt.request.refs.orderId !== effects.orderId ||
    receipt.request.originalActorId !== effects.staffId ||
    row.staffId !== effects.staffId
  ) {
    throw new Error('CANCEL_EFFECTS_RECEIPT_MISMATCH')
  }
  return effects
}

/** Sólo completa efectos post-commit: un fallo conserva el pendiente y nunca cambia el recibo público. */
export async function tryDrainCancelledOrderEffects(key: ReceiptKey): Promise<boolean> {
  try {
    const row = await prisma.posSyncIntent.findUnique({
      where: { venueId_idempotencyKey: { venueId: key.venueId, idempotencyKey: key.idempotencyKey } },
    })
    const pending = row && readEffects(row)
    if (!row || !pending) return false
    // Esta función tiene su propio candado Order: nunca llamarla desde la tx de cancelación o del recibo.
    if (pending.phase === 'PENDING')
      await revertQualifiedReferral({ venueId: key.venueId, orderId: pending.orderId, reason: 'ORDER_CANCELLED' })
    const audited = await prisma.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "PosSyncIntent" WHERE id = ${row.id} AND "venueId" = ${key.venueId} FOR UPDATE SKIP LOCKED
      `
      if (locked.length === 0) return null
      const current = await tx.posSyncIntent.findUniqueOrThrow({ where: { id: row.id, venueId: key.venueId } })
      const effects = readEffects(current)
      if (!effects || effects.phase === 'AUDITED') return effects
      const actor = normalizeLegacyActivityActor(effects.staffId, { reason: effects.reason })
      if (actor.staffId) {
        const staff = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Staff" WHERE id = ${actor.staffId} FOR KEY SHARE NOWAIT
        `
        if (staff.length === 0) {
          actor.data = preserveUnknownStaffId(actor.data, actor.staffId)
          actor.staffId = null
        }
      }
      await tx.activityLog.create({
        data: {
          venueId: key.venueId,
          staffId: actor.staffId,
          action: 'ORDER_CANCELLED',
          entity: 'Order',
          entityId: effects.orderId,
          data: actor.data,
          createdAt: current.createdAt,
        },
      })
      if (effects.valesSoltados) {
        const data = { orderId: effects.orderId, motivo: 'ORDEN_CANCELADA_POR_LA_RUTA_GENERAL', ticketIds: effects.valesSoltados.ticketIds }
        await tx.activityLog.create({
          data: {
            venueId: key.venueId,
            staffId: actor.staffId,
            action: 'AREA_TICKET_CHECKOUT_CANCELLED',
            entity: 'AreaTicketCheckoutSession',
            entityId: effects.valesSoltados.sessionId,
            createdAt: current.createdAt,
            data: !actor.staffId && effects.staffId ? preserveUnknownStaffId(data, effects.staffId) : data,
          },
        })
      }
      const next: CancellationEffects = { ...effects, phase: 'AUDITED' }
      await tx.posSyncIntent.update({ where: { id: current.id }, data: { cancelEffectsJson: next } })
      return next
    }, ORDER_LOCK_WAIT_BUDGET)
    if (!audited) return false
    const broadcaster = socketManager.getBroadcastingService()
    if (!broadcaster) return false
    // Una recuperación puede llegar después de reabrir la venta o reutilizar la mesa: nunca emitir el estado viejo.
    const order = await prisma.order.findUnique({ where: { id: audited.orderId, venueId: key.venueId }, select: { status: true } })
    if (!order) return false
    if (!broadcaster.broadcastToVenue(key.venueId, SocketEventType.ORDER_UPDATED, { orderId: audited.orderId, status: order.status }))
      return false
    const tables = audited.tableIds.length
      ? await prisma.table.findMany({
          where: { venueId: key.venueId, id: { in: audited.tableIds } },
          select: {
            id: true,
            number: true,
            status: true,
            currentOrderId: true,
            currentOrder: {
              select: {
                orderNumber: true,
                covers: true,
                servedBy: { select: { id: true, firstName: true, lastName: true } },
              },
            },
          },
          take: audited.tableIds.length,
        })
      : []
    for (const table of tables) {
      if (
        !broadcaster.broadcastToVenue(key.venueId, SocketEventType.TABLE_STATUS_CHANGE, {
          tableId: table.id,
          tableNumber: table.number,
          status: table.status,
          orderId: table.currentOrderId,
          orderNumber: table.currentOrder?.orderNumber ?? null,
          covers: table.currentOrder?.covers ?? null,
          waiter: table.currentOrder?.servedBy ?? null,
        })
      )
        return false
    }
    // Auditoría+AUDITED son un commit; la emisión puede repetirse si se pierde su acuse, la auditoría no.
    const done = await prisma.posSyncIntent.updateMany({
      where: { id: row.id, venueId: key.venueId, cancelEffectsJson: { equals: audited } },
      data: { cancelEffectsJson: Prisma.DbNull },
    })
    return done.count === 1
  } catch (error) {
    logger.warn('[CancelOrderEffects] Efectos pendientes para reintento', {
      ...key,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

let sweepCursor: string | undefined
export async function drainPendingCancellationEffects(): Promise<void> {
  const rows = await retry(
    () =>
      prisma.posSyncIntent.findMany({
        where: { type: HTTP_TYPE, status: 'ACKED', cancelEffectsJson: { not: Prisma.DbNull } },
        select: { id: true, venueId: true, idempotencyKey: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 25,
        ...(sweepCursor ? { cursor: { id: sweepCursor }, skip: 1 } : {}),
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'cancel-order-effects.pending' },
  )
  // Avanzar también tras un fallo evita que 25 pendientes rotos escondan los siguientes.
  sweepCursor = rows.length === 25 ? rows[rows.length - 1].id : undefined
  for (const row of rows) await tryDrainCancelledOrderEffects(row)
}
