/**
 * Job de reasignación automática — Asana 1217556190300772 ("Bait <> Play Telecom").
 *
 * Cuando un promotor de PlayTelecom sale de su tienda a hacer una activación, marca el
 * SIM vendido con la categoría "SIM de Evento". Esa venta se queda hoy atribuida a la
 * tienda del promotor, cuando debería restarse de ahí y contar para un venue separado
 * ("ACTIVACIÓN SLP"). Este job la mueve sola, cada 15 minutos.
 *
 * Misma receta de 4 tablas ya usada a mano en "Cubre Descanso" (73 ventas, 2026-07-07):
 * mover Order.venueId + Payment.venueId + SaleVerification.venueId + SerializedItem.sellingVenueId
 * juntos, transaccional. Payment.shiftId NUNCA se toca — el turno/caja del promotor sigue
 * cerrando en la tienda real; sólo cambia a quién le cuenta la venta para reportes.
 *
 * Spec completa: docs/superpowers/specs/2026-08-20-activacion-slp-sim-evento-design.md
 */

import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { logAction } from '../services/dashboard/activity-log.service'
import { scheduleCron } from '../observability/jobContext'

/**
 * Regla de reasignación: qué categoría, en qué estado de origen, se mueve a qué venue
 * destino (dentro de qué organización, resuelta por NOMBRE — nunca un id fijo, para que
 * el job no truene en un ambiente sin datos de PlayTelecom).
 */
export interface EventVenueReassignmentRule {
  orgName: string
  categoryName: string
  originState: string
  targetVenueSlug: string
}

export const PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES: EventVenueReassignmentRule[] = [
  { orgName: 'PlayTelecom', categoryName: 'SIM de Evento', originState: 'San Luis Potosí', targetVenueSlug: 'activacion-slp' },
  // Agregar aquí la regla de Querétaro cuando exista el venue 'activacion-qro' — una línea, sin tocar el resto del archivo.
]

/**
 * ¿Todos los items de una orden son de la MISMA categoría pedida? Si hay uno solo que no
 * lo sea (otra categoría, o sin categoría — producto no serializado), la orden es "mixta"
 * y NUNCA se reasigna automáticamente (confirmado con Isaac Mayoral, comentario Asana
 * 1217686256927402: se deja para revisión manual).
 */
export function isOrderPureCategoryMatch(categoryNames: Array<string | null>, categoryName: string): boolean {
  if (categoryNames.length === 0) return false
  const target = categoryName.trim().toLowerCase()
  return categoryNames.every(name => name != null && name.trim().toLowerCase() === target)
}

/**
 * Núcleo de la reasignación para UNA regla. Resuelve organización y venue destino por
 * NOMBRE/slug (nunca un id fijo) — si cualquiera de los dos no existe en este ambiente
 * (dev/CI sin datos de PlayTelecom), se salta la regla sin truena. Sólo reasigna una
 * orden si es 100% pura para la categoría de la regla (`isOrderPureCategoryMatch`); una
 * orden mixta se salta y se loguea para revisión manual, nunca se mueve parcialmente.
 *
 * Payment.shiftId NUNCA se toca aquí — sólo Order.venueId + Payment.venueId +
 * SaleVerification.venueId + SerializedItem.sellingVenueId, juntos en una transacción.
 */
