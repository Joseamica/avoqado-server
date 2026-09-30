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
/** Los `OrderSource` que pone la ingesta de reparto (`deliveryOrderIngestion.service.ts`). */
const ORIGENES_DE_AGREGADOR = new Set<string>(['UBER_EATS', 'RAPPI', 'DIDI_FOOD', 'DELIVERY_PLATFORM'])

export async function authorKitchenTickets(params: {
  venueId: string
  orderId: string
  trigger: KitchenTrigger
}): Promise<{ ticketIds: string[] }> {
  const { venueId, orderId, trigger } = params
  const startedAt = new Date()

  const { routing, screens } = await estacionesDelNegocio(venueId)
  if (screens.length === 0) {
    await limpiarMarca(venueId, orderId, startedAt)
    return { ticketIds: [] }
  }

  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: {
      id: true,
      orderNumber: true,
      externalId: true,
      tableId: true,
      type: true,
      source: true,
      status: true,
      originSystem: true,
      deliveryChannelLinkId: true,
    },
  })
  if (!order) return { ticketIds: [] }
  // El reparto de AGREGADOR arma su propia comanda al ingerir (una «Entrega» del propio POS sí se arma aquí); y
  // SoftRestaurant tiene su propio flujo; una venta cancelada no se cocina (el barrido llega hasta 15 min tarde).
  // 🔴 Los vales por área NO saltan la orden entera: una cuenta puede mezclar renglones de vale con productos
  // sueltos (2 cervezas fuera del vale), y esos sueltos sí deben llegar a la pantalla — se filtran por RENGLÓN
  // dentro de la transacción (`areaTicketLineId`), no por `order.areaTicketCode` (I1, revisión final fase 3.3).
  const integrada = order.source === 'POS' && Boolean(order.externalId?.trim())
  const deAgregador =
    Boolean(order.deliveryChannelLinkId) || order.originSystem === 'DELIVERY_PLATFORM' || ORIGENES_DE_AGREGADOR.has(order.source)
  const cancelada = order.status === 'CANCELLED' || order.status === 'DELETED'
  if (deAgregador || cancelada || integrada) {
    await limpiarMarca(venueId, orderId, startedAt)
    return { ticketIds: [] }
  }

  const ticketIds = await prisma.$transaction(
    async tx => {
      // Mismo candado que `withDeliveryOrderLock`, con otro prefijo: Postgres lo suelta al terminar la tx.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`kds-order:${orderId}`}, 0))::text`
      // Se relee DENTRO del candado: una anulación que ganó la carrera ya retiró sus comandas y no hay que revivirlas.
      const vigente = await tx.order.findFirst({ where: { id: orderId, venueId }, select: { status: true } })
      if (!vigente || vigente.status === 'CANCELLED' || vigente.status === 'DELETED') return [] as string[]

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
      // Vale por área (V7): sus renglones traen `areaTicketLineId` y tienen su propio flujo de entrega — se
      // excluyen UNO POR UNO, no toda la orden, porque una cuenta puede mezclar el vale con productos sueltos
      // (I1, revisión final fase 3.3). Si TODOS los renglones son de vale no queda nada que cocinar aquí: se
      // limpia la marca igual que antes, o el barrido dispara un 🚨 falso a los 15 min.
      const normales = renglones.filter(r => !r.areaTicketLineId)
      if (normales.length === 0) {
        await tx.order.updateMany({
          where: { id: orderId, venueId, kitchenPendingAt: { lte: startedAt } },
          data: { kitchenPendingAt: null },
        })
        return [] as string[]
      }

      const cubiertos = await tx.kdsOrderItem.findMany({
        where: { orderItemId: { in: normales.map(r => r.id) }, kdsOrder: { venueId } },
        select: { orderItemId: true },
        take: MAX_RENGLONES * 4,
      })

      const lines: KitchenLine[] = normales.map(r => ({
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

      const soloSinEnviar = trigger === 'PAID' || trigger === 'LEGACY_POST'
      const entrada = {
        order: { id: order.id, externalId: order.externalId, tableId: order.tableId },
        lines,
        coveredLineIds: new Set(cubiertos.map(c => c.orderItemId).filter((id): id is string => Boolean(id))),
        routing,
        screens,
        stampedAt: startedAt,
      }
      const plans = planKitchenTickets({ ...entrada, soloSinEnviar })
      // El pago no arma rondas ya enviadas, pero si una se quedó sin comanda (su gancho falló) la marca se queda:
      // sin ella el barrido ya no la ve nunca (Codex 3.6).
      const rondaSinComanda =
        soloSinEnviar && planKitchenTickets({ ...entrada, soloSinEnviar: false }).some(p => p.lines.some(l => l.sentToKitchenAt))

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
      if (!rondaSinComanda) {
        await tx.order.updateMany({
          where: { id: orderId, venueId, kitchenPendingAt: { lte: startedAt } },
          data: { kitchenPendingAt: null },
        })
      }
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

async function limpiarMarca(venueId: string, orderId: string, startedAt: Date): Promise<void> {
  // `orderId` puede venir de un request del cliente (el POST legado, Tarea 8): siempre acotado al venue.
  await prisma.order.updateMany({ where: { id: orderId, venueId, kitchenPendingAt: { lte: startedAt } }, data: { kitchenPendingAt: null } })
}

/**
 * Anular la cuenta retira de la pantalla de cocina sus comandas NO terminadas: antes la cocina seguía viendo como
 * pendiente una cuenta que ya no existe (Codex 3.6). Toma el candado del armado, así que va AL INICIO de la transacción
 * de la anulación (mismo orden que el armado: candado de comandas → orden). NO va en la fusión de cuentas: ahí los
 * renglones se MUEVEN a la otra cuenta y la comida sigue pedida.
 */
export async function retirarComandasDeVentaAnulada(tx: Prisma.TransactionClient, venueId: string, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`kds-order:${orderId}`}, 0))::text`
  const pendientes = { venueId, orderId, status: { not: 'COMPLETED' as const } }
  await tx.kdsOrderItem.deleteMany({ where: { kdsOrder: pendientes } })
  await tx.kdsOrder.deleteMany({ where: pendientes })
}
