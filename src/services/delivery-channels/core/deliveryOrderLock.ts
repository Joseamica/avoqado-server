import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

export const RESERVA_TTL_MS = 2 * 60 * 1000
export type OperacionDeReparto = 'REMOVE_ITEM' | 'READY' | 'DENY' | 'ACCEPT'

/**
 * Serializa TODO lo que toca un pedido de reparto. Mismo patrón que
 * `terminal-payment.service.ts:1608`: advisory lock de transacción, que Postgres
 * suelta solo al terminar — nunca queda tomado si el proceso muere.
 */
export async function withDeliveryOrderLock<T>(orderId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`delivery-order:${orderId}`}, 0))::text`
      return fn(tx)
    },
    { timeout: 15_000, maxWait: 5_000 },
  )
}

/** 🔴 La reserva lleva TOKEN: un `finally` tardío no puede abrir el pedido que otra operación ya tomó. */
export async function tomarReserva(
  orderId: string,
  op: OperacionDeReparto,
): Promise<{ ok: true; token: string } | { ok: false; ocupadaPor: OperacionDeReparto; desde: Date }> {
  return withDeliveryOrderLock(orderId, async tx => {
    const fila = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { deliveryOpInFlight: true, deliveryOpInFlightAt: true },
    })
    const viva = fila.deliveryOpInFlight && fila.deliveryOpInFlightAt && Date.now() - fila.deliveryOpInFlightAt.getTime() < RESERVA_TTL_MS
    if (viva) {
      return { ok: false as const, ocupadaPor: fila.deliveryOpInFlight as OperacionDeReparto, desde: fila.deliveryOpInFlightAt! }
    }
    if (fila.deliveryOpInFlight) {
      logger.error('🚨 [Delivery] reserva huérfana tomada por otra operación', { orderId, previa: fila.deliveryOpInFlight, nueva: op })
    }
    const token = randomUUID()
    await tx.order.update({ where: { id: orderId }, data: { deliveryOpInFlight: op, deliveryOpInFlightAt: new Date(), deliveryOpToken: token } })
    return { ok: true as const, token }
  })
}

export async function soltarReserva(orderId: string, token: string): Promise<void> {
  const r = await prisma.order.updateMany({
    where: { id: orderId, deliveryOpToken: token },
    data: { deliveryOpInFlight: null, deliveryOpInFlightAt: null, deliveryOpToken: null },
  })
  if (r.count === 0) logger.warn('[Delivery] soltarReserva ignorado: la reserva ya es de otra operación', { orderId })
}