export async function reassignEventSimSalesForRule(
  rule: EventVenueReassignmentRule,
): Promise<{ reassigned: number; skippedMixed: number }> {
  const org = await retry(
    () =>
      prisma.organization.findFirst({
        where: { name: { equals: rule.orgName, mode: 'insensitive' } },
        select: { id: true },
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'playtelecom-event-sim-reassignment.findOrg' },
  )
  if (!org) {
    logger.debug(`[PlayTelecom Event SIM Reassignment] Organización "${rule.orgName}" no existe en este ambiente — se salta la regla`)
    return { reassigned: 0, skippedMixed: 0 }
  }

  const targetVenue = await retry(
    () =>
      prisma.venue.findFirst({
        where: { slug: rule.targetVenueSlug, organizationId: org.id },
        select: { id: true },
      }),
    {
      retries: 2,
      initialDelay: 1500,
      shouldRetry: shouldRetryDbConnectionError,
      context: 'playtelecom-event-sim-reassignment.findVenue',
    },
  )
  if (!targetVenue) {
    logger.warn(`[PlayTelecom Event SIM Reassignment] Venue destino "${rule.targetVenueSlug}" no existe todavía — se salta la regla`)
    return { reassigned: 0, skippedMixed: 0 }
  }

  const candidates = await retry(
    () =>
      prisma.serializedItem.findMany({
        where: {
          status: 'SOLD',
          orderItemId: { not: null },
          category: { name: { equals: rule.categoryName, mode: 'insensitive' } },
          sellingVenueId: { not: null },
          NOT: { sellingVenueId: targetVenue.id },
          sellingVenue: { organizationId: org.id, state: { equals: rule.originState, mode: 'insensitive' } },
        },
        select: { orderItemId: true },
      }),
    {
      retries: 2,
      initialDelay: 1500,
      shouldRetry: shouldRetryDbConnectionError,
      context: 'playtelecom-event-sim-reassignment.findCandidates',
    },
  )

  const orderItemIds = candidates.map(c => c.orderItemId).filter((id): id is string => id != null)
  if (orderItemIds.length === 0) return { reassigned: 0, skippedMixed: 0 }

  const orderItemsForCandidates = await prisma.orderItem.findMany({
    where: { id: { in: orderItemIds } },
    select: { orderId: true },
  })
  const orderIds = Array.from(new Set(orderItemsForCandidates.map(oi => oi.orderId)))

  let reassigned = 0
  let skippedMixed = 0

  for (const orderId of orderIds) {
    try {
      const orderItems = await prisma.orderItem.findMany({
        where: { orderId },
        select: { serializedItem: { select: { category: { select: { name: true } } } } },
      })
      const isPure = isOrderPureCategoryMatch(
        orderItems.map(i => i.serializedItem?.category?.name ?? null),
        rule.categoryName,
      )

      if (!isPure) {
        skippedMixed++
        const alreadyFlagged = await prisma.activityLog.findFirst({
          where: { action: 'ORDER_VENUE_REASSIGNMENT_SKIPPED_MIXED', entity: 'Order', entityId: orderId },
          select: { id: true },
        })
        if (!alreadyFlagged) {
          const orderForLog = await prisma.order.findUnique({ where: { id: orderId }, select: { venueId: true } })
          await logAction({
            action: 'ORDER_VENUE_REASSIGNMENT_SKIPPED_MIXED',
            entity: 'Order',
            entityId: orderId,
            venueId: orderForLog?.venueId ?? null,
            staffId: null,
            data: { reason: 'mixed_order_skipped', category: rule.categoryName },
          })
          logger.warn('[PlayTelecom Event SIM Reassignment] Orden mixta detectada, se deja para revisión manual', { orderId })
        } else {
          logger.debug('[PlayTelecom Event SIM Reassignment] Orden mixta ya reportada antes, sigue esperando revisión manual', {
            orderId,
          })
        }
        continue
      }

      const orderBefore = await prisma.order.findUnique({ where: { id: orderId }, select: { venueId: true } })

      await prisma.$transaction(async tx => {
        await tx.order.updateMany({ where: { id: orderId, NOT: { venueId: targetVenue.id } }, data: { venueId: targetVenue.id } })
        await tx.payment.updateMany({ where: { orderId, NOT: { venueId: targetVenue.id } }, data: { venueId: targetVenue.id } })
        await tx.saleVerification.updateMany({
          where: { payment: { orderId }, NOT: { venueId: targetVenue.id } },
          data: { venueId: targetVenue.id },
        })
        await tx.serializedItem.updateMany({ where: { orderItem: { orderId } }, data: { sellingVenueId: targetVenue.id } })
      })

      const auditData = {
        fromVenueId: orderBefore?.venueId ?? null,
        toVenueId: targetVenue.id,
        reason: 'playtelecom_evento_sim',
        category: rule.categoryName,
      }
      await logAction({
        action: 'ORDER_VENUE_REASSIGNED',
        entity: 'Order',
        entityId: orderId,
        venueId: targetVenue.id,
        staffId: null,
        data: auditData,
      })
      if (orderBefore?.venueId) {
        await logAction({
          action: 'ORDER_VENUE_REASSIGNED',
          entity: 'Order',
          entityId: orderId,
          venueId: orderBefore.venueId,
          staffId: null,
          data: auditData,
        })
      }
      reassigned++
    } catch (err) {
      logger.error('[PlayTelecom Event SIM Reassignment] No se pudo reasignar una orden', {
        orderId,
        error: err instanceof Error ? err.message : err,
      })
    }
  }

  return { reassigned, skippedMixed }
}

export async function reassignEventSimSales(
  rules: EventVenueReassignmentRule[] = PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES,
): Promise<void> {
  for (const rule of rules) {
    try {
      const { reassigned, skippedMixed } = await reassignEventSimSalesForRule(rule)
      if (reassigned > 0 || skippedMixed > 0) {
        logger.info(
          `[PlayTelecom Event SIM Reassignment] ${rule.orgName}/${rule.categoryName}: ${reassigned} orden(es) movidas a ${rule.targetVenueSlug}, ${skippedMixed} saltada(s) por mixtas`,
        )
      }
    } catch (err) {
      logger.error('[PlayTelecom Event SIM Reassignment] Regla falló completa', {
        rule,
        error: err instanceof Error ? err.message : err,
      })
    }
  }
}

/**
 * Cadencia cada 15 min, con minuto desfasado (NO alineado a :00/:15/:30/:45) para evitar la
 * estampida de conexiones documentada en `.claude/rules/cron-jobs.md`.
 */
export function startPlaytelecomEventSimReassignmentJob(): void {
  logger.info('[PlayTelecom Event SIM Reassignment] ⏰ Job started. Runs every 15 min (offset :04/:19/:34/:49).')
  scheduleCron('playtelecom-event-sim-reassignment', '4,19,34,49 * * * *', () => {
    reassignEventSimSales().catch(err => {
      logger.error('[PlayTelecom Event SIM Reassignment] Job iteration failed', { err })
    })
  })
}
