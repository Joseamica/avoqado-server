import { BadRequestError, ConflictError } from '../../errors/AppError'

export const PREPARATION_STATES = ['HELD', 'PENDING', 'PREPARING', 'READY', 'DELIVERED', 'CANCELLED'] as const
export type PreparationState = (typeof PREPARATION_STATES)[number]
export type PreparationUrgency = { requestId: string; acknowledged: boolean }
export type PreparationCounts = Record<PreparationState, number> & { urgency?: PreparationUrgency | null }
export type PreparationAction = 'RELEASE' | 'START' | 'READY' | 'DELIVER' | 'CANCEL' | 'REOPEN' | 'URGENT' | 'ACK_URGENT' | 'CLEAR_URGENT'
export const PREPARATION_VERSION = 1

export function initialPreparation(quantity: number, kind: 'IMMEDIATE' | 'STANDARD'): PreparationCounts {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new BadRequestError('Cantidad de preparación inválida')
  return {
    HELD: kind === 'STANDARD' ? quantity : 0,
    PENDING: kind === 'IMMEDIATE' ? quantity : 0,
    PREPARING: 0,
    READY: 0,
    DELIVERED: 0,
    CANCELLED: 0,
  }
}

/** Invalid persisted progress must never be guessed into ready/delivered work. */
export function parsePreparation(value: unknown, quantity: number): PreparationCounts {
  const c = value as PreparationCounts | null
  if (
    !c ||
    PREPARATION_STATES.some(s => !Number.isSafeInteger(c[s]) || c[s] < 0) ||
    PREPARATION_STATES.reduce((n, s) => n + c[s], 0) !== quantity ||
    (c.urgency != null &&
      (typeof c.urgency.requestId !== 'string' ||
        !c.urgency.requestId.trim() ||
        c.urgency.requestId.length > 200 ||
        typeof c.urgency.acknowledged !== 'boolean'))
  ) {
    throw new ConflictError('El progreso de este producto requiere revisión', 'PREPARATION_INVALID')
  }
  return { ...c }
}

const transitions: Partial<Record<PreparationAction, [PreparationState, PreparationState]>> = {
  RELEASE: ['HELD', 'PENDING'],
  START: ['PENDING', 'PREPARING'],
  READY: ['PREPARING', 'READY'],
  DELIVER: ['READY', 'DELIVERED'],
}

export function transitionPreparation(
  before: PreparationCounts,
  action: PreparationAction,
  quantity: number,
  from?: PreparationState,
  reason?: string,
  urgencyRequestId?: string,
): PreparationCounts {
  if (!Number.isSafeInteger(quantity) || quantity < 1)
    throw new BadRequestError('Selecciona una cantidad entera mayor a cero', 'PREPARATION_QUANTITY_INVALID')
  if (action === 'URGENT' || action === 'ACK_URGENT' || action === 'CLEAR_URGENT') {
    if (quantity !== 1 || from !== undefined)
      throw new BadRequestError('La prioridad se aplica al producto, sin modificar cantidades.', 'PREPARATION_PRIORITY_INVALID')
    if (action === 'CLEAR_URGENT') return { ...before, urgency: null }
    if (before.HELD + before.PENDING + before.PREPARING === 0)
      throw new ConflictError('Este producto ya está listo o terminado. Revisa su estado.', 'PREPARATION_CONFLICT')
    if (action === 'ACK_URGENT') {
      if (!before.urgency) throw new ConflictError('Este producto ya no tiene un aviso urgente.', 'PREPARATION_CONFLICT')
      return { ...before, urgency: { ...before.urgency, acknowledged: true } }
    }
    if (!urgencyRequestId?.trim() || urgencyRequestId.length > 200)
      throw new BadRequestError('Falta identificar la solicitud urgente.', 'PREPARATION_PRIORITY_INVALID')
    return { ...before, HELD: 0, PENDING: before.PENDING + before.HELD, urgency: { requestId: urgencyRequestId, acknowledged: false } }
  }
  const finishPriority = (counts: PreparationCounts): PreparationCounts =>
    counts.urgency && counts.HELD + counts.PENDING + counts.PREPARING === 0 ? { ...counts, urgency: null } : counts
  let pair = transitions[action]
  if (action === 'CANCEL' || action === 'REOPEN') {
    if (!reason?.trim() || reason.trim().length > 500)
      throw new BadRequestError('Escribe un motivo de hasta 500 caracteres', 'PREPARATION_REASON_REQUIRED')
    const allowed: PreparationState[] =
      action === 'CANCEL' ? ['HELD', 'PENDING', 'PREPARING', 'READY'] : ['CANCELLED', 'READY', 'DELIVERED']
    if (!from) {
      if (allowed.reduce((sum, state) => sum + before[state], 0) < quantity)
        throw new ConflictError('La cantidad o el estado cambió. Revisa el producto.', 'PREPARATION_CONFLICT')
      const after = { ...before }
      let remaining = quantity
      for (const state of allowed) {
        const count = Math.min(remaining, after[state])
        after[state] -= count
        remaining -= count
      }
      after[action === 'CANCEL' ? 'CANCELLED' : 'PENDING'] += quantity
      return finishPriority(after)
    }
    if (!allowed.includes(from)) throw new BadRequestError('Este estado no admite la acción seleccionada', 'PREPARATION_TRANSITION_INVALID')
    pair = [from, action === 'CANCEL' ? 'CANCELLED' : 'PENDING']
  }
  if (!pair || (from && from !== pair[0])) throw new BadRequestError('Transición de preparación inválida', 'PREPARATION_TRANSITION_INVALID')
  const [source, destination] = pair
  if (before[source] < quantity)
    throw new ConflictError('La cantidad o el estado cambió. Revisa el producto antes de continuar.', 'PREPARATION_CONFLICT', {
      current: before,
    })
  return finishPriority({ ...before, [source]: before[source] - quantity, [destination]: before[destination] + quantity })
}

