/**
 * Etapa 3 del KDS — el SERVIDOR arma las comandas de pantalla (spec 2026-09-27 §1-§3).
 *
 * Una comanda se identifica por su FOLIO (`KdsOrder.sourceKey`): quien llega primero crea la fila —el servidor al
 * armarla, la caja al marcar «salió en papel», la pantalla al marcar LISTO sin red— y los demás se juntan. El armado
 * de una orden corre bajo un candado de Postgres por orden: dos armados a la vez (el gancho del cobro y el POST de
 * una app vieja) no duplican platillos.
 */
import { createHash, randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { lockExistingOrderForPayment, ORDER_LOCK_WAIT_BUDGET } from '../shared/paymentShiftClaim'
import { toKdsModifierLabels } from './kdsModifierLabels'
import { estacionesDelNegocio } from './kitchenDisplayStations'
import { nombreEnCocina } from './nombreEnCocina'
import { origenDeLaDiferencia, planKitchenTickets, type KitchenLine } from './kitchenTicketPlanning'
import { initialPreparation, parsePreparation, PREPARATION_VERSION, preparationTicketStatus } from './kitchenPreparation'
import { ConflictError } from '../../errors/AppError'
import { parseServiceCourseSnapshot } from '../service-courses/serviceCourseContract'
import { esRenglonDeVale } from '../shared/renglonDeVale'

export type KitchenTrigger = 'PAID' | 'ROUND' | 'LEGACY_POST' | 'SWEEP'
export type KitchenMarkAction = 'BUMP' | 'FALLBACK_PRINTED'

/** Renglones por página: recorrer la cuenta completa sin una lectura sin tope. */
const MAX_RENGLONES = 500
/**
 * S9 v5 (B4): holgura del reloj al comparar «tocado desde T» en un folio sellado. Sólo empuja hacia MANDAR (lo de BASE), nunca hacia
 * perder una unidad nueva: un empate, un renglón escrito en la misma transacción o un reloj que retrocede cuentan como «tocado».
 */
const HOLGURA_DE_RELOJ_MS = 5_000
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
  const preparationLine = await prisma.orderItem.findFirst({
    where: { order: { id: orderId, venueId }, serviceCourse: { path: ['preparationVersion'], equals: PREPARATION_VERSION } },
    select: { id: true },
  })
  // New POS work persists its progress even when a station uses paper, without backfilling legacy sales.
  const preparationScreens = preparationLine ? [...routing.activeStationIds].map(id => ({ id, since: new Date(0) })) : screens
  if (preparationScreens.length === 0 && !preparationLine) {
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

  const ticketIds = await prisma.$transaction(async tx => {
    const venue = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Venue" WHERE id=${venueId} FOR KEY SHARE`
    if (!venue.length) return [] as string[]
    // Mismo candado que `withDeliveryOrderLock`, con otro prefijo: Postgres lo suelta al terminar la tx.
    await tomarCandadoDeComandas(tx, orderId)
    // Y el de la orden ANTES de tocar renglones: comandas → orden → renglones, el orden de todos los escritores. Sin él el
    // armado bloqueaba renglones y luego esperaba la orden, al revés de quien ya la tiene y espera esos renglones.
    if (!(await lockExistingOrderForPayment(tx, { venueId, orderId }))) return [] as string[]
    // Se relee DENTRO del candado: una anulación que ganó la carrera ya retiró sus comandas y no hay que revivirlas.
    const vigente = await tx.order.findFirst({
      where: { id: orderId, venueId },
      select: { status: true, onlineOrder: { select: { requiresAcceptance: true, expiredAt: true, cancelledAt: true, rejectedAt: true } } },
    })
    if (!vigente || vigente.status === 'CANCELLED' || vigente.status === 'DELETED') return [] as string[]
    // 🔴 S9 v5 (B4, D3 «en duda, manda»): un folio «Nadie» que se anuló alguna vez (el sello de A0) sólo NO se arma si ningún renglón se
    // creó ni se modificó desde T − 5 s (T = la menor de sus fechas de cierre): es dinero tardío sobre lo que ya existía al anular. Si la
    // cajera tocó algo (agregó, subió una cantidad, una cortesía), se arma exactamente como hoy, aunque repita lo viejo (deuda E, BASE).
    // Una edición después de T espera el candado de la orden que soltó la anulación; `@updatedAt` y T leen el mismo reloj (una instancia).
    const oo = vigente.onlineOrder
    const fechas = oo?.requiresAcceptance === false ? [oo.expiredAt, oo.cancelledAt, oo.rejectedAt].filter((d): d is Date => d != null) : []
    if (fechas.length > 0) {
      const desde = new Date(Math.min(...fechas.map(d => d.getTime())) - HOLGURA_DE_RELOJ_MS)
      const tocado = await tx.orderItem.findFirst({
        where: { orderId, OR: [{ createdAt: { gte: desde } }, { updatedAt: { gte: desde } }] }, // índice [orderId]
        select: { id: true },
      })
      if (!tocado) {
        // Nada que cocinar: la marca se limpia con la guarda de siempre (una ronda que entró en medio la conserva).
        await tx.order.updateMany({
          where: { id: orderId, venueId, kitchenPendingAt: { lte: startedAt } },
          data: { kitchenPendingAt: null },
        })
        return [] as string[]
      }
    }

    let cursor: string | undefined
    let rondaSinComanda = false
    const ids = new Set<string>()
    /** Comandas que nacieron en ESTE armado: las únicas que reciben platillos (hz:dcc49fe5:D1 · Codex r4 B10/B13, r5). */
    const creadas = new Set<string>()
    while (true) {
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
          serviceCourse: true,
          orderPromotionId: true,
          areaTicketLineId: true,
          releasedAreaTicketLineId: true,
          giftCardId: true,
          weightQuantity: true,
          weightUnit: true,
          product: { select: { name: true, categoryId: true, printStationId: true, category: { select: { printStationId: true } } } },
          modifiers: { select: { name: true, quantity: true, modifier: { select: { name: true } } } },
        },
        orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: MAX_RENGLONES,
      })
      if (renglones.length === 0) break
      cursor = renglones[renglones.length - 1].id
      // Vale por área (V7): sus renglones traen `areaTicketLineId` y tienen su propio flujo de entrega — se
      // excluyen UNO POR UNO, no toda la orden, porque una cuenta puede mezclar el vale con productos sueltos
      // (I1, revisión final fase 3.3). Si TODOS los renglones son de vale no queda nada que cocinar aquí: se
      // limpia la marca igual que antes, o el barrido dispara un 🚨 falso a los 15 min.
      // Tarjetas de regalo (spec § 4.4): una línea de tarjeta no se cocina. Si no queda nada, la marca se limpia igual.
      // D1: el renglón de un vale que se volvió a cobrar en otra cuenta tampoco se cocina aquí (`esRenglonDeVale`).
      const normales = renglones.filter(r => !esRenglonDeVale(r) && !r.giftCardId)
      if (normales.length === 0) continue

      // Cuántas unidades de cada renglón ya están en comandas (hz:dcc49fe5:D1): la caja puede subir la cantidad de un renglón ya
      // mandado y sólo debe salir la diferencia. Un grupo por renglón: a lo más MAX_RENGLONES, sin truncar filas.
      const enComandas = await tx.kdsOrderItem.groupBy({
        by: ['orderItemId'],
        where: { orderItemId: { in: normales.map(r => r.id) }, kdsOrder: { venueId } },
        _sum: { quantity: true },
      })
      const sentUnits = new Map<string, number>()
      for (const g of enComandas) if (g.orderItemId && g._sum.quantity) sentUnits.set(g.orderItemId, g._sum.quantity)
      // Una comanda con preparación por producto la lleva para TODOS sus renglones, aunque el renglón no la pida (Codex r2 #2).
      const conPreparacion = sentUnits.size
        ? await tx.kdsOrderItem.groupBy({
            by: ['orderItemId'],
            where: { orderItemId: { in: [...sentUnits.keys()] }, kdsOrder: { venueId, preparationVersion: PREPARATION_VERSION } },
            _count: { _all: true },
          })
        : []
      const preparationLineIds = new Set(conPreparacion.map(g => g.orderItemId).filter((id): id is string => Boolean(id)))

      const lines: KitchenLine[] = normales.map(r => ({
        id: r.id,
        productId: r.productId,
        categoryId: r.product?.categoryId ?? null,
        productStationId: r.product?.printStationId ?? null,
        categoryStationId: r.product?.category?.printStationId ?? null,
        // Codex 3.6 (S6): la venta por peso lleva `quantity = 1`; sin el peso la cocina no sabe cuánto servir.
        productName: nombreEnCocina(r.productName ?? r.product?.name ?? 'Producto', r.weightQuantity, r.weightUnit),
        quantity: r.quantity,
        modifiers: toKdsModifierLabels(r.modifiers.map(m => ({ name: m.name ?? m.modifier?.name ?? null, quantity: m.quantity }))),
        notes: r.notes,
        externalId: r.externalId,
        sentToKitchenAt: r.sentToKitchenAt,
        createdAt: r.createdAt,
        serviceCourse: r.serviceCourse,
        orderPromotionId: r.orderPromotionId,
      }))

      const soloSinEnviar = trigger === 'PAID' || trigger === 'LEGACY_POST'
      const entrada = {
        order: { id: order.id, externalId: order.externalId, tableId: order.tableId },
        lines,
        sentUnits,
        preparationLineIds,
        routing,
        screens: preparationScreens.length ? preparationScreens : [{ id: 'none', since: new Date(0) }],
        stampedAt: startedAt,
      }
      const plans = planKitchenTickets({ ...entrada, soloSinEnviar })
      // El pago no arma rondas ya enviadas, pero si una se quedó sin comanda (su gancho falló) la marca se queda:
      // sin ella el barrido ya no la ve nunca (Codex 3.6).
      rondaSinComanda ||=
        soloSinEnviar &&
        planKitchenTickets({ ...entrada, soloSinEnviar: false }).some(p => p.lines.some(l => l.sentToKitchenAt && !sentUnits.has(l.id)))

      for (const plan of plans) {
        const preparationVersion = plan.lines.some(
          l => parseServiceCourseSnapshot(l.serviceCourse)?.preparationVersion === PREPARATION_VERSION,
        )
          ? PREPARATION_VERSION
          : 0
        const cabecera = {
          venueId,
          stationId: plan.stationId,
          orderId,
          orderNumber: order.orderNumber,
          orderType: order.type,
          preparationVersion,
        }
        // 🔴 hz:dcc49fe5:D1 · Codex r4 B10/B13 y r5: una comanda que YA existía (de un armado anterior o de una marca que llegó antes)
        // nunca recibe platillos nuevos. Pudo terminarse o salir en papel, y una marca (LISTO sin red, «salió en papel») la cierra sin
        // este candado y sin decir qué cubría: lo agregado quedaría escondido. Lo de este armado sale en una comanda nueva y visible
        // (el folio de su diferencia), aunque repita algo que la marca ya cubría («en duda, manda»). Así es cada envío en Square.
        let kdsOrderId = await cabeceraPorFolio(tx, { ...cabecera, sourceKey: plan.sourceKey }, creadas)
        if (!creadas.has(kdsOrderId)) {
          const folioNuevo = `${origenDeLaDiferencia(order, startedAt)}:${plan.stationId ?? 'none'}`
          kdsOrderId = await cabeceraPorFolio(tx, { ...cabecera, sourceKey: folioNuevo }, creadas)
          // Sólo si ese folio ya existía de otro armado en el mismo milisegundo: se revierte todo y el barrido reintenta con otro sello.
          if (!creadas.has(kdsOrderId)) throw new ConflictError('La comanda nueva ya existía.', 'KDS_FOLIO_CONFLICT')
        }
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
            externalLineId: l.externalId,
            serviceCourse: l.serviceCourse == null ? Prisma.DbNull : (l.serviceCourse as Prisma.InputJsonValue),
            orderPromotionId: l.orderPromotionId ?? null,
            preparation: preparationVersion
              ? (initialPreparation(l.quantity, parseServiceCourseSnapshot(l.serviceCourse)?.kind ?? 'IMMEDIATE') as Prisma.InputJsonValue)
              : Prisma.DbNull,
          })),
        })
        ids.add(kdsOrderId)
        if (plan.toStamp.length > 0) {
          await tx.orderItem.updateMany({
            where: { id: { in: plan.toStamp }, sentToKitchenAt: null },
            data: { sentToKitchenAt: startedAt },
          })
        }
      }
    }

    // Sólo si nadie la volvió a poner mientras se armaba (una ronda que entró en medio).
    if (!rondaSinComanda) {
      await tx.order.updateMany({
        where: { id: orderId, venueId, kitchenPendingAt: { lte: startedAt } },
        data: { kitchenPendingAt: null },
      })
    }
    return [...ids]
  }, ORDER_LOCK_WAIT_BUDGET)

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
      where: { venueId: a.venueId, sourceKey: a.sourceKey, preparationVersion: 0, status: { not: 'COMPLETED' } },
      // A legacy whole-ticket BUMP cannot complete or deliver new product-level work.
      data: { status: 'COMPLETED', completedAt: a.at },
    })
    return
  }
  // «Salió en papel»: sólo si nadie la empezó en una pantalla. Lo que la cocina ya tomó no se esconde.
  await prisma.kdsOrder.updateMany({
    where: { venueId: a.venueId, sourceKey: a.sourceKey, preparationVersion: 0, status: 'NEW', fallbackPrintedAt: null },
    data: { fallbackPrintedAt: a.at },
  })
}

