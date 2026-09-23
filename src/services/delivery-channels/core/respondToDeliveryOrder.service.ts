/**
 * Que la cocina pueda decir "sí lo hago" o "no puedo" a un pedido de marketplace.
 *
 * 🔴 POR QUÉ EXISTE: el modo MANUAL ya se podía activar desde el dashboard, pero NO había
 * forma de aceptar un pedido. El resultado era una trampa perfecta: el dueño prende MANUAL
 * creyendo que va a revisar cada pedido, entran los pedidos, nadie puede aceptarlos, y Uber
 * los cancela a los ~11.5 minutos. TODOS. En silencio, y sin que nada falle.
 *
 * 🔴 Y responde la otra mitad del problema: ¿qué pasa cuando el marketplace vende algo que
 * la cocina no puede preparar? Pasa de verdad —un venue sin inventario nunca marca nada como
 * agotado, así que Uber lo sigue vendiendo—, y hasta hoy el personal no tenía salida: el
 * pedido se aceptaba solo y llegaba a la cocina un platillo imposible.
 *
 * Hay DOS momentos y no son lo mismo:
 *   · ANTES de aceptar  → `denyDeliveryOrder`. Es un rechazo limpio; el cliente se entera
 *     de inmediato y Uber le devuelve su dinero sin fricción.
 *   · DESPUÉS de aceptar → cancelar (`cancelDeliveryOrder`). Ya dijimos que sí, así que
 *     cuesta más caro: el cliente ya está esperando. Sigue siendo mejor que no entregar.
 */
import { DeliveryProvider, OrderStatus, Prisma } from '@prisma/client'

import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'

import { adapterFor, hasAdapter } from './adapterRegistry'
import { cancelDeliveryOrder } from './cancelDeliveryOrder.service'
import { soltarReserva, tomarReserva, withDeliveryOrderLock, type OperacionDeReparto } from './deliveryOrderLock'
import type { ActionResult } from './types'

export type MotivoRechazo = 'OUT_OF_ITEMS' | 'STORE_CLOSED' | 'TOO_BUSY' | 'OTHER'

export interface RespuestaPedido {
  outcome:
    | 'ACCEPTED'
    | 'DENIED'
    | 'CANCELLED'
    | 'READY'
    | 'ALREADY_DONE'
    | 'NOT_A_DELIVERY_ORDER'
    | 'FAILED'
    // Spec §3.2: otra salida a Uber tiene tomado el pedido — no se le habla a Uber.
    | 'OP_IN_PROGRESS'
    // Hay un retiro de renglón PENDING|UNCERTAIN: un cambio a la vez por pedido.
    | 'LINE_ACTION_IN_PROGRESS'
  error?: string
  /** Con `OP_IN_PROGRESS`: qué operación tiene el pedido. */
  ocupadaPor?: OperacionDeReparto
}

/**
 * ¿Esta respuesta del proveedor PRUEBA que la acción ocurrió? Sólo un 2xx/3xx. El 409 sigue
 * siendo "ok" en el adaptador (no repetir la acción), pero no acredita nada: puede significar
 * "ya estaba" o "el estado es otro". Y el placeholder MANUAL del auto-accept trae status 0.
 */
export const esEvidenciaHttp = (status: number) => status >= 200 && status < 400

type Salida = { tipo: 'BLOQUEADA'; respuesta: RespuestaPedido } | { tipo: 'TARDIA' } | { tipo: 'HECHA'; r: ActionResult }

/**
 * Protocolo de reserva de spec §3.2, igual para accept · ready · deny (y el retiro):
 *  (a) tomar la reserva con token — si otra operación la tiene viva, no se le habla a Uber;
 *  (b) la llamada HTTP, FUERA de todo candado de Postgres;
 *  (c) bajo el candado: soltar la reserva y aplicar el resultado SÓLO si la reserva seguía
 *      siendo nuestra. Si no, el resultado es TARDÍO: no se aplica y queda en ActivityLog.
 * La reserva se suelta en `finally`: una llamada que lanza no deja el pedido tomado 2 min.
 */