/** A product is deliverable only when EVERY routed station has that many ready units. */
export function deliverableQuantity(stations: PreparationCounts[]): number {
  return stations.length ? Math.min(...stations.map(c => c.READY)) : 0
}

/** Financial close is deliberately absent: paid and held food remain operational work. */
export function preparationTicketStatus(items: PreparationCounts[]): 'NEW' | 'PREPARING' | 'READY' | 'COMPLETED' {
  if (!items.length) return 'NEW'
  if (items.every(c => c.HELD + c.PENDING + c.PREPARING + c.READY === 0)) return 'COMPLETED'
  if (items.some(c => c.PREPARING > 0)) return 'PREPARING'
  if (items.every(c => c.HELD + c.PENDING === 0)) return 'READY'
  return 'NEW'
}

/**
 * D17 (founder, 20-nov-2026): la COCINA ya terminó su parte — nada retenido, pendiente ni preparando. Desde ese momento la comanda
 * sale del tablero (aunque falte que la caja marque «Entregado») y entra a «Recientes». Sin productos no hay nada terminado.
 */
export function cocinaTermino(items: PreparationCounts[]): boolean {
  return items.length > 0 && items.every(c => c.HELD + c.PENDING + c.PREPARING === 0)
}

/**
 * Lo que se escribe en la comanda cada vez que cambian sus productos. El estado sale de `preparationTicketStatus` (igual que
 * siempre: READY = falta entregar, y de eso viven «En servicio» de la caja y el cierre de pedidos de plataforma);
 * `kitchenDoneAt` guarda la PRIMERA vez que la cocina terminó y se borra si vuelve a tener trabajo.
 */
export function recalculoDeComanda(
  items: PreparationCounts[],
  previa: { kitchenDoneAt: Date | null },
  ahora: Date = new Date(),
  /** La acción le dio trabajo NUEVO a la cocina (más pendiente o preparando que antes): una comanda archivada vuelve al tablero. */
  nuevoTrabajo = false,
): {
  status: 'NEW' | 'PREPARING' | 'READY' | 'COMPLETED'
  completedAt: Date | null
  kitchenDoneAt: Date | null
  archivedAt?: null
} {
  const status = preparationTicketStatus(items)
  return {
    status,
    completedAt: status === 'COMPLETED' ? ahora : null,
    kitchenDoneAt: cocinaTermino(items) ? (previa.kitchenDoneAt ?? ahora) : null,
    // Codex r2 #2: la caja corrige un platillo de una comanda ya archivada (o «Deshacer» le gana al archivado): la cocina lo ve.
    ...(nuevoTrabajo ? { archivedAt: null } : {}),
  }
}

/** Unidades que la cocina tiene que hacer YA (pendiente o preparando). */
export function trabajoDeCocina(c: PreparationCounts): number {
  return c.PENDING + c.PREPARING
}

/** «Deshacer» desde Recientes (D17): lo Listo vuelve a Preparando. Lo entregado y lo cancelado no se mueven. */
export function regresarListoAPreparando(before: PreparationCounts): PreparationCounts {
  return { ...before, PREPARING: before.PREPARING + before.READY, READY: 0 }
}

