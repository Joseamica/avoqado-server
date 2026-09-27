/**
 * Etapa 3 del KDS — el SERVIDOR arma las comandas de pantalla (spec 2026-09-27 §1-§3).
 *
 * Una comanda se identifica por su FOLIO (`KdsOrder.sourceKey`): quien llega primero crea la fila —el servidor al
 * armarla, la caja al marcar «salió en papel», la pantalla al marcar LISTO sin red— y los demás se juntan. El armado
 * de una orden corre bajo un candado de Postgres por orden: dos armados a la vez (el gancho del cobro y el POST de
 * una app vieja) no duplican platillos.
 */
import type { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { toKdsModifierLabels } from './kdsModifierLabels'
import { estacionesDelNegocio } from './kitchenDisplayStations'
import { planKitchenTickets, type KitchenLine } from './kitchenTicketPlanning'

export type KitchenTrigger = 'PAID' | 'ROUND' | 'LEGACY_POST' | 'SWEEP'
export type KitchenMarkAction = 'BUMP' | 'FALLBACK_PRINTED'

/** Tope de renglones leídos por orden: una cuenta real no se acerca; si se llega, queda en el log. */
const MAX_RENGLONES = 500
/** Mismo presupuesto que el candado de los pedidos de reparto (`deliveryOrderLock.ts`). */
const CANDADO_TX_TIMEOUT_MS = 15_000

export async function authorKitchenTickets(params: {
  venueId: string
  orderId: string
  trigger: KitchenTrigger
}): Promise<{ ticketIds: string[] }> {
  const { venueId, orderId, trigger } = params
  const startedAt = new Date()

  const { routing, screens } = await estacionesDelNegocio(venueId)
  if (screens.length === 0) {
    await limpiarMarca(orderId, startedAt)
    return { ticketIds: [] }
  }

  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, orderNumber: true, externalId: true, tableId: true, type: true, source: true, areaTicketCode: true },
  })
  if (!order) return { ticketIds: [] }
  // Uber arma su propia comanda al ingerir; los vales por área y SoftRestaurant tienen su propio flujo.
  const integrada = order.source === 'POS' && Boolean(order.externalId?.trim())
  if (order.type === 'DELIVERY' || order.areaTicketCode || integrada) {
    await limpiarMarca(orderId, startedAt)
    return { ticketIds: [] }
  }

  const ticketIds = await prisma.$transaction(
    async tx => {
      // Mismo candado que `withDeliveryOrderLock`, con otro prefijo: Postgres lo suelta al terminar la tx.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`kds-order:${orderId}`}, 0))::text`

      const renglones = await tx.orderItem.findMany({
        where: { orderId },
        select: {
          id: true,
          productId: true,
          productName: true,
          quantity: true,
          notes: true,
          externalId: true,
          sentToKitchenAt: true,
          createdAt: true,
          areaTicketLineId: true,
          product: { select: { name: true, categoryId: true, printStationId: true, category: { select: { printStationId: true } } } },
          modifiers: { select: { name: true, quantity: true, modifier: { select: { name: true } } } },
        },
        orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
        take: MAX_RENGLONES,
      })
      if (renglones.length === MAX_RENGLONES) {
        logger.warn('[KDS] orden con demasiados renglones; la comanda se arma con los primeros', { venueId, orderId })
      }
      if (renglones.some(r => r.areaTicketLineId)) return [] as string[]

      const cubiertos = await tx.kdsOrderItem.findMany({
        where: { orderItemId: { in: renglones.map(r => r.id) }, kdsOrder: { venueId } },
        select: { orderItemId: true },
        take: MAX_RENGLONES * 4,
      })

      const lines: KitchenLine[] = renglones.map(r => ({
        id: r.id,
        productId: r.productId,
        categoryId: r.product?.categoryId ?? null,
        productStationId: r.product?.printStationId ?? null,
        categoryStationId: r.product?.category?.printStationId ?? null,
        productName: r.productName ?? r.product?.name ?? 'Producto',
        quantity: r.quantity,
        modifiers: toKdsModifierLabels(r.modifiers.map(m => ({ name: m.name ?? m.modifier?.name ?? null, quantity: m.quantity }))),
        notes: r.notes,
        externalId: r.externalId,
        sentToKitchenAt: r.sentToKitchenAt,
        createdAt: r.createdAt,
      }))

      const plans = planKitchenTickets({
        order: { id: order.id, externalId: order.externalId, tableId: order.tableId },
        lines,
        coveredLineIds: new Set(cubiertos.map(c => c.orderItemId).filter((id): id is string => Boolean(id))),
        routing,
        screens,
        stampedAt: startedAt,
        soloSinEnviar: trigger === 'PAID' || trigger === 'LEGACY_POST',
      })

      const ids: string[] = []
      for (const plan of plans) {
        const kdsOrderId = await cabeceraPorFolio(tx, {
          venueId,
          sourceKey: plan.sourceKey,
          stationId: plan.stationId,
          orderId,
          orderNumber: order.orderNumber,
          orderType: order.type,
        })
        await tx.kdsOrderItem.createMany({
          data: plan.lines.map(l => ({
            kdsOrderId,
            productName: l.productName,
            quantity: l.quantity,
            modifiers: l.modifiers.length ? JSON.stringify(l.modifiers) : null,
            notes: l.notes,
            orderItemId: l.id,
            productId: l.productId,
            categoryId: l.categoryId,
          })),
        })
        if (plan.toStamp.length > 0) {
          await tx.orderItem.updateMany({
            where: { id: { in: plan.toStamp }, sentToKitchenAt: null },
            data: { sentToKitchenAt: startedAt },
          })
        }
        ids.push(kdsOrderId)
      }

      // Sólo si nadie la volvió a poner mientras se armaba (una ronda que entró en medio).
      await tx.order.updateMany({ where: { id: orderId, kitchenPendingAt: { lte: startedAt } }, data: { kitchenPendingAt: null } })
      return ids
    },
    { timeout: CANDADO_TX_TIMEOUT_MS, maxWait: 5_000 },
  )

  if (ticketIds.length > 0) {
    logger.info('[KDS] comandas de pantalla armadas', { venueId, orderId, trigger, comandas: ticketIds.length })
  }
  return { ticketIds }
}

