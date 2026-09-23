/**
 * Qué PUEDE hacer la cocina con un pedido de reparto y con cada renglón (spec KDS Uber §3.3 y
 * «Apps»), decidido en UN solo sitio. La ruta «no tengo este artículo» y el tablero preguntan
 * aquí: si una condición viviera en dos copias, el botón aparecería donde la ruta lo niega. Las
 * apps sólo leen booleanos, nunca re-derivan una regla de negocio.
 */
import { OrderType, Prisma } from '@prisma/client'

import { reservaViva } from '@/services/delivery-channels/core/deliveryOrderLock'
import { adapterFor } from '@/services/delivery-channels/core/adapterRegistry'
import { proveedorDelPedido } from '@/services/delivery-channels/core/respondToDeliveryOrder.service'

/** Cuánto espera una persona antes de poder reintentar un aviso que el proveedor no confirmó (§3.5). */
export const REINTENTO_TRAS_MS = 15 * 60_000
/** Desde cuándo se puede reintentar: la MISMA regla que el CAS del reintento (`lastAttemptAt ≤ now − 15 min`). */
export const reintentableDesde = (lastAttemptAt: Date) => new Date(lastAttemptAt.getTime() + REINTENTO_TRAS_MS)

const COMANDA_ABIERTA = new Set(['NEW', 'PREPARING'])
const VENTA_CERRADA = new Set(['COMPLETED', 'CANCELLED'])
const EN_CURSO = new Set(['PENDING', 'UNCERTAIN'])

export type Bloqueo =
  | 'LINE_ID_MISSING'
  | 'NOT_DELIVERY'
  | 'LINK_UNRESOLVED'
  | 'UNSUPPORTED_PROVIDER'
  | 'NOT_ACCEPTED'
  | 'ALREADY_READY'
  | 'DELIVERY_OP_IN_PROGRESS'
  | 'LINE_ACTION_IN_PROGRESS'

type Renglon = { orderItemId: string | null; esReparto: boolean; conLink: boolean; conCapacidad: boolean; externalLineId: string | null }
type PedidoVivo = {
  providerAcceptedAt: Date | null
  readyReportedAt: Date | null
  deliveryOpInFlight: string | null
  deliveryOpInFlightAt: Date | null
}

/** §3.3 paso 1, en el orden del spec: ¿de qué renglón, de qué pedido y de qué proveedor hablamos? */
export function bloqueoDelRenglon(r: Renglon): Bloqueo | null {
  if (!r.orderItemId) return 'LINE_ID_MISSING'
  if (!r.esReparto) return 'NOT_DELIVERY'
  if (!r.conLink) return 'LINK_UNRESOLVED'
  if (!r.conCapacidad) return 'UNSUPPORTED_PROVIDER'
  if (!r.externalLineId) return 'LINE_ID_MISSING'
  return null
}

/** §3.3 paso 3: precondiciones de una operación NUEVA sobre el pedido. */
export function bloqueoDelPedido(o: PedidoVivo, comandaStatus: string, accionEnCurso: boolean): Bloqueo | null {
  if (!o.providerAcceptedAt) return 'NOT_ACCEPTED'
  if (o.readyReportedAt || !COMANDA_ABIERTA.has(comandaStatus)) return 'ALREADY_READY'
  if (reservaViva(o)) return 'DELIVERY_OP_IN_PROGRESS'
  if (accionEnCurso) return 'LINE_ACTION_IN_PROGRESS'
  return null
}

/** Predicado COMPLETO del botón «No tengo este artículo»: pertenencia + nada hecho sobre el renglón (§3.3 paso 2) + precondiciones. */
export function puedeReportarAgotado(r: Renglon, renglonTocado: boolean, o: PedidoVivo, comandaStatus: string, accionEnCurso: boolean) {
  return !bloqueoDelRenglon(r) && !renglonTocado && !bloqueoDelPedido(o, comandaStatus, accionEnCurso)
}

/** «Cancelar pedido» [C-15]: reparto abierto, sin «listo» avisado, sin otra salida en vuelo ni retiro en curso. */
export function puedeCancelarReparto(v: PedidoVivo & { type: string; status: string }, accionEnCurso: boolean): boolean {
  return v.type === OrderType.DELIVERY && !VENTA_CERRADA.has(v.status) && !v.readyReportedAt && !reservaViva(v) && !accionEnCurso
}

// ── Carga por LOTE para el tablero: consultas fijas por llamada, nunca una por comanda ──────────

type Accion = { status: string; attempts: number; lastAttemptAt: Date }
export type VentaDeComanda = PedidoVivo & {
  id: string
  type: string
  status: string
  conLink: boolean
  conCapacidad: boolean
  accionEnCurso: boolean
  /** Retiro por `lineId` del proveedor. */
  retiros: Map<string, Accion>
  /** Renglón de la venta por `OrderItem.id`. */
  renglones: Map<string, { externalLineId: string | null; removedAt: Date | null }>
}

type ComandaCruda = { orderId: string | null; items?: Array<{ orderItemId?: string | null }> }

/**
 * Las ventas de un lote de comandas con todo lo que el predicado necesita. Consultas FIJAS (hasta
 * cuatro) sea cual sea el número de comandas, cada una acotada por los ids del lote.
 */