async function conReserva(
  venueId: string,
  orderId: string,
  op: OperacionDeReparto,
  llamar: () => Promise<ActionResult>,
  aplicar?: (tx: Prisma.TransactionClient, r: ActionResult) => Promise<unknown>,
  /** Se revisa YA con la reserva en mano: lo que otro terminó entre la lectura y la reserva no se repite. */
  yaHecho?: () => Promise<boolean>,
): Promise<Salida> {
  const reserva = await tomarReserva(orderId, op)
  if (!reserva.ok) {
    logger.warn('[Delivery] operación omitida: el pedido tiene otra salida a Uber en vuelo', {
      orderId,
      op,
      ocupadaPor: reserva.ocupadaPor,
    })
    return { tipo: 'BLOQUEADA', respuesta: { outcome: 'OP_IN_PROGRESS', ocupadaPor: reserva.ocupadaPor } }
  }
  let soltada = false
  try {
    // Con la reserva en mano nadie abre un retiro nuevo: lo que haya aquí ya estaba en curso.
    const retiros = await prisma.deliveryLineAction.count({ where: { orderId, status: { in: ['PENDING', 'UNCERTAIN'] } } })
    if (retiros > 0) return { tipo: 'BLOQUEADA', respuesta: { outcome: 'LINE_ACTION_IN_PROGRESS' } }
    if (yaHecho && (await yaHecho())) return { tipo: 'BLOQUEADA', respuesta: { outcome: 'ALREADY_DONE' } }

    const r = await llamar()
    const aTiempo = await withDeliveryOrderLock(orderId, async tx => {
      const mia = await soltarReserva(orderId, reserva.token, tx)
      if (mia && aplicar) await aplicar(tx, r)
      return mia
    })
    soltada = true
    if (!aTiempo) {
      logger.error('🚨 [Delivery] resultado TARDÍO de Uber: la reserva ya era de otra operación, NO se aplica', {
        orderId,
        op,
        status: r.status,
      })
      await logAction({
        venueId,
        action: 'DELIVERY_OP_LATE_RESULT',
        entity: 'Order',
        entityId: orderId,
        data: { operacion: op, httpStatus: r.status, ok: r.ok },
      })
      return { tipo: 'TARDIA' }
    }
    return { tipo: 'HECHA', r }
  } finally {
    if (!soltada) {
      await soltarReserva(orderId, reserva.token).catch(e =>
        logger.error('🚨 [Delivery] no se pudo soltar la reserva (vence sola en 2 min)', { orderId, op, error: String(e) }),
      )
    }
  }
}

/** Respaldo para órdenes previas al cambio: la orden aún no guardaba su propio link. */
async function linkPorEventoOriginador(
  venueId: string,
  orderId: string,
  provider: DeliveryProvider,
  db: Prisma.TransactionClient = prisma,
) {
  const evento = await db.deliveryOrderEvent.findFirst({
    where: { orderId, venueId, channelLinkId: { not: null } },
    orderBy: { receivedAt: 'asc' },
    select: { channelLinkId: true },
  })
  if (!evento?.channelLinkId) return null
  return db.deliveryChannelLink.findFirst({
    where: { id: evento.channelLinkId, venueId, provider },
    select: { provider: true, externalLocationId: true },
  })
}

/**
 * El pedido, su canal y el id que el proveedor entiende. Sin esto no se le puede contestar.
 *
 * Exportada (Tarea 8, KDS "¿quién trae esto?"): es la MISMA resolución de link que usan
 * accept/deny/ready — reusarla evita un segundo camino que podría resolver a un canal
 * distinto para la misma orden. `db` permite leer con el `tx` de quien ya sostiene el candado
 * del pedido (`applyLineRemoval`), en vez de pedir otra conexión mientras retiene una.
 */
export async function contexto(venueId: string, orderId: string, db: Prisma.TransactionClient = prisma) {
  const order = await db.order.findFirst({
    where: { id: orderId, venueId },
    select: {
      id: true,
      externalId: true,
      status: true,
      orderNumber: true,
      deliveryChannelLinkId: true,
      providerAcceptedAt: true,
      readyReportedAt: true,
    },
  })
  if (!order?.externalId) return null

  // `PROVEEDOR:idDelProveedor` — el prefijo existe porque dos marketplaces pueden repetir
  // folio, y aquí hay que devolverle a Uber el id que ÉL conoce, sin el prefijo.
  const sep = order.externalId.indexOf(':')
  if (sep < 0) return null
  const provider = order.externalId.slice(0, sep) as DeliveryProvider
  const externalOrderId = order.externalId.slice(sep + 1)
  if (!hasAdapter(provider)) return null

  // 🔴 El link se resuelve por la ORDEN. `findFirst({ venueId, provider })` elegía la PRIMERA
  // tienda del negocio: con dos tiendas, autorizaba contra A y escribía sobre un pedido de B.
  const link = order.deliveryChannelLinkId
    ? await db.deliveryChannelLink.findFirst({
        // El link debe ser del MISMO proveedor que el pedido; si no, no se le contesta a nadie.
        where: { id: order.deliveryChannelLinkId, venueId, provider },
        select: { provider: true, externalLocationId: true },
      })
    : await linkPorEventoOriginador(venueId, order.id, provider, db) // DeliveryOrderEvent.channelLinkId, para órdenes previas al cambio
  if (!link) return null

  return { order, provider, externalOrderId, storeId: link.externalLocationId, adapter: adapterFor(provider) }
}

