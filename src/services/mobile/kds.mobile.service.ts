/**
 * Mobile KDS Service
 *
 * Kitchen Display System management for mobile apps (iOS, Android).
 * Creates, lists, and updates KDS orders that kitchen staff sees
 * on the display after a payment completes with products.
 */

import logger from '../../config/logger'
import { BadRequestError, NotFoundError, ProviderUnavailableError } from '../../errors/AppError'
import { contexto, markDeliveryOrderReady } from '@/services/delivery-channels/core/respondToDeliveryOrder.service'
import type { CourierInfo } from '@/services/delivery-channels/core/types'
import prisma from '../../utils/prismaClient'
import { OrderStatus } from '@prisma/client'
import type { KdsOrderStatus } from '@prisma/client'
import { anexarCapacidades, ventasDeComandas, type EstadoRetiro, type VentaDeComanda } from './kdsCapacidades'

// Use string constants instead of Prisma enum to avoid runtime import issues with tsx
const KdsStatus = {
  NEW: 'NEW' as const,
  PREPARING: 'PREPARING' as const,
  READY: 'READY' as const,
  COMPLETED: 'COMPLETED' as const,
}
const VALID_STATUSES = ['NEW', 'PREPARING', 'READY', 'COMPLETED']

// MARK: - Modificadores: UNA sola forma para los dos productores

/**
 * 🔴 `KdsOrderItem.modifiers` la escriben DOS productores y hasta el 2026-08-20 cada uno
 * guardaba una forma distinta: el POS `["Sin cebolla"]`, la ingesta de marketplace
 * `[{"name":"Extra queso","quantity":1}]`. El lector sólo hacía `JSON.parse`, así que la
 * diferencia llegaba entera a la cocina — verificado en una Sunmi D3 con un pedido real de
 * Uber: Android pintó el JSON crudo y iOS falló el cast a `[String]` y **perdió el
 * modificador sin dejar rastro**. Un modificador perdido es un platillo mal servido.
 *
 * El esquema no protege la FORMA de un valor serializado; sólo una función compartida lo
 * hace. Por eso los dos productores normalizan con ÉSTA antes de escribir —incluida
 * `deliveryOrderIngestion.service.ts`, que la importa— y el lector la vuelve a aplicar para
 * sanar las filas que ya se escribieron mal.
 */
export type KdsModifierInput = string | { name?: string | null; quantity?: number | null } | null | undefined

export function toKdsModifierLabels(modifiers: KdsModifierInput[] | null | undefined): string[] {
  if (!Array.isArray(modifiers)) return []

  return modifiers.reduce<string[]>((etiquetas, modificador) => {
    if (typeof modificador === 'string') {
      const texto = modificador.trim()
      if (texto) etiquetas.push(texto)
      return etiquetas
    }

    const nombre = modificador?.name?.trim()
    // Sin nombre no hay nada que preparar: se descarta en vez de escribir "undefined" en la
    // comanda, que es ruido que el cocinero tiene que interpretar a media comida.
    if (!nombre) return etiquetas

    const cantidad = modificador?.quantity ?? 1
    etiquetas.push(cantidad > 1 ? `${cantidad}x ${nombre}` : nombre)
    return etiquetas
  }, [])
}

/**
 * Lee la columna cruda. Tolera JSON corrupto A PROPÓSITO: `JSON.parse` suelto tiraba TODO el
 * endpoint con un throw, o sea que una fila mala dejaba a la cocina sin las otras 30
 * comandas. Perder un modificador es malo; perder el tablero completo es peor.
 */
export function parseKdsModifiers(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    return toKdsModifierLabels(JSON.parse(raw))
  } catch {
    logger.warn(`KDS: modificadores ilegibles en la comanda, se muestran vacíos: ${raw.slice(0, 120)}`)
    return []
  }
}

// MARK: - Types

export interface CreateKdsOrderItemInput {
  productName: string
  quantity: number
  modifiers?: string[]
  notes?: string | null
}