export async function ventasDeComandas(db: Prisma.TransactionClient, venueId: string, comandas: ComandaCruda[]) {
  const orderIds = [...new Set(comandas.map(k => k.orderId).filter((id): id is string => Boolean(id)))]
  const ventas = orderIds.length
    ? await db.order.findMany({
        where: { id: { in: orderIds }, venueId },
        select: {
          id: true,
          type: true,
          status: true,
          externalId: true,
          deliveryChannelLinkId: true,
          providerAcceptedAt: true,
          readyReportedAt: true,
          deliveryOpInFlight: true,
          deliveryOpInFlightAt: true,
        },
        take: orderIds.length,
      })
    : []
  const reparto = ventas.filter(v => v.type === OrderType.DELIVERY)
  const ids = reparto.map(v => v.id)
  const esDeReparto = new Set(ids)
  const linkIds = [...new Set(reparto.map(v => v.deliveryChannelLinkId).filter((id): id is string => Boolean(id)))]
  const renglonIds = [
    ...new Set(
      comandas
        .filter(k => k.orderId && esDeReparto.has(k.orderId))
        .flatMap(k => (k.items ?? []).map(i => i.orderItemId))
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const [links, acciones, renglones] = await Promise.all([
    linkIds.length
      ? db.deliveryChannelLink.findMany({
          where: { id: { in: linkIds }, venueId },
          select: { id: true, provider: true },
          take: linkIds.length,
        })
      : [],
    // Todas las acciones del pedido (no sólo REMOVE_ITEM): «un cambio a la vez» mira cualquiera en curso.
    ids.length
      ? db.deliveryLineAction.findMany({
          where: { venueId, orderId: { in: ids } },
          select: { orderId: true, lineId: true, action: true, status: true, attempts: true, lastAttemptAt: true },
        })
      : [],
    renglonIds.length
      ? db.orderItem.findMany({
          where: { id: { in: renglonIds }, orderId: { in: ids } },
          select: { id: true, orderId: true, externalLineId: true, removedAt: true },
          take: renglonIds.length,
        })
      : [],
  ])
  const linkPorId = new Map(links.map(l => [l.id, l]))
  const accionesDe = agrupar(acciones)
  const renglonesDe = agrupar(renglones)

  const porId = new Map<string, VentaDeComanda>()
  for (const v of ventas) {
    const origen = v.type === OrderType.DELIVERY ? proveedorDelPedido(v.externalId) : null
    const link = v.deliveryChannelLinkId ? linkPorId.get(v.deliveryChannelLinkId) : undefined
    const propias = accionesDe.get(v.id) ?? []
    porId.set(v.id, {
      ...v,
      // ponytail: sólo el link propio de la orden. `contexto` además cae al evento originador para
      // órdenes previas a `deliveryChannelLinkId`; aquí esas salen sin botón (falso negativo seguro,
      // sólo las que estaban en cocina al desplegar). Si hiciera falta, cargar esos eventos por lote.
      conLink: Boolean(origen && link && link.provider === origen.provider),
      conCapacidad: Boolean(origen && typeof adapterFor(origen.provider).resolveFulfillmentIssues === 'function'),
      accionEnCurso: propias.some(a => EN_CURSO.has(a.status)),
      retiros: new Map(propias.filter(a => a.action === 'REMOVE_ITEM').map(a => [a.lineId, a])),
      renglones: new Map((renglonesDe.get(v.id) ?? []).map(r => [r.id, r])),
    })
  }
  return porId
}

function agrupar<T extends { orderId: string }>(filas: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const f of filas) (m.get(f.orderId) ?? m.set(f.orderId, []).get(f.orderId)!).push(f)
  return m
}

/** Los campos de capacidad de una comanda de reparto y de sus renglones (spec «Apps», todos opcionales). */
export function capacidadesDeComanda(
  k: { status: string; items?: Array<{ orderItemId?: string | null; removedAt?: Date | null }> },
  v: VentaDeComanda,
) {
  const renglones = (k.items ?? []).map(item => {
    const oi = item.orderItemId ? v.renglones.get(item.orderItemId) : undefined
    const retiro = oi?.externalLineId ? v.retiros.get(oi.externalLineId) : undefined
    const renglon: Renglon = {
      orderItemId: item.orderItemId ?? null,
      esReparto: true,
      conLink: v.conLink,
      conCapacidad: v.conCapacidad,
      externalLineId: oi?.externalLineId ?? null,
    }
    return {
      removedAt: (item.removedAt ?? oi?.removedAt)?.toISOString() ?? null,
      canReportOutOfStock: puedeReportarAgotado(renglon, Boolean(oi?.removedAt || retiro), v, k.status, v.accionEnCurso),
      lineActionState: retiro?.status ?? null,
      lineActionAttempts: retiro?.attempts ?? null,
      canRetryAt: retiro && EN_CURSO.has(retiro.status) ? reintentableDesde(retiro.lastAttemptAt).toISOString() : null,
    }
  })
  return {
    comanda: {
      canCancelDelivery: puedeCancelarReparto(v, v.accionEnCurso),
      deliveryOpInFlight: reservaViva(v) ? v.deliveryOpInFlight : null,
      hasLineActionInProgress: v.accionEnCurso,
    },
    renglones,
  }
}