/**
 * "La comida ya está lista." Avisa al marketplace para que mande (o apure) al repartidor.
 *
 * 🔴 Lo llama el flujo del KDS en CADA comanda que se marca lista — de mesa, mostrador o
 * delivery—, así que una venta que no es de marketplace es un NO-OP silencioso, jamás un
 * error: si esto lanzara, marcar lista una hamburguesa de mesa fallaría.
 *
 * La validación de producción de Uber (caso 59605086) exige ver esta llamada funcionando
 * ("Order: Mark Order as Ready"). El gesto humano ya existía; esto sólo lo conecta.
 */
export async function markDeliveryOrderReady(venueId: string, orderId: string): Promise<RespuestaPedido> {
  const ctx = await contexto(venueId, orderId)
  if (!ctx) return { outcome: 'NOT_A_DELIVERY_ORDER' }
  if (typeof ctx.adapter.markOrderReady !== 'function') return { outcome: 'NOT_A_DELIVERY_ORDER' }
  // «Listo» es irrevocable: con un 2xx ya acreditado no hay nada que volver a decirle a Uber.
  if (ctx.order.readyReportedAt) return { outcome: 'ALREADY_DONE' }

  const s = await conReserva(
    venueId,
    orderId,
    'READY',
    () => ctx.adapter.markOrderReady!(ctx.externalOrderId, ctx.storeId),
    (tx, r) =>
      esEvidenciaHttp(r.status)
        ? tx.order.updateMany({ where: { id: orderId, readyReportedAt: null }, data: { readyReportedAt: new Date() } })
        : Promise.resolve(),
    // El 2xx del bump pudo acreditarse entre la lectura de arriba y la reserva: no se manda otro /ready.
    async () => Boolean((await prisma.order.findUnique({ where: { id: orderId }, select: { readyReportedAt: true } }))?.readyReportedAt),
  )
  // Reserva tomada: el aviso se omite y `readyReportedAt` queda nulo para que el job lo reintente.
  if (s.tipo === 'BLOQUEADA') return s.respuesta
  if (s.tipo === 'TARDIA') return { outcome: 'FAILED', error: 'RESULTADO_TARDIO' }
  const r = s.r
  if (!r.ok) {
    logger.warn('El marketplace rechazó el "listo" del pedido', {
      orderId,
      externalOrderId: ctx.externalOrderId,
      status: r.status,
      cuerpo: r.raw.slice(0, 200),
    })
    return { outcome: 'FAILED', error: r.raw.slice(0, 200) }
  }
  return { outcome: 'READY' }
}

/** "Sí lo preparo." Para venues en modo MANUAL, donde nadie acepta por ellos. */
export async function acceptDeliveryOrder(venueId: string, orderId: string, staffId?: string): Promise<RespuestaPedido> {
  const ctx = await contexto(venueId, orderId)
  if (!ctx) return { outcome: 'NOT_A_DELIVERY_ORDER' }
  if (typeof ctx.adapter.acceptOrder !== 'function') return { outcome: 'FAILED', error: 'PROVEEDOR_SIN_ACEPTAR' }

  const s = await conReserva(
    venueId,
    orderId,
    'ACCEPT',
    () => ctx.adapter.acceptOrder!(ctx.externalOrderId, ctx.storeId),
    // 🔴 Sólo el 2xx acredita. El 409 sigue siendo "ok" (no se repite el accept) pero no prueba
    // nada: la marca, si falta, la recupera `recuperarAceptacionDesdeProveedor` leyendo a Uber.
    (tx, r) =>
      esEvidenciaHttp(r.status)
        ? tx.order.updateMany({
            where: { id: orderId, providerAcceptedAt: null },
            data: { providerAcceptedAt: new Date(), providerAcceptedEvidence: 'HTTP_2XX' },
          })
        : Promise.resolve(),
  )
  if (s.tipo === 'BLOQUEADA') return s.respuesta
  if (s.tipo === 'TARDIA') return { outcome: 'FAILED', error: 'RESULTADO_TARDIO' }
  const r = s.r
  if (!r.ok) {
    // Pasado el plazo, el proveedor ya lo canceló y no hay nada que aceptar. Se dice con
    // ese nombre para que el mesero entienda que no es un error suyo ni un reintento útil.
    const muerto = /no longer active|not active|cancel/i.test(r.raw)
    logger.error('🚨 [Delivery] no se pudo aceptar el pedido', { orderId, status: r.status, muerto })
    return { outcome: 'FAILED', error: muerto ? 'PEDIDO_YA_NO_ACTIVO' : `HTTP ${r.status}` }
  }

  logger.info('👍 [Delivery] pedido aceptado a mano', { orderId, orderNumber: ctx.order.orderNumber, staffId })
  return { outcome: 'ACCEPTED' }
}