export interface CreateKdsOrderInput {
  orderNumber: string
  orderType?: string
  orderId?: string | null
  items: CreateKdsOrderItemInput[]
}

export interface KdsOrderResponse {
  id: string
  orderNumber: string
  orderType: string
  orderId: string | null
  status: KdsOrderStatus
  /** Falta que la cocina lo acepte en la app de delivery (sólo en canales MANUAL). */
  needsAcceptance?: boolean
  /** ¿Falta que un aparato reclame e imprima esta comanda? Sólo para pedidos de marketplace. */
  needsPrint?: boolean
  /**
   * Nombre y contacto (con PIN) del cliente, para pedidos de delivery — la cocina lee esta
   * pantalla y no el detalle de la orden. `null` en comandas que no son de reparto.
   */
  customerName?: string | null
  customerContact?: string | null
  /** Reparto (Tarea 16): lo decide el servidor, las apps sólo leen. Ausentes fuera de reparto. */
  canCancelDelivery?: boolean
  deliveryOpInFlight?: string | null
  hasLineActionInProgress?: boolean
  items: Array<{
    id: string
    productName: string
    quantity: number
    modifiers: string[]
    notes: string | null
    removedAt?: string | null
    canReportOutOfStock?: boolean
    lineActionState?: EstadoRetiro | null
    lineActionAttempts?: number | null
    canRetryAt?: string | null
  }>
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}

// MARK: - List KDS Orders

/**
 * Get active KDS orders for a venue, filtered by status.
 * Default: NEW, PREPARING, READY (active orders only).
 */
/**
 * Tope de comandas por lectura del tablero. Una cocina real no tiene 100 pendientes a la vez;
 * el tope existe para cuando NADIE las termina: el POS crea una comanda por venta y un negocio
 * sin pantalla de cocina las acumula. Testarudo juntó 3,068 y, al abrir la pantalla una vez
 * (2026-09-24), el servidor leyó 3,068 comandas + 3,060 ventas — y la pantalla sondea cada 10 s.
 */
export const KDS_LIST_MAX = 100

function statusesDelFiltro(statusFilter?: string): KdsOrderStatus[] {
  if (!statusFilter) return [KdsStatus.NEW, KdsStatus.PREPARING, KdsStatus.READY] as KdsOrderStatus[]
  return statusFilter
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => VALID_STATUSES.includes(s)) as KdsOrderStatus[]
}

/** Cuántas comandas coinciden en total: lo que el tope deja fuera no se pierde en silencio. */
export async function countKdsOrders(venueId: string, statusFilter?: string): Promise<number> {
  return prisma.kdsOrder.count({ where: { venueId, status: { in: statusesDelFiltro(statusFilter) } } })
}

