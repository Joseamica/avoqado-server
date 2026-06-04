/**
 * Plan State Service
 *
 * Reads the venue's PLAN_PRO base-plan lifecycle for the client "Tu plan" card and
 * performs end-of-period cancel / reactivate (cancel_at_period_end), the ONLY
 * supported way to cancel the base plan. Side-effect-free state derivation lives in
 * derivePlanState (access/basePlan.service.ts) and is shared with the superadmin overview.
 */

import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { derivePlanState, PAID_PLAN_TIER_CODES, IVA_RATE, type PlanStateValue } from '@/services/access/basePlan.service'
import { retrievePlanSubscription, setSubscriptionCancelAtPeriodEnd } from '../stripe.service'
import { logAction } from './activity-log.service'

export interface PlanState {
  hasPlan: boolean
  state: PlanStateValue
  planTier: 'GRATIS' | 'PRO' | 'PREMIUM' | 'ENTERPRISE' | null
  planName: string | null
  interval: 'month' | 'year' | null
  price: { base: number; gross: number; currency: 'MXN' } | null
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  suspendedAt: string | null
  gracePeriodEndsAt: string | null
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null
  stripeSubscriptionId: string | null
}

/** Round to 2 decimals (peso cents). */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Fetch the PLAN_PRO VenueFeature (active or not) for a venue. */
async function findPlanProFeature(venueId: string) {
  return prisma.venueFeature.findFirst({
    where: { venueId, feature: { code: { in: [...PAID_PLAN_TIER_CODES] } } },
    select: {
      id: true,
      active: true,
      endDate: true,
      suspendedAt: true,
      gracePeriodEndsAt: true,
      monthlyPrice: true,
      stripeSubscriptionId: true,
      feature: { select: { code: true, name: true } },
    },
  })
}

/**
 * Assemble the full PlanState for a venue. Tolerant: a Stripe outage degrades to
 * nulls for the Stripe-derived fields but never throws (the card still renders).
 */
export async function getPlanState(venueId: string): Promise<PlanState> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true, stripeCustomerId: true },
  })
  if (!venue) throw new NotFoundError(`Venue ${venueId} no encontrado`)

  const vf = await findPlanProFeature(venueId)

  // No PLAN_PRO row → "none" shell.
  if (!vf) {
    return {
      hasPlan: false,
      state: 'none',
      planTier: null,
      planName: null,
      interval: null,
      price: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      suspendedAt: null,
      gracePeriodEndsAt: null,
      paymentMethod: null,
      stripeSubscriptionId: null,
    }
  }

  // Read Stripe only when a subscription exists; tolerate failures.
  let stripeSub: Awaited<ReturnType<typeof retrievePlanSubscription>> | null = null
  if (vf.stripeSubscriptionId) {
    try {
      stripeSub = await retrievePlanSubscription(vf.stripeSubscriptionId)
    } catch (error) {
      logger.warn('getPlanState: failed to retrieve Stripe subscription; degrading to nulls', {
        venueId,
        subscriptionId: vf.stripeSubscriptionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  const { state, hasPlan } = derivePlanState(
    { active: vf.active, endDate: vf.endDate, suspendedAt: vf.suspendedAt, gracePeriodEndsAt: vf.gracePeriodEndsAt },
    stripeSub ? { status: stripeSub.status, cancelAtPeriodEnd: stripeSub.cancelAtPeriodEnd } : null,
  )

  // Price: prefer Stripe gross (IVA-inclusive); fall back to VenueFeature.monthlyPrice (base ex-IVA).
  let price: PlanState['price'] = null
  if (stripeSub?.grossAmountCents != null) {
    const gross = round2(stripeSub.grossAmountCents / 100)
    price = { base: round2(gross / (1 + IVA_RATE)), gross, currency: 'MXN' }
  } else if (vf.monthlyPrice != null) {
    const base = round2(vf.monthlyPrice.toNumber())
    price = { base, gross: round2(base * (1 + IVA_RATE)), currency: 'MXN' }
  }

  return {
    hasPlan,
    state,
    planTier: 'PRO', // PLAN_PRO. Multi-tier mapping is a future concern (Plan 2 / YAGNI).
    planName: vf.feature.name,
    interval: stripeSub?.interval ?? null,
    price,
    trialEndsAt: vf.endDate ? vf.endDate.toISOString() : null,
    currentPeriodEnd: stripeSub?.currentPeriodEnd ? stripeSub.currentPeriodEnd.toISOString() : null,
    cancelAtPeriodEnd: stripeSub?.cancelAtPeriodEnd ?? false,
    suspendedAt: vf.suspendedAt ? vf.suspendedAt.toISOString() : null,
    gracePeriodEndsAt: vf.gracePeriodEndsAt ? vf.gracePeriodEndsAt.toISOString() : null,
    paymentMethod: null, // payment-method summary handled by the existing /payment-methods endpoint (out of scope here)
    stripeSubscriptionId: vf.stripeSubscriptionId,
  }
}

/** Shared cancel/reactivate core: validate plan + Stripe sub, flip the flag, return fresh state. */
async function setCancelIntent(venueId: string, cancel: boolean): Promise<PlanState> {
  const vf = await findPlanProFeature(venueId)
  if (!vf) throw new BadRequestError('Este venue no tiene un plan base activo.')
  if (!vf.stripeSubscriptionId) {
    throw new BadRequestError('No hay suscripción de Stripe que cancelar. Contacta a soporte.')
  }

  await setSubscriptionCancelAtPeriodEnd(vf.stripeSubscriptionId, cancel)

  logAction({
    venueId,
    action: cancel ? 'PLAN_CANCEL_SCHEDULED' : 'PLAN_REACTIVATED',
    entity: 'VenueFeature',
    entityId: vf.id,
    data: { subscriptionId: vf.stripeSubscriptionId, cancelAtPeriodEnd: cancel },
  })

  return getPlanState(venueId)
}

/** Schedule cancellation at period end (venue stays entitled until currentPeriodEnd). */
export async function cancelPlan(venueId: string): Promise<PlanState> {
  return setCancelIntent(venueId, true)
}

/** Undo a scheduled cancellation. */
export async function reactivatePlan(venueId: string): Promise<PlanState> {
  return setCancelIntent(venueId, false)
}

export default { getPlanState, cancelPlan, reactivatePlan }
