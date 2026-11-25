/**
 * Plan Básico (17-nov): cómo TERMINA la prueba de Pro, leído de la suscripción REAL de Stripe.
 *
 * 🔴 La modalidad la fija la PRIMERA creación (`cancel_at_period_end: true` en el mismo create, al estar en prueba el
 * periodo ES la prueba) y sólo «Tu plan» la cambia. La metadata `basicPlanChosen` es historia, nunca decide. Fuera de
 * una prueba no hay modalidad: se devuelve `{}` y el campo no viaja.
 */
export type TrialModality = 'RENEWS_AS_PRO' | 'ENDS_FREE'

export interface ModalidadDePrueba {
  trialModality?: TrialModality
  trialEndsAt?: string
  /** Planes editables (B2): la prueba empezó sin tarjeta (metadata `sinTarjeta: 'true'` de la suscripción, que sólo existe con versión del editor). */
  sinTarjeta?: true
}

export function modalidadDePrueba(
  sub:
    | {
        status?: string | null
        cancel_at_period_end?: boolean | null
        trial_end?: number | null
        metadata?: Record<string, string> | null
      }
    | null
    | undefined,
): ModalidadDePrueba {
  if (sub?.status !== 'trialing') return {}
  return {
    trialModality: sub.cancel_at_period_end === true ? 'ENDS_FREE' : 'RENEWS_AS_PRO',
    ...(sub.metadata?.sinTarjeta === 'true' ? { sinTarjeta: true as const } : {}),
    ...(typeof sub.trial_end === 'number' ? { trialEndsAt: new Date(sub.trial_end * 1000).toISOString() } : {}),
  }
}