export async function listKdsOrders(venueId: string, statusFilter?: string): Promise<KdsOrderResponse[]> {
  // Las MÁS RECIENTES primero para aplicar el tope — con un rezago acumulado, la cocina debe
  // seguir viendo lo que acaba de entrar, no lo de hace un mes — y luego se voltean para
  // entregarlas de la más vieja a la más nueva, como siempre. `id` desempata en el mismo instante.
  const recientes = await prisma.kdsOrder.findMany({
    where: {
      venueId,
      status: { in: statusesDelFiltro(statusFilter) },
    },
    include: {
      items: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: KDS_LIST_MAX,
  })
  const orders = recientes.reverse()

  // 🔴 Consultas aparte y no un `include`: `KdsOrder.orderId` es un `String?` SUELTO, sin relación con
  // `Order` — un `include` revienta en runtime (y la orden puede estar borrada: ausencia = "no falta
  // aceptar", no error). `Order.status` PENDING = nadie le ha dicho que sí al proveedor y el reloj de
  // ~11.5 min ya corre. Las capacidades del reparto (Tarea 16) salen del MISMO lote: consultas fijas.
  const ventas = await ventasDeComandas(prisma, venueId, orders)

  return orders.map(o => formatKdsOrderConVenta(o, o.orderId ? ventas.get(o.orderId) : undefined))
}

/**
 * La comanda con lo que depende de su VENTA, calculado en UN solo sitio (el tablero y la ruta
 * «no tengo este artículo» devuelven la misma comanda y no pueden contestar distinto).
 * `type === 'DELIVERY'` es lo que separa "llegó solo" de "lo mandó un mesero": sólo lo primero
 * necesita que alguien reclame la impresión, y sólo un reparto PENDING necesita que lo acepten.
 * Un reparto trae además sus capacidades (spec «Apps»), opcionales y ausentes fuera de reparto.
 */
export function formatKdsOrderConVenta(o: any, venta?: VentaDeComanda | null): KdsOrderResponse {
  const esReparto = venta?.type === 'DELIVERY'
  const base = formatKdsOrder({ ...o, esDeMarketplace: esReparto }, esReparto && venta?.status === 'PENDING')
  return venta ? anexarCapacidades(base, o, venta) : base
}

/** La comanda recién escrita, con su venta: `PUT …/status` y `bump` contestan lo mismo que el tablero (una carga por lote). */
async function comandaConVenta(venueId: string, k: { orderId: string | null }): Promise<KdsOrderResponse> {
  // La comanda YA se escribió: si esta lectura falla, la cocina recibe su comanda sin capacidades
  // (campos opcionales, llegan en el siguiente sondeo) y el aviso de «listo» al proveedor sale igual.
  try {
    const ventas = await ventasDeComandas(prisma, venueId, [k])
    return formatKdsOrderConVenta(k, k.orderId ? ventas.get(k.orderId) : undefined)
  } catch (error) {
    logger.warn('KDS: no se pudieron leer las capacidades de la comanda; se contesta sin ellas', { venueId, orderId: k.orderId, error })
    return formatKdsOrder(k)
  }
}

// MARK: - Create KDS Order

/**
 * Create a new KDS order after payment succeeds.
 */
export async function createKdsOrder(venueId: string, input: CreateKdsOrderInput): Promise<KdsOrderResponse> {
  if (!input.orderNumber) {
    throw new BadRequestError('Se requiere orderNumber')
  }
  if (!input.items || input.items.length === 0) {
    throw new BadRequestError('Se requiere al menos un item')
  }

  const order = await prisma.kdsOrder.create({
    data: {
      venueId,
      orderNumber: input.orderNumber,
      orderType: input.orderType || 'DINE_IN',
      orderId: input.orderId || null,
      status: KdsStatus.NEW,
      items: {
        create: input.items.map(item => ({
          productName: item.productName,
          quantity: item.quantity,
          modifiers: item.modifiers?.length ? JSON.stringify(toKdsModifierLabels(item.modifiers)) : null,
          notes: item.notes || null,
        })),
      },
    },
    include: {
      items: true,
    },
  })

  logger.info(`KDS order created: #${order.orderNumber} for venue ${venueId}`)
  return formatKdsOrder(order)
}

// MARK: - Update KDS Order Status

/**
 * Update the status of a KDS order (NEW -> PREPARING -> READY -> COMPLETED).
 */
export async function updateKdsOrderStatus(venueId: string, orderId: string, newStatus: string): Promise<KdsOrderResponse> {
  const upperStatus = newStatus.toUpperCase()

  if (!VALID_STATUSES.includes(upperStatus)) {
    throw new BadRequestError(`Estado invalido: ${newStatus}. Valores: ${VALID_STATUSES.join(', ')}`)
  }

  const existing = await prisma.kdsOrder.findFirst({
    where: { id: orderId, venueId },
  })

  if (!existing) {
    throw new NotFoundError('Orden KDS no encontrada')
  }

  const now = new Date()
  const updateData: any = { status: upperStatus }

  if (upperStatus === KdsStatus.PREPARING && !existing.startedAt) {
    updateData.startedAt = now
  }
  if (upperStatus === KdsStatus.COMPLETED) {
    updateData.completedAt = now
  }

  const updated = await prisma.kdsOrder.update({
    where: { id: orderId },
    data: updateData,
    include: { items: true },
  })

  logger.info(`KDS order #${updated.orderNumber} status -> ${upperStatus}`)
  // Antes del aviso al marketplace: la respuesta describe el estado que ESTA escritura dejó.
  const respuesta = await comandaConVenta(venueId, updated)

  // "Listo" en la cocina = avisarle al marketplace que mande al repartidor. Best-effort y
  // FUERA del camino del tablero: un marketplace caído no puede impedir que la cocina
  // avance sus comandas. Para ventas que no son de delivery es un no-op adentro.
  if ((upperStatus === KdsStatus.READY || upperStatus === KdsStatus.COMPLETED) && updated.orderId) {
    avisarListoAlMarketplace(venueId, updated.orderId, updated.orderNumber)
  }

  return respuesta
}

/**
 * Fire-and-forget: el aviso de "listo" al marketplace nunca bloquea ni tumba el KDS.
 * Uber trata el reintento como éxito (409 = "ya estaba listo"), así que avisar dos veces
 * (READY y luego COMPLETED) es inofensivo.
 */
function avisarListoAlMarketplace(venueId: string, orderId: string, orderNumber: string): void {
  void markDeliveryOrderReady(venueId, orderId).catch(error => {
    logger.warn('No se pudo avisar el "listo" al marketplace (la comanda avanzó igual)', {
      orderId,
      orderNumber,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

// MARK: - Bump Order (instant complete)

/**
 * Instantly mark a KDS order as COMPLETED.
 */
export async function bumpKdsOrder(venueId: string, orderId: string): Promise<KdsOrderResponse> {
  const existing = await prisma.kdsOrder.findFirst({
    where: { id: orderId, venueId },
  })

  if (!existing) {
    throw new NotFoundError('Orden KDS no encontrada')
  }

  const updated = await prisma.kdsOrder.update({
    where: { id: orderId },
    data: {
      status: KdsStatus.COMPLETED,
      completedAt: new Date(),
    },
    include: { items: true },
  })

  logger.info(`KDS order #${updated.orderNumber} bumped to COMPLETED`)
  const respuesta = await comandaConVenta(venueId, updated)

  // El bump salta directo a COMPLETED sin pasar por READY — el aviso al marketplace no se
  // puede perder por tomar el atajo.
  if (updated.orderId) {
    avisarListoAlMarketplace(venueId, updated.orderId, updated.orderNumber)
  }

  return respuesta
}

// MARK: - Helper

function formatKdsOrder(order: any, needsAcceptance = false): KdsOrderResponse {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    orderId: order.orderId,
    status: order.status,
    customerName: order.customerName ?? null,
    customerContact: order.customerContact ?? null,
    items: (order.items || []).map((item: any) => ({
      id: item.id,
      productName: item.productName,
      quantity: item.quantity,
      modifiers: parseKdsModifiers(item.modifiers),
      notes: item.notes,
      // Los ids que el POS necesita para RUTEAR la comanda a su estación. `null` = no
      // supimos de qué producto es; el motor lo manda al ticket "SIN ESTACIÓN" en vez de
      // no imprimirlo.
      productId: item.productId ?? null,
      categoryId: item.categoryId ?? null,
    })),
    /**
     * 🔴 ¿Falta que alguien acepte este pedido en la app de delivery?
     *
     * Sólo es `true` en canales configurados en MANUAL: ahí la venta entra PENDING porque
     * NADIE le ha dicho que sí al proveedor todavía, y el plazo (~11.5 min en Uber) ya está
     * corriendo. En AUTO siempre es `false` — el sistema ya contestó en segundos.
     *
     * Es el dato que hace posible el botón "Aceptar" en la cocina. Sin él, el modo MANUAL
     * perdía TODOS los pedidos en silencio.
     */
    needsAcceptance,
    /**
     * ¿Esta comanda todavía no sale en papel?
     *
     * Sólo aplica a pedidos que llegaron SOLOS (marketplace): los que manda un mesero desde
     * una tablet ya se imprimen en ese mismo gesto. Aquí no hay gesto humano — el pedido
     * aparece en todas las pantallas a la vez, y alguien tiene que reclamar el trabajo.
     *
     * `false` en cuanto alguien lo reclama, no cuando termina: si se esperara al papel, las
     * demás tablets seguirían viéndolo pendiente los segundos que tarda la impresión y lo
     * reclamarían también.
     */
    needsPrint: Boolean(order.esDeMarketplace) && comandaPendienteDeImprimir(order),
    startedAt: order.startedAt?.toISOString() || null,
    completedAt: order.completedAt?.toISOString() || null,
    createdAt: order.createdAt.toISOString(),
  }
}

// ════════════════════════════════════════════════════════════════════════════════════
//  Quién imprime una comanda que llegó SOLA
// ════════════════════════════════════════════════════════════════════════════════════

/**
 * Cuánto vale una reclamación antes de que otro aparato pueda retomarla.
 *
 * 90 segundos: lo suficiente para bajar la configuración de impresión y sacar el papel
 * —incluso con red mala—, y lo bastante corto para que la cocina no se quede esperando si
 * la tablet que ganó se apagó. Es el único número de este mecanismo, y el error caro sería
 * hacerlo grande: una comanda enterrada 10 minutos es un pedido que nadie preparó.
 */
export const PRINT_CLAIM_TTL_MS = 90_000

/**
 * ¿Esta comanda sigue necesitando que ALGUIEN la imprima?
 *
 * 🔴 Una reclamación VENCIDA cuenta como libre, y esa es la mitad que faltaba: el server ya
 * permitía RETOMAR una reclamación vieja, pero los clientes sólo reclaman lo que ven
 * pendiente. Si esto se apagara para siempre en cuanto alguien reclama, la tablet que
 * reclamó y murió —batería, papel, red— enterraría la comanda: ningún aparato volvería a
 * llamar claim-print y el TTL sería letra muerta.
 *
 * El empate se rompe hacia IMPRIMIR DE MÁS, nunca hacia no imprimir (regla del dominio):
 * si una tablet imprimió pero no logró confirmar, a los 90s otra puede sacar un duplicado.
 * Un papel repetido molesta; un pedido del que la cocina no se enteró cuesta el pedido.
 */
export function comandaPendienteDeImprimir(o: { printedAt?: Date | null; printClaimedAt?: Date | null }): boolean {
  if (o.printedAt) return false
  if (!o.printClaimedAt) return true
  return o.printClaimedAt.getTime() < Date.now() - PRINT_CLAIM_TTL_MS
}

/**
 * "Yo la imprimo." Devuelve si este aparato ganó.
 *
 * 🔴 Un `updateMany` atómico, NO leer-y-luego-escribir. La diferencia es el bug entero: con
 * lectura previa hay una ventana entre consultar y mutar, y dos tablets que preguntan en el
 * mismo instante ganan LAS DOS. Aquí gana quien la base deje pasar primero, y el perdedor
 * recibe `count: 0`.
 *
 * Se elige un árbitro implícito en vez de designar un aparato en la configuración —que es
 * como lo resuelve Toast— porque una designación que nadie configuró significa que NADIE
 * imprime, y en este dominio el fail-safe no puede ser dejar a la cocina sin enterarse
 * (`offline-first-y-hub-lan.md` §4.1a).
 */
export async function claimKdsPrint(venueId: string, kdsOrderId: string, deviceId: string): Promise<{ claimed: boolean }> {
  const limite = new Date(Date.now() - PRINT_CLAIM_TTL_MS)

  const r = await prisma.kdsOrder.updateMany({
    where: {
      id: kdsOrderId,
      venueId,
      // Lo ya impreso NUNCA se reclama: el papel no se des-imprime.
      printedAt: null,
      // Libre, o reclamada por alguien que ya se tardó demasiado.
      OR: [{ printClaimedAt: null }, { printClaimedAt: { lt: limite } }],
    },
    data: { printClaimedAt: new Date(), printClaimedBy: deviceId },
  })

  return { claimed: r.count > 0 }
}

/** "Ya salió el papel." Sella la impresión y la vuelve definitiva. */
export async function confirmKdsPrinted(venueId: string, kdsOrderId: string, deviceId: string): Promise<{ ok: boolean }> {
  const r = await prisma.kdsOrder.updateMany({
    // `printClaimedBy` en el WHERE: sólo confirma quien reclamó. Otro aparato no puede
    // declarar impreso algo que no imprimió.
    where: { id: kdsOrderId, venueId, printClaimedBy: deviceId, printedAt: null },
    data: { printedAt: new Date() },
  })
  return { ok: r.count > 0 }
}

// MARK: - "¿Quién trae este pedido?" (Tarea 8, KDS de Uber)

export interface KdsCourierResponse {
  supported: boolean
  assigned: boolean
  courier?: CourierInfo
}

/**
 * A botón desde la cocina, nunca en cada refresco del tablero: preguntarle al proveedor por
 * el repartidor en cada poll sería una llamada de más por comanda para un dato que casi
 * nunca cambia.
 *
 * `supported:false` = el proveedor de esta comanda no tiene esta capacidad (no es un error,
 * es "aquí no aplica"). `assigned:false` = sí aplica pero nadie ha tomado el pedido todavía,
 * o ya se cerró (COMPLETED/CANCELLED) y no vale la pena preguntar.
 */
export async function fetchKdsCourier(venueId: string, kdsOrderId: string): Promise<KdsCourierResponse> {
  const kdsOrder = await prisma.kdsOrder.findFirst({ where: { id: kdsOrderId, venueId }, select: { orderId: true } })
  if (!kdsOrder?.orderId) throw new NotFoundError('Orden KDS no encontrada')

  // Misma resolución de canal que accept/deny/ready: si esta comanda no es de reparto (o es
  // de otro venue), `contexto` no encuentra nada que preguntar.
  const ctx = await contexto(venueId, kdsOrder.orderId)
  if (!ctx) throw new NotFoundError('Orden KDS no encontrada')

  if (typeof ctx.adapter.fetchCourier !== 'function') return { supported: false, assigned: false }

  if (ctx.order.status === OrderStatus.COMPLETED || ctx.order.status === OrderStatus.CANCELLED) {
    return { supported: true, assigned: false }
  }

  let courier: CourierInfo | null
  try {
    courier = await ctx.adapter.fetchCourier(ctx.externalOrderId, ctx.storeId)
  } catch (error) {
    logger.warn('No se pudo consultar al repartidor con el proveedor de delivery', {
      orderId: kdsOrder.orderId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new ProviderUnavailableError()
  }

  return courier ? { supported: true, assigned: true, courier } : { supported: true, assigned: false }
}

/**
 * "No pude." Libera la reclamación EN EL ACTO para que otro aparato lo intente.
 *
 * Sin esto, una tablet sin papel bloquearía la comanda los 90 segundos completos mientras la
 * cocina no se entera del pedido. El caso es real y común: la impresora de una estación se
 * queda sin rollo a media comida.
 */
export async function releaseKdsPrint(venueId: string, kdsOrderId: string, deviceId: string): Promise<{ ok: boolean }> {
  const r = await prisma.kdsOrder.updateMany({
    // `printedAt: null` para que soltar no pueda borrar una impresión ya confirmada.
    where: { id: kdsOrderId, venueId, printClaimedBy: deviceId, printedAt: null },
    data: { printClaimedAt: null, printClaimedBy: null },
  })
  return { ok: r.count > 0 }
}