async function cabeceraPorFolio(
  tx: Prisma.TransactionClient,
  a: {
    venueId: string
    sourceKey: string
    stationId: string | null
    orderId: string
    orderNumber: string
    orderType: string
    preparationVersion: number
  },
  creadas: Set<string>,
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
        preparationVersion: a.preparationVersion,
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  })
  if (creada) {
    creadas.add(creada.id)
    return creada.id
  }
  const existente = await tx.kdsOrder.findUniqueOrThrow({
    where: { venueId_sourceKey: { venueId: a.venueId, sourceKey: a.sourceKey } },
    select: { id: true, orderId: true },
  })
  // 🔴 Codex r3 #1: nunca se le suman platillos a la comanda de OTRA cuenta (si ya se terminó, saldrían escondidos). Pasa si un
  // renglón movido de cuenta trae el folio de su ronda, o con una marca rara. Se arma en un folio propio de esta cuenta, fijo para
  // que un reintento se junte con él y de largo fijo para que su LISTO sin red se acepte.
  if (existente.orderId && existente.orderId !== a.orderId) {
    const propio = `order:${a.orderId}:otra:${createHash('sha256').update(a.sourceKey).digest('hex').slice(0, 16)}`
    if (a.sourceKey === propio) throw new ConflictError('La comanda choca con la de otra cuenta.', 'KDS_FOLIO_CONFLICT')
    logger.warn('[KDS] el folio ya es de otra cuenta; la comanda sale en uno propio', {
      venueId: a.venueId,
      orderId: a.orderId,
      otraCuenta: existente.orderId,
    })
    return cabeceraPorFolio(tx, { ...a, sourceKey: propio }, creadas)
  }
  // Una MARCA llegó antes: se le pone la venta. Su estado y su «en papel» son pegajosos y no se tocan.
  if (!existente.orderId) {
    await tx.kdsOrder.update({
      where: { id: existente.id },
      data: { orderId: a.orderId, orderNumber: a.orderNumber, orderType: a.orderType, printStationId: a.stationId },
    })
  }
  // Ya no recibe platillos (ni se reabre por una ronda con tiempos): el armado los manda en una comanda nueva.
  return existente.id
}

