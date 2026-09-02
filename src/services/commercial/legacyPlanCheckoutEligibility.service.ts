import { VenueStatus } from '@prisma/client'
import { ForbiddenError } from '@/errors/AppError'

export const LEGACY_PLAN_CHECKOUT_DEMO_VENUE_FORBIDDEN = 'LEGACY_PLAN_CHECKOUT_DEMO_VENUE_FORBIDDEN'

/**
 * Legacy base-plan Checkout creates a durable StripeCheckoutOrigin whose venue
 * FK is intentionally RESTRICT. Ephemeral demo/trial venues must therefore be
 * rejected before any Stripe/customer/origin side effect can exist.
 */
export function assertLegacyPlanCheckoutVenueEligible(status: VenueStatus): void {
  if (status === VenueStatus.LIVE_DEMO || status === VenueStatus.TRIAL) {
    throw new ForbiddenError(
      'Los venues demo o de prueba no pueden iniciar una suscripción legacy.',
      LEGACY_PLAN_CHECKOUT_DEMO_VENUE_FORBIDDEN,
    )
  }
}