/** Reuses the canonical permission catalog: KITCHEN has update, floor also has create, manager has cancel. */
export function preparationPermissions(action: PreparationAction): string[] {
  if (action === 'RELEASE' || action === 'DELIVER' || action === 'URGENT' || action === 'CLEAR_URGENT')
    return ['orders:update', 'orders:create']
  if (action === 'CANCEL' || action === 'REOPEN') return ['orders:update', 'orders:cancel']
  return ['orders:update']
}

// MARK: - D17: «La cocina puede liberar tiempos desde su pantalla»

export type CambioDelInterruptor = { at: string; on: boolean }
/** Tope de cambios guardados (sólo se alcanza si alguien prende y apaga el interruptor sin parar). */
export const HISTORIAL_DEL_INTERRUPTOR = 200
/** Cuánto se respeta lo que una tablet sin internet hizo con el permiso que tenía guardado. */
export const RESPETO_SIN_RED_MS = 24 * 60 * 60 * 1000
/** Lo que el historial guarda completo: 48 h (la ventana de 24 h más la hora del aparato, de sobra). */
const HISTORIAL_COMPLETO_MS = 2 * RESPETO_SIN_RED_MS
/** Reloj del aparato adelantado o atrasado: lo que se le perdona. */
const DESFASE_DEL_RELOJ_MS = 5 * 60 * 1000

export function historialDelInterruptor(value: unknown): CambioDelInterruptor[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (c): c is CambioDelInterruptor => !!c && typeof c.at === 'string' && typeof c.on === 'boolean' && !Number.isNaN(Date.parse(c.at)),
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/**
 * El historial que se guarda al cambiar el interruptor (Codex r3 #4): TODO lo de las últimas 48 h y, de antes, sólo el último cambio
 * (dice cómo estaba al empezar). Un tope fijo de N cambios olvidaba un permiso válido si alguien lo movía muchas veces.
 */
export function podarHistorial(cambios: CambioDelInterruptor[], ahoraMs: number = Date.now()): CambioDelInterruptor[] {
  const orden = historialDelInterruptor(cambios)
  const corte = ahoraMs - HISTORIAL_COMPLETO_MS
  const viejos = orden.filter(c => Date.parse(c.at) < corte)
  const recientes = orden.filter(c => Date.parse(c.at) >= corte)
  return [...viejos.slice(-1), ...recientes].slice(-HISTORIAL_DEL_INTERRUPTOR)
}

/** Cómo estaba el interruptor en un instante, según su historial (sin historial, el valor de hoy). */
export function interruptorEn(
  settings: { kitchenCanReleaseCourses: boolean; kitchenCanReleaseHistory: unknown },
  instanteMs: number,
): boolean {
  const cambios = historialDelInterruptor(settings.kitchenCanReleaseHistory)
  if (cambios.length === 0) return settings.kitchenCanReleaseCourses
  const previos = cambios.filter(c => Date.parse(c.at) <= instanteMs)
  return previos.length > 0 && previos[previos.length - 1].on
}

/**
 * ¿Estuvo prendido en algún momento de las 24 h antes de que la tablet liberara? (Codex r1 #6, r2 #3/#4, r3 #3). Se decide SÓLO
 * con el historial y la hora del aparato (se le perdonan 5 min de reloj y nunca cuenta en el futuro): la tablet sin internet usa el
 * último permiso que vio, y rechazarlo trababa todo lo que la cocina hizo después. Prenderlo DESPUÉS no autoriza lo de antes.
 * Sin historial, el valor de hoy vale para todo el tiempo. Sin la hora del aparato, se mide ahora.
 */
export function liberacionPermitida(
  settings: { kitchenCanReleaseCourses: boolean; kitchenCanReleaseHistory: unknown } | null,
  hechoEnMs?: number | null,
  ahoraMs: number = Date.now(),
): boolean {
  if (!settings) return false
  const cambios = historialDelInterruptor(settings.kitchenCanReleaseHistory)
  if (cambios.length === 0) return settings.kitchenCanReleaseCourses
  const hecho = typeof hechoEnMs === 'number' && Number.isFinite(hechoEnMs) ? hechoEnMs : ahoraMs
  const hasta = Math.min(hecho + DESFASE_DEL_RELOJ_MS, ahoraMs)
  const desde = hasta - RESPETO_SIN_RED_MS - DESFASE_DEL_RELOJ_MS
  // Cómo estaba al empezar la ventana: el último cambio antes de `desde` (sin ninguno, apagado de fábrica).
  const previos = cambios.filter(c => Date.parse(c.at) <= desde)
  if (previos.length > 0 && previos[previos.length - 1].on) return true
  return cambios.some(c => c.on && Date.parse(c.at) > desde && Date.parse(c.at) <= hasta)
}
