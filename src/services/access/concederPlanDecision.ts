/**
 * Decisión PURA de R2: ¿se puede conceder a mano un plan con lo que el negocio ya tiene? Sin base y sin Stripe, para
 * poder probarla entera. El 409 que ve quien administra lo pone `concederPlan.ts`.
 */
export interface FilaDePlanDeNegocio {
  featureId: string
  active: boolean
  stripeSubscriptionId: string | null
}

export interface ChoquesDePlan {
  /** La fila del tier PEDIDO ya está ligada a una suscripción: su acceso lo decide el cobro, no un clic. */
  propiaLigada: boolean
  /** El OTRO tier está activo o ligado (aunque su fila esté apagada, sigue cobrando). */
  otroPlanVivo: boolean
}

/**
 * 🔴 Codex R2 (ronda 2): ¿se puede CONCEDER a mano el plan `featureId` con lo que el negocio ya tiene?
 *
 * Los escritores administrativos (activar, prueba gratis, el wizard) escribían su fila sin mirar el otro tier:
 * conceder una prueba PRO a quien tenía PREMIUM activo dejaba los DOS planes vivos, y bastaba la ejecución
 * secuencial. La decisión vive aquí, una sola vez, y es PURA para poder probarla entera.
 *
 * 🔴 Codex ronda 3 (hallazgo 12): devuelve los DOS choques por separado. Antes devolvía el primero que encontraba y
 * se detenía, así que una fila propia ligada TAPABA el choque con el otro tier — y quien tenía permiso para saltarse
 * el primero (porque ya le preguntó a Stripe) se saltaba también el segundo, que es el que R2 venía a cerrar.
 */
export function choquesAlConcederPlan(filas: FilaDePlanDeNegocio[], featureId: string): ChoquesDePlan {
  const propia = filas.find(f => f.featureId === featureId)
  const otra = filas.find(f => f.featureId !== featureId && (f.active || f.stripeSubscriptionId))
  return { propiaLigada: !!propia?.stripeSubscriptionId, otroPlanVivo: !!otra }
}

export function planesPedidos(codigos: string[], codigosDePlan: readonly string[]): string[] {
  return codigos.filter(c => codigosDePlan.includes(c))
}
