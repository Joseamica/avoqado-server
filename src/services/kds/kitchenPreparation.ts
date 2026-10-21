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

/** Reuses the canonical permission catalog: KITCHEN has update, floor also has create, manager has cancel. */
export function preparationPermissions(action: PreparationAction): string[] {
  if (action === 'RELEASE' || action === 'DELIVER' || action === 'URGENT' || action === 'CLEAR_URGENT')
    return ['orders:update', 'orders:create']
  if (action === 'CANCEL' || action === 'REOPEN') return ['orders:update', 'orders:cancel']
  return ['orders:update']
}