/**
 * Después del commit del cobro o de la ronda. NUNCA lanza: si falla, la marca `kitchenPendingAt` queda puesta y el
 * barrido la arma en el siguiente minuto.
 */
export async function armarComandasTrasCommit(venueId: string, orderId: string, trigger: KitchenTrigger): Promise<void> {
  try {
    await authorKitchenTickets({ venueId, orderId, trigger })
  } catch (error) {
    logger.error('[KDS] la comanda de pantalla no se armó tras el commit; el barrido la reintenta', {
      venueId,
      orderId,
      trigger,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Una marca que llega sin red: la pantalla marcó LISTO, o la caja imprimió la comanda en papel de respaldo.
 * Funciona ANTES o DESPUÉS de que el servidor arme la comanda: si no existe, deja la cabecera con el folio y la
 * marca; el armado le pondrá sus platillos después sin tocar la marca.
 */
export async function markKitchenTicket(a: {
  venueId: string
  sourceKey: string
  stationId: string | null
  action: KitchenMarkAction
  label: string | null
  at: Date
}): Promise<void> {
  const stationId = a.stationId
    ? ((await prisma.printStation.findFirst({ where: { id: a.stationId, venueId: a.venueId }, select: { id: true } }))?.id ?? null)
    : null
  await prisma.kdsOrder.createMany({
    data: [
      {
        venueId: a.venueId,
        sourceKey: a.sourceKey,
        printStationId: stationId,
        orderNumber: a.label?.trim().slice(0, 40) || '—',
        orderType: 'DINE_IN',
        status: 'NEW',
      },
    ],
    skipDuplicates: true,
  })
  if (a.action === 'BUMP') {
    await prisma.kdsOrder.updateMany({
      where: { venueId: a.venueId, sourceKey: a.sourceKey, status: { not: 'COMPLETED' } },
      data: { status: 'COMPLETED', completedAt: a.at },
    })
    return
  }
  // «Salió en papel»: sólo si nadie la empezó en una pantalla. Lo que la cocina ya tomó no se esconde.
  await prisma.kdsOrder.updateMany({
    where: { venueId: a.venueId, sourceKey: a.sourceKey, status: 'NEW', fallbackPrintedAt: null },
    data: { fallbackPrintedAt: a.at },
  })
}

async function cabeceraPorFolio(
  tx: Prisma.TransactionClient,
  a: { venueId: string; sourceKey: string; stationId: string | null; orderId: string; orderNumber: string; orderType: string },
): Promise<string> {
  const [creada] = await tx.kdsOrder.createManyAndReturn({
    data: [
      {
        venueId: a.venueId,
        sourceKey: a.sourceKey,
        printStationId: a.stationId,
        orderId: a.orderId,
        orderNumber: a.orderNumber,
        orderType: a.orderType,
        status: 'NEW',
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  })
  if (creada) return creada.id
  const existente = await tx.kdsOrder.findUniqueOrThrow({
    where: { venueId_sourceKey: { venueId: a.venueId, sourceKey: a.sourceKey } },
    select: { id: true, orderId: true },
  })
  // Una MARCA llegó antes: se le pone la venta. Su estado y su «en papel» son pegajosos y no se tocan.
  if (!existente.orderId) {
    await tx.kdsOrder.update({
      where: { id: existente.id },
      data: { orderId: a.orderId, orderNumber: a.orderNumber, orderType: a.orderType, printStationId: a.stationId },
    })
  }
  return existente.id
}

async function limpiarMarca(orderId: string, startedAt: Date): Promise<void> {
  await prisma.order.updateMany({ where: { id: orderId, kitchenPendingAt: { lte: startedAt } }, data: { kitchenPendingAt: null } })
}
