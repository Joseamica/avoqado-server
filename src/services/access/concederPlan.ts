import { ConflictError } from '@/errors/AppError'
import { choquesAlConcederPlan } from './concederPlanDecision'

export { choquesAlConcederPlan }

/**
 * 🔴 Codex R2 (ronda 2): traduce la decisión PURA de `choqueAlConcederPlan` al 409 que ve quien administra. La usan TODOS
 * los escritores que conceden un plan a mano —activar, prueba gratis del panel, prueba genérica, el wizard—; antes cada
 * uno decidía por su cuenta (o no decidía), y conceder una prueba PRO sobre un PREMIUM activo dejaba los dos planes
 * vivos. Bastaba la ejecución secuencial: no hacía falta ninguna carrera.
 *
 * Vive en su propio módulo, y no junto a los escritores, para que los dos servicios de superadmin (el del panel y el
 * genérico) compartan la MISMA respuesta sin importarse entre ellos.
 */
export function exigirQueSePuedaConceder(
  filas: { featureId: string; active: boolean; stripeSubscriptionId: string | null }[],
  featureId: string,
  /**
   * 🔴 `vinculoPropioYaComprobado`: quien ya le preguntó a Stripe por SU propio vínculo (con `exigirSinObligacionViva`)
   * no necesita el bloqueo por proxy — y aplicárselo le cerraría un camino legítimo: limpiar un vínculo MUERTO al
   * conceder una prueba, que es justo lo que R0 dejó abierto a propósito. El choque con el OTRO tier sí aplica siempre.
   */
  opciones: { vinculoPropioYaComprobado?: boolean } = {},
): void {
  // 🔴 Codex ronda 3 (hallazgo 12): los dos choques se evalúan SIEMPRE y por separado. La excepción del vínculo
  // propio no puede arrastrar consigo el choque con el otro tier.
  const { propiaLigada, otroPlanVivo } = choquesAlConcederPlan(filas, featureId)
  if (propiaLigada && !opciones.vinculoPropioYaComprobado) {
    throw new ConflictError(
      'Este plan está ligado a una suscripción de Stripe: su acceso lo decide el cobro. Para regalarlo usa «Asignar cortesía».',
      'PLAN_LIGADO_A_STRIPE',
    )
  }
  if (otroPlanVivo) {
    throw new ConflictError(
      'El negocio tiene otro plan activo o ligado a Stripe. Para cambiarlo usa «Asignar cortesía».',
      'OTRO_PLAN_ACTIVO',
    )
  }
}
