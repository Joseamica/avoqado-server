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
  serviceCourse?: unknown
  orderPromotionId?: string | null
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

/**
 * Lo que acepta el receptor de marcas sin red (`KDS_TICKET_MARK`, «LISTO» o «salió en papel»): un folio que no cumple se
 * reconoce y se IGNORA. Todo folio que arme el servidor tiene que cumplirlo, o su LISTO sin red se pierde (Codex r3 #2).
 */
export const FOLIO_VALIDO = /^(sale|round|order):\S{1,200}$/

/** Normal: sync:<roundKey>:<índice>; componente de combo: la misma llave + :g:<grupo>. */
const LLAVE_DE_RONDA = /^sync:([^:]+):\d+(?::(?:\d+|g:[^:]+))?$/

/** El origen de un renglón. Mesa: su ronda. Mostrador: la venta. */
export function originKeyFor(line: KitchenLine, order: KitchenOrderRef, stampedAt: Date): string {
  if (order.tableId) {
    const ronda = line.externalId ? LLAVE_DE_RONDA.exec(line.externalId) : null
    if (ronda) return `round:${ronda[1]}`
    return `round:${order.id}:${(line.sentToKitchenAt ?? stampedAt).getTime()}`
  }
  return order.externalId ? `sale:${order.externalId}` : `order:${order.id}`
}

/**
 * La pieza que se sumó a un renglón que ya tenía comanda sale en una comanda NUEVA, como un envío nuevo (Square: cada tanda es su
 * propio ticket con el mismo número de cuenta): la de antes pudo terminarse y ya no está en la pantalla. En mesa se junta con lo
 * nuevo de ese mismo armado (`round:<orden>:<sello>`, el folio de los renglones sin llave). Codex r3 #1 y #2: se arma con el id de
 * la cuenta (del servidor), nunca con su `externalId` (lo escribe el cliente): no choca con otra cuenta y su largo es fijo. Lo de un
 * armado que caería en una comanda que ya existía también sale en este folio (Codex r4 B10/B13, `kitchenTicketAuthoring.service`).
 */
export function origenDeLaDiferencia(order: KitchenOrderRef, stampedAt: Date): string {
  return order.tableId ? `round:${order.id}:${stampedAt.getTime()}` : `order:${order.id}:mas:${stampedAt.getTime()}`
}

export function planKitchenTickets(input: {
  order: KitchenOrderRef
  lines: KitchenLine[]
  /** Unidades de cada renglón que ya están en alguna comanda (Σ `KdsOrderItem.quantity` por renglón). */
  sentUnits: ReadonlyMap<string, number>
  /** Renglones con alguna comanda de preparación por producto: ahí la diferencia no se parte en otra comanda. */
  preparationLineIds?: ReadonlySet<string>
  routing: RoutingConfig
  screens: ScreenStation[]
  stampedAt: Date
  /**
   * Al PAGAR (y en el POST de las apps viejas) sólo cuenta lo que NO se mandó a cocina: un renglón con
   * `sentToKitchenAt` ya viajó en una ronda (spec §2). Una ronda o el barrido arman todo lo pendiente. La pieza que se sumó a un
   * renglón que YA tiene comanda sí sale al pagar: nunca viajó.
   */
  soloSinEnviar: boolean
  /** Estaciones «No lleva comanda»: lo ruteado ahí nunca arma comanda de pantalla (aunque viniera entre las pantallas). */
  sinComanda?: ReadonlySet<string>
}): KitchenTicketPlan[] {
  const desdePorEstacion = new Map(input.screens.map(s => [s.id, s.since.getTime()]))
  if (desdePorEstacion.size === 0) return []
  // «Sin estación» sale en todas las pantallas: cuenta desde la primera que se prendió.
  const desdeLaPrimera = Math.min(...desdePorEstacion.values())
  const demasiadoTarde = input.stampedAt.getTime() - KITCHEN_STALENESS_MS
  const porFolio = new Map<string, KitchenTicketPlan>()

  for (const line of input.lines) {
    const yaMandadas = input.sentUnits.get(line.id) ?? 0
    if (input.soloSinEnviar && line.sentToKitchenAt && yaMandadas === 0) continue
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) continue
    // 🔴 hz:dcc49fe5:D1: la TPV funde la pieza nueva en el mismo renglón (2 cafés ya en cocina → 3, mismo id): sale sólo lo que falta.
    // Bajar no avisa (3 → 2) y volver a subir (2 → 3) no repite lo que la cocina ya tiene.
    const faltan = line.quantity - yaMandadas
    if (faltan <= 0) continue
    // ponytail: la preparación por producto supone UNA fila por renglón y estación (`kitchenPreparation.service`); ahí la diferencia
    // no se parte en otra comanda (sigue como antes). Sólo la alcanza la TPV fundiéndose en un renglón de una comanda con tiempos.
    if (yaMandadas > 0 && input.preparationLineIds?.has(line.id)) continue
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
    if (estacion !== null && input.sinComanda?.has(estacion)) continue
    let destino: string | null
    if (estacion === null) destino = null
    else if (desdePorEstacion.has(estacion)) destino = estacion
    else continue // estación de SÓLO impresora: sale en papel, no en pantalla

    // La pieza sumada tiene la edad de su renglón: no se sabe cuándo se sumó (`updatedAt` cambia con cualquier reenvío del carrito y
    // revivía piezas viejas, Codex r2 #1). ponytail: la sumada a un renglón de más de 12 h, o anterior a prender la pantalla, no sale.
    const hora = (line.sentToKitchenAt ?? line.createdAt).getTime()
    const desde = destino ? desdePorEstacion.get(destino)! : desdeLaPrimera
    if (hora < desde || hora < demasiadoTarde) continue

    const origen = yaMandadas > 0 ? origenDeLaDiferencia(input.order, input.stampedAt) : originKeyFor(line, input.order, input.stampedAt)
    const sourceKey = `${origen}:${destino ?? 'none'}`
    let plan = porFolio.get(sourceKey)
    if (!plan) {
      plan = { sourceKey, stationId: destino, lines: [], toStamp: [] }
      porFolio.set(sourceKey, plan)
    }
    plan.lines.push(yaMandadas > 0 ? { ...line, quantity: faltan } : line)
    if (!line.sentToKitchenAt) plan.toStamp.push(line.id)
  }

  return [...porFolio.values()]
}