async function limpiarMarca(venueId: string, orderId: string, startedAt: Date): Promise<void> {
  // `orderId` puede venir de un request del cliente (el POST legado, Tarea 8): siempre acotado al venue.
  await prisma.order.updateMany({ where: { id: orderId, venueId, kitchenPendingAt: { lte: startedAt } }, data: { kitchenPendingAt: null } })
}

/**
 * El candado del armado de comandas de UNA orden (Postgres lo suelta al terminar la tx). Quien lo tome junto con el de la
 * orden lo toma PRIMERO: comandas → orden, el orden del armado.
 */
export async function tomarCandadoDeComandas(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`kds-order:${orderId}`}, 0))::text`
}

/**
 * Anular la cuenta retira de la pantalla de cocina sus comandas NO terminadas: antes la cocina seguía viendo como
 * pendiente una cuenta que ya no existe (Codex 3.6). Toma el candado del armado, así que va AL INICIO de la transacción
 * de la anulación (mismo orden que el armado: candado de comandas → orden). NO va en la fusión de cuentas: ahí los
 * renglones se MUEVEN a la otra cuenta y la comida sigue pedida.
 */
export async function retirarComandasDeVentaAnulada(
  tx: Prisma.TransactionClient,
  venueId: string,
  orderId: string,
  actor: { staffId?: string; reason?: string } = {},
): Promise<{ kdsOrderIds: string[]; kdsOrderItemIds: string[] }> {
  // D3 (hz:381780f0, Codex r1 #1): con los de sus cuentas ligadas, en orden y de entrada. El borrado del panel llega aquí sin ningún
  // candado; tomar el suyo y después el de la original cerraba un ciclo con unir, que ya los toma en orden. Quien ya los tiene
  // (anular, «Anular todo») los vuelve a pedir sin esperar.
  for (const id of (await cuentasDeSusComandas(tx, venueId, orderId)).sort()) await tomarCandadoDeComandas(tx, id)
  // D25: antes de retirar, cada platillo pendiente queda con la cuenta donde vive hoy su renglón (dividir y unir no lo mueven).
  const kdsOrderIds: string[] = await ponerComandasConSuCuenta(tx, venueId, orderId),
    kdsOrderItemIds: string[] = []
  const pendientes = { venueId, orderId, status: { not: 'COMPLETED' as const }, preparationVersion: 0 }
  let cursor: string | undefined
  for (;;) {
    const page = await tx.kdsOrder.findMany({
      where: pendientes,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    kdsOrderIds.push(...page.map(row => row.id))
    if (page.length < 100) break
    cursor = page[page.length - 1].id
  }
  cursor = undefined
  for (;;) {
    const page: { id: string }[] = await tx.kdsOrderItem.findMany({
      where: { kdsOrder: pendientes },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    kdsOrderItemIds.push(...page.map(row => row.id))
    if (page.length < 100) break
    cursor = page[page.length - 1].id
  }
  await tx.kdsOrderItem.deleteMany({ where: { kdsOrder: pendientes } })
  await tx.kdsOrder.deleteMany({ where: pendientes })
  // New tickets remain a durable history. Cancelling the sale only cancels work still outstanding.
  const tracked = { venueId, orderId, preparationVersion: PREPARATION_VERSION, status: { not: 'COMPLETED' as const } }
  cursor = undefined
  for (;;) {
    const page: Pick<Prisma.KdsOrderItemGetPayload<{}>, 'id' | 'kdsOrderId' | 'quantity' | 'preparation' | 'preparationRevision'>[] =
      await tx.kdsOrderItem.findMany({
        where: { kdsOrder: tracked },
        select: { id: true, kdsOrderId: true, quantity: true, preparation: true, preparationRevision: true },
        orderBy: { id: 'asc' },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
    for (const row of page) {
      const before = parsePreparation(row.preparation, row.quantity)
      const after = {
        ...before,
        HELD: 0,
        PENDING: 0,
        PREPARING: 0,
        READY: 0,
        CANCELLED: before.CANCELLED + before.HELD + before.PENDING + before.PREPARING + before.READY,
      }
      const changed = await tx.kdsOrderItem.updateMany({
        where: { id: row.id, preparationRevision: row.preparationRevision, kdsOrder: tracked },
        data: { preparation: after, preparationRevision: { increment: 1 } },
      })
      if (changed.count !== 1) throw new ConflictError('La preparación cambió. Vuelve a revisar la cuenta.', 'PREPARATION_CONFLICT')
      await tx.activityLog.create({
        data: {
          venueId,
          staffId: actor.staffId,
          action: 'KITCHEN_ORDER_CANCEL',
          entity: 'KdsOrderItem',
          entityId: row.id,
          data: { orderId, reason: actor.reason ?? 'Cuenta anulada', before, after, revision: row.preparationRevision + 1 },
        },
      })
      kdsOrderItemIds.push(row.id)
      if (!kdsOrderIds.includes(row.kdsOrderId)) kdsOrderIds.push(row.kdsOrderId)
    }
    if (page.length < 100) break
    cursor = page[page.length - 1].id
  }
  await tx.kdsOrder.updateMany({ where: tracked, data: { status: 'COMPLETED', completedAt: new Date() } })
  return { kdsOrderIds, kdsOrderItemIds }
}

/** Una página de las filas pendientes de comanda que tocan a `orderId` y no están con su cuenta: lo que mueve `ponerComandasConSuCuenta`. */
function filasFueraDeSuCuenta(tx: Prisma.TransactionClient, venueId: string, orderId: string) {
  return tx.$queryRaw<Array<{ id: string; kdsOrderId: string; cabecera: string | null; dueno: string }>>`
      SELECT ki.id, ki."kdsOrderId", k."orderId" AS cabecera, oi."orderId" AS dueno
        FROM "KdsOrder" k
        JOIN "KdsOrderItem" ki ON ki."kdsOrderId" = k.id
        JOIN "OrderItem" oi ON oi.id = ki."orderItemId"
        JOIN "Order" o ON o.id = oi."orderId"
       WHERE k."venueId" = ${venueId} AND k."orderId" = ${orderId} AND k.status <> 'COMPLETED'
         AND oi."orderId" <> ${orderId} AND o."venueId" = ${venueId} AND o.status NOT IN ('CANCELLED', 'DELETED')
      UNION
      SELECT ki.id, ki."kdsOrderId", k."orderId" AS cabecera, oi."orderId" AS dueno
        FROM "OrderItem" oi
        JOIN "KdsOrderItem" ki ON ki."orderItemId" = oi.id
        JOIN "KdsOrder" k ON k.id = ki."kdsOrderId"
       WHERE oi."orderId" = ${orderId} AND k."venueId" = ${venueId} AND k.status <> 'COMPLETED'
         AND k."orderId" IS DISTINCT FROM ${orderId}
      ORDER BY 2, 4, 1
      LIMIT 1000`
}

/**
 * 🔴 hz:381780f0:D3: `orderId` y las cuentas cuyo candado de comandas pedirá `ponerComandasConSuCuenta(orderId)`, leídas SIN candado.
 * Quien une o anula los toma TODOS, en orden y antes que las filas de las cuentas (`lockTableOrderScope` con `kdsOrderIds`): pedirlos a
 * media transacción, ya con las filas tomadas, cerraba un ciclo con otra caja que tenía ese candado y esperaba su fila (Postgres
 * cortaba una con 40P01). Lo que cambie entre esta lectura y el candado lo relee ella bajo candado y lo toma (raro; se reintenta).
 * ponytail: sólo la primera página (1,000 filas); las cuentas de las siguientes se toman a media transacción, como antes.
 */
export async function cuentasDeSusComandas(tx: Prisma.TransactionClient, venueId: string, orderId: string): Promise<string[]> {
  const filas = (await filasFueraDeSuCuenta(tx, venueId, orderId)) ?? []
  return [...new Set([orderId, ...filas.flatMap(f => [f.cabecera, f.dueno])])].filter((id): id is string => Boolean(id))
}

/**
 * 🔴 D25 (Codex r4 del D1 de cocina, B4 y B5): un platillo pendiente de la pantalla de cocina es de la cuenta donde vive HOY su
 * renglón, no de la cuenta que armó la comanda. Dividir y unir mueven renglones sin tocar sus comandas; por eso anular A borraba (o,
 * con preparación por producto, cancelaba) lo que ya vivía en B, y lo de A que estaba en la comanda de otra cuenta se quedaba.
 *
 * Pone bajo su cuenta cada fila pendiente que toca a `orderId`: la de una comanda de `orderId` cuyo renglón vive en OTRA cuenta viva
 * pasa a esa cuenta, y la de un renglón de `orderId` que está en la comanda de otra pasa a `orderId`. Lo último que queda de una
 * comanda se la lleva entera (mismo folio, mismo lugar en la pantalla); lo demás sale en un folio nuevo (`order:<cuenta>:de:<comanda>:<n>`)
 * con la estación, el estado y la hora de la original. Una fila sin renglón, o de un renglón de una cuenta anulada, se queda. Lo
 * terminado no se toca. Una «LISTO» sin red sobre el folio original no alcanza a lo que salió en uno nuevo: vuelve a verse pendiente
 * (en duda, manda).
 *
 * 🔴 Candados (Codex r1 #1, r2 #1, r3): la comanda de una cuenta sólo se toca con SU candado de comandas, el mismo que toman su armado,
 * su preparación y su anulación; y la cuenta que recibe la pieza, con el suyo. Quien une o anula ya los tomó antes que las filas
 * (`cuentasDeSusComandas`, D3); si aun así falta alguno (otra caja cambió las ligas mientras), se toma (en orden) y se vuelve a leer ya
 * bajo candado. Dos cajas que los toman al revés se interbloquean: Postgres corta una y `withDeadlockRetry` (o el RETRY de la cola sin
 * red) la repite. Las escrituras además exigen lo leído. CALLER_LOCKED: dentro de la transacción y con el candado de comandas de
 * `orderId`. Devuelve las comandas que cambiaron.
 */
export async function ponerComandasConSuCuenta(tx: Prisma.TransactionClient, venueId: string, orderId: string): Promise<string[]> {
  const tocadas = new Set<string>()
  const conPreparacion = new Set<string>()
  const conCandado = new Set<string>([orderId]) // el de `orderId` lo tomó quien llama
  // Por páginas y sin tope (Codex r2 #2): cada fila que se mueve queda con su cuenta y ya no vuelve a salir.
  for (let sinAvanzar = 0; ; ) {
    const filas = await filasFueraDeSuCuenta(tx, venueId, orderId)
    if (!filas?.length) break
    const faltan = [...new Set(filas.flatMap(f => [f.cabecera, f.dueno]))]
      .filter((id): id is string => Boolean(id) && !conCandado.has(id!))
      .sort()
    if (faltan.length > 0) {
      for (const id of faltan) {
        await tomarCandadoDeComandas(tx, id)
        conCandado.add(id)
      }
      continue // se vuelve a leer ya bajo candado: lo leído antes pudo cambiar mientras se esperaba
    }

    const porComanda = new Map<string, Map<string, string[]>>()
    for (const f of filas) {
      const porDueno = porComanda.get(f.kdsOrderId) ?? new Map<string, string[]>()
      porDueno.set(f.dueno, [...(porDueno.get(f.dueno) ?? []), f.id])
      porComanda.set(f.kdsOrderId, porDueno)
    }
    const duenos = [...new Set(filas.map(f => f.dueno))]
    const numeros = new Map(
      (
        await tx.order.findMany({ where: { id: { in: duenos }, venueId }, select: { id: true, orderNumber: true }, take: duenos.length })
      ).map(o => [o.id, o.orderNumber]),
    )
    const comandas = await tx.kdsOrder.findMany({
      where: { id: { in: [...porComanda.keys()] }, venueId },
      select: {
        id: true,
        orderId: true,
        orderType: true,
        status: true,
        startedAt: true,
        preparationVersion: true,
        printStationId: true,
        fallbackPrintedAt: true,
        printedAt: true,
        customerName: true,
        customerContact: true,
        createdAt: true,
        _count: { select: { items: true } },
      },
      take: porComanda.size,
    })

    let movidas = 0
    for (const c of comandas) {
      let quedan = c._count.items
      for (const [dueno, ids] of porComanda.get(c.id) ?? []) {
        const orderNumber = numeros.get(dueno) ?? '—'
        let destino = c.id
        let movidasAqui: number
        if (ids.length === quedan) {
          // La comanda entera cambia de dueño sólo si sigue siendo de quien se leyó (CAS).
          const cambio = await tx.kdsOrder.updateMany({
            where: { id: c.id, venueId, orderId: c.orderId, status: { not: 'COMPLETED' } },
            data: { orderId: dueno, orderNumber },
          })
          movidasAqui = cambio.count ? ids.length : 0
        } else {
          // Folio nuevo en cada movimiento (Codex r1 #2): reusar uno viejo podía caer en la comanda de otra cuenta anulada.
          const { _count, id, ...igual } = c
          const sourceKey = `order:${dueno}:de:${id}:${randomUUID().slice(0, 8)}`
          destino = (
            await tx.kdsOrder.create({ data: { ...igual, venueId, sourceKey, orderId: dueno, orderNumber }, select: { id: true } })
          ).id
          // Sólo las filas que siguen en la comanda leída (CAS); si otra cuenta ya se las llevó, el folio nuevo sobra.
          movidasAqui = (await tx.kdsOrderItem.updateMany({ where: { id: { in: ids }, kdsOrderId: c.id }, data: { kdsOrderId: destino } }))
            .count
          if (movidasAqui === 0) await tx.kdsOrder.delete({ where: { id: destino } })
          quedan -= movidasAqui
        }
        if (movidasAqui === 0) continue
        movidas += movidasAqui
        tocadas.add(c.id).add(destino)
        if (c.preparationVersion === PREPARATION_VERSION) conPreparacion.add(c.id).add(destino)
      }
      // Dos movimientos a la vez pueden vaciarla sin que ninguno se la lleve entera: una comanda vacía no se queda en la pantalla.
      await tx.kdsOrder.deleteMany({ where: { id: c.id, venueId, status: { not: 'COMPLETED' }, items: { none: {} } } })
    }
    if (movidas > 0) sinAvanzar = 0
    else if (++sinAvanzar >= 10) {
      // Otra cuenta movía lo mismo una y otra vez: mejor que la operación se reintente a que la anulación borre algo ajeno.
      throw new ConflictError('La comanda de cocina cambió mientras se movía. Vuelve a intentar.', 'KDS_ORDER_OWNER_CHANGED')
    }
  }
  // Con preparación por producto el estado de una comanda sale de sus productos (`applyKitchenPreparation`): se recalcula en la de
  // origen y en la nueva, las dos bajo el candado de su cuenta.
  for (const id of conPreparacion) {
    const items = await tx.kdsOrderItem.findMany({ where: { kdsOrderId: id }, select: { quantity: true, preparation: true }, take: 5000 })
    const status = preparationTicketStatus(items.map(i => parsePreparation(i.preparation, i.quantity)))
    await tx.kdsOrder.updateMany({
      where: { id, venueId, preparationVersion: PREPARATION_VERSION },
      data: { status, completedAt: status === 'COMPLETED' ? new Date() : null },
    })
  }
  return [...tocadas]
}
