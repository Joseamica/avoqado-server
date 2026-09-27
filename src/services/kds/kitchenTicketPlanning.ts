/**
 * Etapa 3 del KDS — PLANEACIÓN PURA de comandas de pantalla (sin base, sin I/O).
 *
 * Para los renglones de UNA orden decide qué comandas deben existir: de qué origen (la venta de mostrador o la
 * ronda de mesa), para qué estación con pantalla y con qué FOLIO. El servicio carga los datos y escribe; esto se
 * prueba solo. La caja (Android/iOS) calcula el mismo folio antes de sincronizar: si esta función y la de la caja
 * no coinciden, la cocina ve comandas dobles. Spec: docs/superpowers/specs/2026-09-27-kds-etapa-3-design.md §1-§2.
 */
import { resolveStationId, type RoutingConfig } from '../printing/printRouting.engine'

export interface KitchenLine {
  id: string
  productId: string | null
  categoryId: string | null
  /** Product.printStationId (override del producto). */
  productStationId: string | null
  /** MenuCategory.printStationId de su categoría. */
  categoryStationId: string | null
  productName: string
  quantity: number
  /** Etiquetas ya normalizadas con `toKdsModifierLabels`. */
  modifiers: string[]
  notes: string | null
  externalId: string | null
  sentToKitchenAt: Date | null
  createdAt: Date
}

export interface KitchenOrderRef {
  id: string
  externalId: string | null
  tableId: string | null
}

export interface ScreenStation {
  id: string
  /** Cuándo se prendió su pantalla: lo anterior no sale en ella. */
  since: Date
}

export interface KitchenTicketPlan {
  sourceKey: string
  /** Estación con pantalla, o `null` = «Sin estación» (sale en todas las pantallas). */
  stationId: string | null
  lines: KitchenLine[]
  /** Renglones que llegaron sin `sentToKitchenAt`: el servicio los sella con la hora del armado. */
  toStamp: string[]
}

/** Una comanda con más de 12 h de retraso ya no se prepara: la cubrió el papel o nunca se pidió. */
export const KITCHEN_STALENESS_MS = 12 * 60 * 60 * 1000

/** Llave de renglón de una ronda: `sync:<roundKey>:<índice>` (la inyecta la cola offline o la manda la app). */
const LLAVE_DE_RONDA = /^sync:([^:]+):\d+$/

/** El origen de un renglón. Mesa: su ronda. Mostrador: la venta. */
export function originKeyFor(line: KitchenLine, order: KitchenOrderRef, stampedAt: Date): string {
  if (order.tableId) {
    const ronda = line.externalId ? LLAVE_DE_RONDA.exec(line.externalId) : null
    if (ronda) return `round:${ronda[1]}`
    return `round:${order.id}:${(line.sentToKitchenAt ?? stampedAt).getTime()}`
  }
  return order.externalId ? `sale:${order.externalId}` : `order:${order.id}`
}

export function planKitchenTickets(input: {
  order: KitchenOrderRef
  lines: KitchenLine[]
  coveredLineIds: ReadonlySet<string>
  routing: RoutingConfig
  screens: ScreenStation[]
  stampedAt: Date
  /**
   * Al PAGAR (y en el POST de las apps viejas) sólo cuenta lo que NO se mandó a cocina: un renglón con
   * `sentToKitchenAt` ya viajó en una ronda (spec §2). Una ronda o el barrido arman todo lo pendiente.
   */
  soloSinEnviar: boolean
}): KitchenTicketPlan[] {
  const desdePorEstacion = new Map(input.screens.map(s => [s.id, s.since.getTime()]))
  if (desdePorEstacion.size === 0) return []
  // «Sin estación» sale en todas las pantallas: cuenta desde la primera que se prendió.
  const desdeLaPrimera = Math.min(...desdePorEstacion.values())
  const demasiadoTarde = input.stampedAt.getTime() - KITCHEN_STALENESS_MS
  const porFolio = new Map<string, KitchenTicketPlan>()

  for (const line of input.lines) {
    if (input.coveredLineIds.has(line.id)) continue
    if (input.soloSinEnviar && line.sentToKitchenAt) continue
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) continue
    // Importe libre: no hay nada que cocinar (la caja tampoco lo manda a cocina).
    if (!line.productId) continue

    const estacion = resolveStationId(
      {
        orderItemId: line.id,
        productId: line.productId,
        productStationId: line.productStationId,
        categoryStationId: line.categoryStationId,
        productName: line.productName,
        quantity: line.quantity,
        modifiers: line.modifiers,
        notes: line.notes,
      },
      input.routing,
    )
    let destino: string | null
    if (estacion === null) destino = null
    else if (desdePorEstacion.has(estacion)) destino = estacion
    else continue // estación de SÓLO impresora: sale en papel, no en pantalla

    const hora = (line.sentToKitchenAt ?? line.createdAt).getTime()
    const desde = destino ? desdePorEstacion.get(destino)! : desdeLaPrimera
    if (hora < desde || hora < demasiadoTarde) continue

    const sourceKey = `${originKeyFor(line, input.order, input.stampedAt)}:${destino ?? 'none'}`
    let plan = porFolio.get(sourceKey)
    if (!plan) {
      plan = { sourceKey, stationId: destino, lines: [], toStamp: [] }
      porFolio.set(sourceKey, plan)
    }
    plan.lines.push(line)
    if (!line.sentToKitchenAt) plan.toStamp.push(line.id)
  }

  return [...porFolio.values()]
}
