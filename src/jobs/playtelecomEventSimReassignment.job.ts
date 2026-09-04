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
import { Prisma } from '@prisma/client'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { scheduleCron } from '../observability/jobContext'

// Una orden TPV normal tiene uno o pocos pagos/items y SaleVerification es 1:1
// con Payment. El cap evita materializar una orden corrupta o artificialmente
// enorme: se leen cap+1 filas y se aborta completa en vez de mover un subconjunto.
const MAX_REASSIGNMENT_ROWS_PER_ORDER = 1_000
const REASSIGNMENT_DISCOVERY_PAGE_SIZE = 100

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

  let reassigned = 0
  let skippedMixed = 0
  let afterSerializedItemId: string | undefined

  // Exhaust every eligible page in this run. Maps and IN-lists live for one
  // fixed-size page only, so a recurring mixed order cannot consume the whole
  // discovery window and starve an eligible order with a later key.
  while (true) {
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
            ...(afterSerializedItemId && { id: { gt: afterSerializedItemId } }),
          },
          select: { id: true, orderItemId: true, sellingVenueId: true },
          orderBy: { id: 'asc' },
          take: REASSIGNMENT_DISCOVERY_PAGE_SIZE,
        }),
      {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'playtelecom-event-sim-reassignment.findCandidates',
      },
    )
    if (candidates.length === 0) break
    const isLastDiscoveryPage = candidates.length < REASSIGNMENT_DISCOVERY_PAGE_SIZE
    afterSerializedItemId = candidates[candidates.length - 1].id

    const sourceVenueByOrderItemId = new Map<string, string>()
    for (const candidate of candidates) {
      if (candidate.orderItemId && candidate.sellingVenueId) {
        sourceVenueByOrderItemId.set(candidate.orderItemId, candidate.sellingVenueId)
      }
    }
    const orderItemIds = [...sourceVenueByOrderItemId.keys()]
    if (orderItemIds.length === 0) {
      if (isLastDiscoveryPage) break
      continue
    }

    const orderItemsForCandidates = await prisma.orderItem.findMany({
      where: { id: { in: orderItemIds } },
      select: { id: true, orderId: true },
      orderBy: { id: 'asc' },
      take: orderItemIds.length,
    })
    const expectedSourcesByOrderId = new Map<string, Set<string>>()
    for (const orderItem of orderItemsForCandidates) {
      const expectedSourceVenueId = sourceVenueByOrderItemId.get(orderItem.id)
      if (!expectedSourceVenueId) continue
      const sources = expectedSourcesByOrderId.get(orderItem.orderId) ?? new Set<string>()
      sources.add(expectedSourceVenueId)
      expectedSourcesByOrderId.set(orderItem.orderId, sources)
    }
    const orderIds = [...expectedSourcesByOrderId.keys()]

    for (const orderId of orderIds) {
      try {
        const discoveredSources = expectedSourcesByOrderId.get(orderId)
        const expectedSourceVenueId = discoveredSources?.size === 1 ? [...discoveredSources][0] : null

        const movement = await prisma.$transaction(async tx => {
          // El marker y las cuatro tablas parten de la MISMA fila bloqueada. La
          // autoridad descubierta afuera sólo identifica la generación candidata;
          // aquí se vuelve a probar source/org/state y la pureza actual completa.
          const lockedOrders = await tx.$queryRaw<
            Array<{
              id: string
              venueId: string
              updatedAt: Date
              organizationId: string
              state: string | null
            }>
          >(Prisma.sql`
          SELECT
            o.id,
            o."venueId",
            o."updatedAt",
            v."organizationId",
            v.state
          FROM "Order" o
          JOIN "Venue" v ON v.id = o."venueId"
          WHERE o.id = ${orderId}
          FOR UPDATE OF o
        `)
          const lockedOrder = lockedOrders[0]
          const currentState = lockedOrder?.state?.trim().toLowerCase() ?? null
          const expectedState = rule.originState.trim().toLowerCase()
          if (
            !lockedOrder ||
            !expectedSourceVenueId ||
            lockedOrder.venueId !== expectedSourceVenueId ||
            lockedOrder.venueId === targetVenue.id ||
            lockedOrder.organizationId !== org.id ||
            currentState !== expectedState
          ) {
            return null
          }

          const currentOrderItems = await tx.orderItem.findMany({
            where: { orderId },
            select: {
              serializedItem: {
                select: {
                  status: true,
                  sellingVenueId: true,
                  category: { select: { name: true } },
                },
              },
            },
            take: MAX_REASSIGNMENT_ROWS_PER_ORDER + 1,
          })
          if (currentOrderItems.length > MAX_REASSIGNMENT_ROWS_PER_ORDER) {
            throw new Error(`La Order excede el máximo seguro de ${MAX_REASSIGNMENT_ROWS_PER_ORDER} items`)
          }
          const stillPure = isOrderPureCategoryMatch(
            currentOrderItems.map(item => item.serializedItem?.category?.name ?? null),
            rule.categoryName,
          )
          if (!stillPure) {
            // El lock de Order serializa tanto la decisión como el dedup. Por eso dos
            // jobs concurrentes no pueden crear dos avisos para la misma autoridad.
            const alreadyFlagged = await tx.activityLog.findFirst({
              where: {
                action: 'ORDER_VENUE_REASSIGNMENT_SKIPPED_MIXED',
                entity: 'Order',
                entityId: orderId,
                venueId: lockedOrder.venueId,
              },
              select: { id: true },
            })
            if (!alreadyFlagged) {
              await tx.activityLog.create({
                data: {
                  action: 'ORDER_VENUE_REASSIGNMENT_SKIPPED_MIXED',
                  entity: 'Order',
                  entityId: orderId,
                  venueId: lockedOrder.venueId,
                  staffId: null,
                  data: { reason: 'mixed_order_skipped', category: rule.categoryName },
                },
              })
            }
            return { kind: 'skippedMixed' as const, counted: !alreadyFlagged }
          }
          const allItemsStillEligible = currentOrderItems.every(
            item => item.serializedItem?.status === 'SOLD' && item.serializedItem.sellingVenueId === lockedOrder.venueId,
          )
          if (!allItemsStillEligible) return null

          // Orden global de locks: Order → todos sus Payment → dependientes.
          // Sólo se traen ids y autoridad; cap+1 permite detectar truncamiento.
          const lockedPayments = await tx.$queryRaw<Array<{ id: string; venueId: string }>>(Prisma.sql`
          SELECT p.id, p."venueId"
          FROM "Payment" p
          WHERE p."orderId" = ${orderId}
          ORDER BY p.id
          LIMIT ${MAX_REASSIGNMENT_ROWS_PER_ORDER + 1}
          FOR UPDATE OF p
        `)
          if (lockedPayments.length > MAX_REASSIGNMENT_ROWS_PER_ORDER) {
            throw new Error(`La Order excede el máximo seguro de ${MAX_REASSIGNMENT_ROWS_PER_ORDER} Payments`)
          }
          if (lockedPayments.some(payment => payment.venueId !== lockedOrder.venueId)) {
            throw new Error('Los Payment de la Order ya no pertenecen al venue fuente bloqueado')
          }
          const paymentIds = lockedPayments.map(payment => payment.id)

          const lockedSaleVerifications = await tx.$queryRaw<Array<{ id: string; paymentId: string; venueId: string }>>(Prisma.sql`
          SELECT sv.id, sv."paymentId", sv."venueId"
          FROM "SaleVerification" sv
          JOIN "Payment" p ON p.id = sv."paymentId"
          WHERE p."orderId" = ${orderId}
          ORDER BY sv.id
          LIMIT ${MAX_REASSIGNMENT_ROWS_PER_ORDER + 1}
          FOR UPDATE OF sv
        `)
          if (lockedSaleVerifications.length > MAX_REASSIGNMENT_ROWS_PER_ORDER) {
            throw new Error(`La Order excede el máximo seguro de ${MAX_REASSIGNMENT_ROWS_PER_ORDER} SaleVerifications`)
          }
          const paymentIdSet = new Set(paymentIds)
          if (
            lockedSaleVerifications.some(
              verification => verification.venueId !== lockedOrder.venueId || !paymentIdSet.has(verification.paymentId),
            )
          ) {
            throw new Error('Las SaleVerification ya no pertenecen al Payment/venue fuente bloqueado')
          }

          // SaleVerification debe cambiar mientras su Payment todavía conserva source.
          const saleVerificationIds = lockedSaleVerifications.map(verification => verification.id)
          if (saleVerificationIds.length > 0) {
            const movedSaleVerifications = await tx.saleVerification.updateMany({
              where: {
                id: { in: saleVerificationIds },
                paymentId: { in: paymentIds },
                venueId: lockedOrder.venueId,
              },
              data: { venueId: targetVenue.id },
            })
            if (movedSaleVerifications.count !== saleVerificationIds.length) {
              throw new Error('El inventario bloqueado de SaleVerification cambió durante la reasignación')
            }
          }
          if (paymentIds.length > 0) {
            const movedPayments = await tx.payment.updateMany({
              where: { id: { in: paymentIds }, orderId, venueId: lockedOrder.venueId },
              // VenueTenderType is tenant-bound through the composite FK
              // [venueId, tenderTypeId]. There is no deterministic target mapping,
              // so detach only that live relation. Immutable tender snapshots and
              // historical method/fundsFlow fields remain untouched.
              data: { venueId: targetVenue.id, tenderTypeId: null },
            })
            if (movedPayments.count !== paymentIds.length) {
              throw new Error('El inventario bloqueado de Payment cambió durante la reasignación')
            }
          }
          const movedSerializedItems = await tx.serializedItem.updateMany({
            where: {
              status: 'SOLD',
              sellingVenueId: lockedOrder.venueId,
              orderItem: { orderId },
              category: { name: { equals: rule.categoryName, mode: 'insensitive' } },
            },
            data: { sellingVenueId: targetVenue.id },
          })
          if (movedSerializedItems.count !== currentOrderItems.length) {
            throw new Error('Los SerializedItem elegibles cambiaron durante la reasignación')
          }
          const movedOrder = await tx.order.updateMany({
            where: { id: orderId, venueId: lockedOrder.venueId, updatedAt: lockedOrder.updatedAt },
            data: { venueId: targetVenue.id },
          })
          if (movedOrder.count !== 1) {
            throw new Error('La Order bloqueada no pudo reasignarse con su venue esperado')
          }
          const reassignedAt = new Date()
          const auditData = {
            fromVenueId: lockedOrder.venueId,
            toVenueId: targetVenue.id,
            sourceOrderUpdatedAt: lockedOrder.updatedAt.toISOString(),
            reason: 'playtelecom_evento_sim',
            category: rule.categoryName,
            reassignedAt: reassignedAt.toISOString(),
          }
          // Estas dos filas conservan la auditabilidad bidireccional histórica y
          // además son el marker durable que una refund puede verificar sin leer B.
          for (const venueId of [targetVenue.id, lockedOrder.venueId]) {
            await tx.activityLog.create({
              data: {
                action: 'ORDER_VENUE_REASSIGNED',
                entity: 'Order',
                entityId: orderId,
                venueId,
                staffId: null,
                data: auditData,
                createdAt: reassignedAt,
              },
            })
          }
          return { kind: 'reassigned' as const }
        })

        if (!movement) continue
        if (movement.kind === 'skippedMixed') {
          if (movement.counted) {
            skippedMixed++
            logger.warn('[PlayTelecom Event SIM Reassignment] Orden mixta detectada, se deja para revisión manual', { orderId })
          } else {
            logger.debug('[PlayTelecom Event SIM Reassignment] Orden mixta ya reportada antes, sigue esperando revisión manual', {
              orderId,
            })
          }
          continue
        }
        reassigned++
      } catch (err) {
        logger.error('[PlayTelecom Event SIM Reassignment] No se pudo reasignar una orden', {
          orderId,
          error: err instanceof Error ? err.message : err,
        })
      }
    }
    if (isLastDiscoveryPage) break
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
