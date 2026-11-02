import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { notifyCustomerPassUpdated } from '@/services/wallet/notifyPassUpdated.service'
import type { CortesiaPendienteReply } from './cortesia-pendiente.mobile.service'

function object(value: Prisma.JsonValue | undefined): Prisma.JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** Sólo después de resolver la transacción financiera. Patrón best-effort en segundo plano del libro de sellos. */
export function avisarBeneficiosCortesiaPendiente(venueId: string, reply: CortesiaPendienteReply): void {
  if (reply.outcome !== 'APPLIED' && reply.outcome !== 'ALREADY_APPLIED') return
  void avisarDesdeAuditoria(venueId, reply).catch(error => {
    logger.warn('COURTESY_BENEFIT_NOTICE_FAILED', {
      venueId,
      orderId: reply.snapshot.orderId,
      errorName: error instanceof Error ? error.name : 'UNKNOWN',
    })
  })
}

async function avisarDesdeAuditoria(venueId: string, reply: CortesiaPendienteReply): Promise<void> {
  const itemIds = [...new Set(reply.snapshot.lines.map(line => line.id))].sort()
  if (itemIds.length < 1 || itemIds.length > 100) throw new Error('COURTESY_NOTICE_LINE_OVERFLOW')
  const audits = await prisma.activityLog.findMany({
    where: {
      venueId,
      action: 'ORDER_ITEM_COMPED',
      entity: 'OrderItem',
      entityId: { in: itemIds },
      AND: [
        { data: { path: ['orderId'], equals: reply.snapshot.orderId } },
        { data: { path: ['originalPaymentKey'], equals: reply.originalPaymentKey } },
      ],
    },
    select: { data: true },
    orderBy: { id: 'asc' },
    take: 101,
  })
  // No avisar desde una historia truncada como si fuera completa; el fallo queda visible y no toca la respuesta financiera.
  if (audits.length > 100) throw new Error('COURTESY_NOTICE_AUDIT_OVERFLOW')
  let referenceCount = 0
  for (const audit of audits) {
    const benefits = object(audit.data)?.discountBenefits
    if (benefits === undefined) continue
    if (!Array.isArray(benefits)) throw new Error('COURTESY_NOTICE_INVALID_REFERENCES')
    referenceCount += benefits.length
    if (referenceCount > 100) {
      logger.warn('COURTESY_BENEFIT_NOTICE_LIMIT', {
        venueId,
        orderId: reply.snapshot.orderId,
        kind: 'references',
        count: referenceCount,
      })
      return
    }
  }
  const customers = new Set<string>()
  for (const audit of audits) {
    const benefits = object(audit.data)?.discountBenefits
    if (benefits === undefined) continue
    if (!Array.isArray(benefits)) throw new Error('COURTESY_NOTICE_INVALID_REFERENCES')
    for (const benefit of benefits) {
      const data = object(benefit)
      if (!data) throw new Error('COURTESY_NOTICE_INVALID_REFERENCES')
      for (const key of ['loyaltyRefund', 'stampRefund'] as const) {
        const refund = data[key]
        if (refund == null) continue
        const customer = object(refund)?.customerId
        if (typeof customer !== 'string' || !z.string().cuid().safeParse(customer).success)
          throw new Error('COURTESY_NOTICE_INVALID_REFERENCES')
        customers.add(customer)
        if (customers.size > 100) {
          logger.warn('COURTESY_BENEFIT_NOTICE_LIMIT', {
            venueId,
            orderId: reply.snapshot.orderId,
            kind: 'customers',
            count: customers.size,
          })
          return
        }
      }
    }
  }
  for (const customerId of customers) {
    try {
      const result = await notifyCustomerPassUpdated(venueId, customerId)
      if (result.failed) logger.warn('COURTESY_BENEFIT_NOTICE_FAILED', { venueId, orderId: reply.snapshot.orderId, customerId })
    } catch (error) {
      logger.warn('COURTESY_BENEFIT_NOTICE_FAILED', {
        venueId,
        orderId: reply.snapshot.orderId,
        customerId,
        errorName: error instanceof Error ? error.name : 'UNKNOWN',
      })
    }
  }
}