/**
 * "No puedo prepararlo."
 *
 * Elige solo el camino correcto según dónde esté el pedido: rechazo limpio si todavía no se
 * había aceptado, cancelación si ya. Que el mesero tenga que saber la diferencia sería
 * pedirle que entienda el protocolo de Uber para poder decir que se acabó la carne.
 */
export async function denyDeliveryOrder(
  venueId: string,
  orderId: string,
  motivo: MotivoRechazo = 'OUT_OF_ITEMS',
  staffId?: string,
): Promise<RespuestaPedido> {
  const ctx = await contexto(venueId, orderId)
  if (!ctx) return { outcome: 'NOT_A_DELIVERY_ORDER' }
  if (ctx.order.status === OrderStatus.CANCELLED) return { outcome: 'ALREADY_DONE' }

  // CONFIRMED significa que ya le dijimos que sí al proveedor: el camino es cancelar.
  const yaAceptado = ctx.order.status === OrderStatus.CONFIRMED

  if (yaAceptado) {
    const s = await conReserva(venueId, orderId, 'DENY', async () =>
      typeof ctx.adapter.cancelOrder === 'function'
        ? ctx.adapter.cancelOrder(ctx.externalOrderId, ctx.storeId, motivo)
        : { ok: true, status: 0, raw: 'el proveedor no cancela por API' },
    )
    if (s.tipo === 'BLOQUEADA') return s.respuesta
    if (s.tipo === 'TARDIA') return { outcome: 'FAILED', error: 'RESULTADO_TARDIO' }
    if (!s.r.ok) return { outcome: 'FAILED', error: `HTTP ${s.r.status}` }
    // Y del lado de Avoqado: sale de la cocina, deja de contar como venta, y el inventario
    // regresa. Es la misma rutina que una cancelación del proveedor.
    await cancelDeliveryOrder(ctx.externalOrderId, ctx.provider, `el negocio no pudo prepararlo: ${motivo}`)
    logger.info('🚫 [Delivery] pedido ya aceptado, CANCELADO por el negocio', { orderId, motivo, staffId })
    return { outcome: 'CANCELLED' }
  }

  if (typeof ctx.adapter.denyOrder !== 'function') return { outcome: 'FAILED', error: 'PROVEEDOR_SIN_RECHAZAR' }
  const s = await conReserva(venueId, orderId, 'DENY', () => ctx.adapter.denyOrder!(ctx.externalOrderId, ctx.storeId, motivo))
  if (s.tipo === 'BLOQUEADA') return s.respuesta
  if (s.tipo === 'TARDIA') return { outcome: 'FAILED', error: 'RESULTADO_TARDIO' }
  if (!s.r.ok) return { outcome: 'FAILED', error: `HTTP ${s.r.status}` }

  await cancelDeliveryOrder(ctx.externalOrderId, ctx.provider, `rechazado por el negocio: ${motivo}`)
  logger.info('🚫 [Delivery] pedido RECHAZADO antes de aceptar', { orderId, motivo, staffId })
  return { outcome: 'DENIED' }
}

/**
 * Recupera una aceptación cuyo 2xx se perdió: LEE el pedido al proveedor y, si dice que ya
 * está aceptado, estampa `PROVIDER_STATE`. Devuelve si el pedido está (ahora) aceptado.
 *
 * Ante cualquier duda —sin capacidad de leer, GET caído, pedido que no se puede normalizar—
 * contesta `false`: lo seguro es NO afirmar una aceptación que no se pudo probar.
 */
export async function recuperarAceptacionDesdeProveedor(venueId: string, orderId: string): Promise<boolean> {
  const ctx = await contexto(venueId, orderId)
  if (!ctx) return false
  if (ctx.order.providerAcceptedAt) return true
  if (typeof ctx.adapter.fetchOrder !== 'function') return false

  let aceptado: boolean
  try {
    aceptado = ctx.adapter.normalizeOrder(await ctx.adapter.fetchOrder(ctx.externalOrderId)).providerAccepted === true
  } catch (e) {
    logger.warn('[Delivery] no se pudo leer el pedido al proveedor para recuperar su aceptación', { orderId, error: String(e) })
    return false
  }
  if (!aceptado) return false

  await prisma.order.updateMany({
    where: { id: orderId, providerAcceptedAt: null },
    data: { providerAcceptedAt: new Date(), providerAcceptedEvidence: 'PROVIDER_STATE' },
  })
  return true
}
