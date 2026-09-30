/**
 * Plan State Service
 *
 * Reads the venue's PLAN_PRO base-plan lifecycle for the client "Tu plan" card and
 * performs end-of-period cancel / reactivate (cancel_at_period_end), the ONLY
 * supported way to cancel the base plan. Side-effect-free state derivation lives in
 * derivePlanState (access/basePlan.service.ts) and is shared with the superadmin overview.
 */

import { elegirFilaDelPlan } from '../access/filaDelPlan'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { derivePlanState, PAID_PLAN_TIER_CODES, IVA_RATE, type PlanStateValue } from '@/services/access/basePlan.service'
import { getVenueBaseTier } from '@/services/access/basePlan.service'
import { GRANDFATHER_SELECT, resolveGrandfathered } from '@/services/access/grandfather'
import {
  retrievePlanSubscription,
  setSubscriptionCancelAtPeriodEnd,
  applySubscriptionCoupon,
  pauseSubscriptionCollection,
  createWinbackPromotionCode,
} from '../stripe.service'
import { logAction } from './activity-log.service'
import emailService from '../email.service'
import { resolvePlanNotificationTarget } from '@/services/access/planNotification.service'
import { cancellationAuditData, toStripeCancellationDetails, type CancellationInput } from '@/services/shared/cancellationReason'
import { hybridOfferDefinition } from '@/services/launchCampaigns/hybridOffer.schema'
import { billingPageUrl } from '@/utils/dashboardLinks'

/** Win-back coupon offered in the cancellation confirmation email (see scripts/seed-retention-coupon.ts). */
const CANCELLATION_WINBACK_COUPON = 'WINBACK_30_1M'
const CANCELLATION_WINBACK_PERCENT_OFF = 30
/** Days the cancellation-email win-back offer stays redeemable. */
const CANCELLATION_WINBACK_VALID_DAYS = 7

/**
 * Best-effort cancellation confirmation email with a time-limited win-back offer.
 * NEVER throws — a failure here must not block the cancellation (wrapped in try/catch,
 * matching the other plan-email sends). Mints a single-use Stripe promotion code for the
 * WINBACK_30_1M coupon with `expires_at = redeemBy`; if code creation fails, the email still
 * goes out with a deadline-only message.
 *
 * @param accessUntil - end of the already-paid period (currentPeriodEnd) the venue keeps access to
 */
async function sendCancellationEmail(venueId: string, subscriptionId: string, accessUntil: Date | null): Promise<void> {
  try {
    const target = await resolvePlanNotificationTarget(venueId)
    if (!target.email) {
      logger.warn(`cancellation-email: no recipient for venue ${venueId}; skipping`)
      return
    }

    const now = new Date()
    const redeemBy = new Date(now.getTime() + CANCELLATION_WINBACK_VALID_DAYS * 86400000)

    // Mint a single-use promo code with an expiry; tolerate failure (fall back to deadline-only copy).
    let winbackCode: string | undefined
    try {
      const { code } = await createWinbackPromotionCode(CANCELLATION_WINBACK_COUPON, redeemBy)
      winbackCode = code
    } catch (codeErr) {
      logger.warn('cancellation-email: failed to mint win-back promotion code; sending deadline-only offer', {
        venueId,
        subscriptionId,
        error: codeErr instanceof Error ? codeErr.message : 'Unknown error',
      })
    }

    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { slug: true } })
    const reactivateUrl = billingPageUrl(venue?.slug, '?winback=1')

    await emailService.sendPlanCancellationEmail(target.email, {
      locale: target.locale,
      venueName: target.venueName,
      accessUntil, // unknown stays unknown: the win-back deadline is NOT when access ends
      redeemBy,
      winbackCode,
      winbackPercentOff: CANCELLATION_WINBACK_PERCENT_OFF,
      reactivateUrl,
    })
  } catch (emailErr) {
    // Non-blocking: cancellation already succeeded; just log.
    logger.error('cancellation-email: failed to send', {
      venueId,
      subscriptionId,
      error: emailErr instanceof Error ? emailErr.message : 'Unknown error',
    })
  }
}

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
  /**
   * Whether the venue is GRANDFATHERED (its own `Venue.seatCapExempt`, OR its
   * `Organization.seatCapExempt` — the whole client is grandfathered, new stores included):
   * it operates as it did before the tier monetization and is exempt from BOTH the Free seat
   * cap AND every feature paywall. The dashboard reads this to suppress all FeatureGate upsells.
   */
  grandfathered: boolean
  /**
   * Whether the venue qualifies for the cancellation-retention DISCOUNT offer. True only when
   * there is an active base-plan Stripe subscription, its tenure is ≥ 30 days (past the first
   * billing cycle — the key anti-farm rule), and no discount is already active. DB-only/comped
   * plans (no Stripe sub) are never eligible. The frontend uses this to decide whether to show
   * the retention offer step; the server re-enforces it in applyRetentionOffer.
   */
  retentionOfferEligible: boolean
  /** The one obligation behind "Tu plan" (spec §4.2). Optional for older consumers; getPlanState always fills it. */
  origin?: PlanOrigin
  /** Whether the retention PAUSE can be applied right now (the same checks as applyRetentionOffer 'pause'). */
  pauseOfferEligible?: boolean
}

/** Where "Tu plan" comes from: ONE obligation, with its own tier, price and dates (spec §4.2). */
export interface PlanOrigin {
  kind: 'CLASSIC' | 'CONTRACT' | 'COMP' | 'NONE'
  tier: 'PRO' | 'PREMIUM' | null
  /** Pesos: IVA-inclusive `gross`, ex-IVA `base`. CONTRACT: what its last paid period charged (offer price before any; null if unreadable). */
  price: { base: number; gross: number; currency: 'MXN' } | null
  interval: 'month' | 'year' | null
  /** End of the paid period (CLASSIC: Stripe; CONTRACT: paidThrough; COMP: until when, null = no end date). */
  currentPeriodEnd: string | null
  /** When it stops renewing, if that is scheduled. */
  cancelAt: string | null
  contractId: string | null
  contractRevision: number | null
  /** The Stripe subscription behind it (CLASSIC or CONTRACT): what a "Pro ↔ Premium" replacement replaces. */
  subscriptionId: string | null
  /** The contract purchase's last billing issue, for "pago pendiente". */
  paymentIssue: string | null
}

const NO_ORIGIN: PlanOrigin = {
  kind: 'NONE',
  tier: null,
  price: null,
  interval: null,
  currentPeriodEnd: null,
  cancelAt: null,
  contractId: null,
  contractRevision: null,
  subscriptionId: null,
  paymentIssue: null,
}

function classicOrigin(
  tier: 'PRO' | 'PREMIUM',
  stripeSub: Awaited<ReturnType<typeof retrievePlanSubscription>> | null,
  price: PlanState['price'],
  subscriptionId: string,
): PlanOrigin {
  const currentPeriodEnd = stripeSub?.currentPeriodEnd ? stripeSub.currentPeriodEnd.toISOString() : null
  return {
    ...NO_ORIGIN,
    kind: 'CLASSIC',
    tier,
    price,
    interval: stripeSub?.interval ?? null,
    currentPeriodEnd,
    cancelAt: stripeSub?.cancelAtPeriodEnd ? currentPeriodEnd : null,
    subscriptionId,
  }
}

/**
 * The campaign contract that sets the commercial tier: not ended and whose cancellation hasn't taken effect, Premium
 * over Pro. Its price is what its last paid period charged, so a finished promotion shows the real amount.
 */
async function planContractOrigin(venueId: string): Promise<PlanOrigin> {
  const contract = await prisma.hybridContract.findFirst({
    where: {
      venueId,
      endedAt: null,
      planTier: { in: ['PRO', 'PREMIUM'] },
      OR: [{ cancelAt: null }, { cancelAt: { gt: new Date() } }],
    },
    include: { publication: { select: { definition: true } }, purchase: { select: { lastIssue: true } } },
    orderBy: [{ planTier: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
  })
  if (!contract) return NO_ORIGIN
  const lastPeriod = await prisma.hybridPaymentPeriod.findFirst({
    where: { venueId, stripeSubscriptionId: contract.stripeSubscriptionId },
    orderBy: [{ endsAt: 'desc' }, { id: 'desc' }],
    select: { composition: true },
  })
  const lines = lastPeriod?.composition as Array<{ contractId: string; amount: string }> | null | undefined
  const charged = lines?.find(line => line.contractId === contract.id)?.amount
  let gross: number | null = charged != null ? round2(Number(charged)) : null
  if (gross === null) {
    // Degrade, don't fail: an unreadable stored offer shows the contract without a price instead of breaking "Tu plan".
    const offer = hybridOfferDefinition.safeParse(contract.publication.definition)
    if (offer.success) gross = round2(offer.data.terms.price)
    else logger.warn('getPlanState: stored offer definition is invalid; contract shown without price', { venueId, contractId: contract.id })
  }
  return {
    kind: 'CONTRACT',
    tier: contract.planTier === 'PREMIUM' ? 'PREMIUM' : 'PRO',
    price: gross === null ? null : { base: round2(gross / (1 + IVA_RATE)), gross, currency: 'MXN' },
    interval: 'month',
    currentPeriodEnd: contract.paidThrough?.toISOString() ?? null,
    cancelAt: contract.cancelAt?.toISOString() ?? null,
    contractId: contract.id,
    contractRevision: contract.revision,
    subscriptionId: contract.stripeSubscriptionId,
    paymentIssue: contract.purchase?.lastIssue ?? null,
  }
}

/**
 * Minimum subscription tenure before the retention DISCOUNT offer unlocks. THE key anti-farm
 * rule: a brand-new subscriber can't buy → cancel → farm the discount within the first cycle.
 */
const RETENTION_MIN_TENURE_DAYS = 30
const RETENTION_MIN_TENURE_MS = RETENTION_MIN_TENURE_DAYS * 24 * 60 * 60 * 1000

/** True when the Stripe subscription was created ≥ RETENTION_MIN_TENURE_DAYS ago. */
function meetsRetentionTenure(createdAt: Date | null | undefined): boolean {
  if (!createdAt) return false
  return Date.now() - createdAt.getTime() >= RETENTION_MIN_TENURE_MS
}

/** Round to 2 decimals (peso cents). */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * La fila de plan que se ADMINISTRA (activa o no). Tras un cambio de plan hay DOS filas (la vieja retirada y la vigente):
 * se leen las dos y se elige con la regla explícita de `elegirFilaDelPlan` — «la primera» sin orden mostraba el plan viejo
 * como cancelado y rechazaba cancelar el vigente (Codex C8).
 */
async function findPlanProFeature(venueId: string) {
  const filas = await prisma.venueFeature.findMany({
    where: { venueId, feature: { code: { in: [...PAID_PLAN_TIER_CODES] } } },
    select: {
      id: true,
      active: true,
      endDate: true,
      suspendedAt: true,
      gracePeriodEndsAt: true,
      monthlyPrice: true,
      stripeSubscriptionId: true,
      updatedAt: true,
      feature: { select: { code: true, name: true } },
    },
    take: PAID_PLAN_TIER_CODES.length,
  })
  return elegirFilaDelPlan(filas)
}

/**
 * Assemble the full PlanState for a venue. Tolerant: a Stripe outage degrades to
 * nulls for the Stripe-derived fields but never throws (the card still renders).
 */
export async function getPlanState(venueId: string): Promise<PlanState> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true, stripeCustomerId: true, ...GRANDFATHER_SELECT },
  })
  if (!venue) throw new NotFoundError(`Venue ${venueId} no encontrado`)

  // Grandfather flag — exempt from BOTH the seat cap AND feature paywalls (see schema.prisma).
  // Resolved from the venue's own flag OR its organization's, so a venue under a grandfathered
  // client reports `grandfathered: true` and the dashboard suppresses its upsells.
  const grandfathered = resolveGrandfathered(venue)

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
      grandfathered,
      retentionOfferEligible: false,
      origin: await planContractOrigin(venueId),
      pauseOfferEligible: false,
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

  // Retention DISCOUNT eligibility (mirrors the server-side gate in applyRetentionOffer):
  // requires a live Stripe sub, tenure ≥ 30d, and no discount already active. Without a
  // reachable Stripe sub (DB-only/comped plan, or Stripe degraded) → not eligible.
  const retentionOfferEligible = Boolean(stripeSub && meetsRetentionTenure(stripeSub.createdAt) && !stripeSub.hasActiveDiscount)

  const tier = vf.feature.code === 'PLAN_PREMIUM' ? 'PREMIUM' : 'PRO'
  const now = new Date()
  const inWindow = vf.active && !vf.suspendedAt && (!vf.endDate || vf.endDate >= now)
  // Paid obligations first (CLASSIC → CONTRACT → COMP → NONE): "Tu plan" is what the owner pays for. A retired classic
  // row never wins, and a courtesy/trial row is not an obligation, so it only shows when nothing is paid.
  let origin: PlanOrigin =
    vf.active && vf.stripeSubscriptionId
      ? classicOrigin(tier, stripeSub, price, vf.stripeSubscriptionId)
      : await planContractOrigin(venueId)
  if (origin.kind === 'NONE' && inWindow) {
    origin = { ...NO_ORIGIN, kind: 'COMP', tier, currentPeriodEnd: vf.endDate ? vf.endDate.toISOString() : null }
  }
  const pauseOfferEligible = Boolean(
    stripeSub &&
      origin.kind === 'CLASSIC' &&
      (await getVenueBaseTier(venueId)) !== null &&
      (await pauseBlocker(venueId, stripeSub)) === null,
  )

  return {
    hasPlan,
    state,
    planTier: tier,
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
    grandfathered,
    retentionOfferEligible,
    origin,
    pauseOfferEligible,
  }
}

/** What cancelling carries: the owner's reason (optional) and who asked. */
export interface CancelPlanInput extends CancellationInput {
  staffId?: string
}

/** Shared cancel/reactivate core: validate plan + Stripe sub, flip the flag, return fresh state. */
async function setCancelIntent(venueId: string, cancel: boolean, input: CancelPlanInput = {}): Promise<PlanState> {
  const vf = await findPlanProFeature(venueId)
  if (!vf) throw new BadRequestError('Este venue no tiene un plan base activo.')
  if (!vf.stripeSubscriptionId) {
    throw new BadRequestError('No hay suscripción de Stripe que cancelar. Contacta a soporte.')
  }

  // Read the prior Stripe state BEFORE flipping so the cancellation email only fires on a
  // genuine transition (not a re-cancel of an already-canceling sub). Tolerant: if Stripe is
  // unreachable we proceed and treat it as "was not canceling" so the flow never blocks.
  let wasCanceling = false
  let currentPeriodEnd: Date | null = null
  try {
    const prior = await retrievePlanSubscription(vf.stripeSubscriptionId)
    wasCanceling = prior.cancelAtPeriodEnd
    currentPeriodEnd = prior.currentPeriodEnd
  } catch (error) {
    logger.warn('setCancelIntent: failed to read prior Stripe state; proceeding', {
      venueId,
      subscriptionId: vf.stripeSubscriptionId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }

  // The owner's reason rides in the SAME Stripe update as cancel_at_period_end (never on a reactivation).
  const details = cancel ? toStripeCancellationDetails(input) : undefined
  if (details) await setSubscriptionCancelAtPeriodEnd(vf.stripeSubscriptionId, cancel, details)
  else await setSubscriptionCancelAtPeriodEnd(vf.stripeSubscriptionId, cancel)

  logAction({
    venueId,
    staffId: input.staffId,
    action: cancel ? 'PLAN_CANCEL_SCHEDULED' : 'PLAN_REACTIVATED',
    entity: 'VenueFeature',
    entityId: vf.id,
    data: {
      subscriptionId: vf.stripeSubscriptionId,
      cancelAtPeriodEnd: cancel,
      ...(cancel ? cancellationAuditData(input) : {}),
    },
  })

  // Cancellation confirmation + win-back email — ONLY on a fresh cancel transition
  // (idempotent: a re-cancel where the sub was already canceling does not re-send).
  // Non-blocking by contract (sendCancellationEmail never throws).
  if (cancel && !wasCanceling) {
    await sendCancellationEmail(venueId, vf.stripeSubscriptionId, currentPeriodEnd)
  }

  return getPlanState(venueId)
}

/** Schedule cancellation at period end (venue stays entitled until currentPeriodEnd), with the owner's reason if given. */
export async function cancelPlan(venueId: string, input: CancelPlanInput = {}): Promise<PlanState> {
  return setCancelIntent(venueId, true, input)
}

/**
 * Undo a scheduled cancellation. Also cancels any pending Pro→Free seat reconciliation: if the
 * owner scheduled a downgrade-to-Free (capturing a "who stays" selection) and then reactivates
 * before period end, nobody should be deactivated. Best-effort — clearing the pending selection
 * must never block reactivation (a leftover selection would otherwise only execute if the plan
 * actually ends, which reactivation just prevented; we clear it anyway to keep state clean).
 */
export async function reactivatePlan(venueId: string): Promise<PlanState> {
  const planState = await setCancelIntent(venueId, false)
  try {
    // Imported lazily to avoid a require cycle (seatReconciliation.service imports planState.service).
    const { clearPendingReconciliation } = await import('./seatReconciliation.service')
    await clearPendingReconciliation(venueId)
  } catch (error) {
    logger.warn('reactivatePlan: failed to clear pending seat reconciliation (non-fatal)', {
      venueId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
  return planState
}

/** Stripe coupon applied when a merchant accepts the "stay" retention offer (see scripts/seed-retention-coupon.ts). */
export const RETENTION_DISCOUNT_COUPON = 'RETENTION_30_3M'

/** Months the "pause" retention offer keeps collection paused before Stripe auto-resumes. */
const RETENTION_PAUSE_MONTHS = 2
/**
 * 🔴 Codex N3 (ronda 4, P1 — y estaba DESPLEGADO): mínimo entre una pausa y la siguiente.
 *
 * La pausa no tenía tope de ninguna clase: el único antiabuso era «¿ya tienes un descuento activo?», y una pausa no
 * es un descuento. `resumesAt` se recalculaba a «hoy + 2 meses» en CADA llamada, así que pedirla otra vez antes de
 * que venciera la EXTENDÍA, indefinidamente, conservando el acceso completo y sin cobrar esos periodos
 * (`mark_uncollectible`). Un cliente podía quedarse con la plataforma gratis para siempre, en autoservicio.
 *
 * 🔑 No se cierra la oferta —existe para no perder a un negocio con problemas de flujo, que es nuestro ICP—: se le
 * pone tope. 12 meses es el default conservador de la casa para algo que regala servicio; si el founder quiere otro
 * número, es un dato, no un rediseño. Una pausa por año, de dos meses, sigue siendo una red real para el cliente.
 */
const RETENTION_PAUSE_COOLDOWN_MONTHS = 12

/** Why a PAUSE can't be applied now (the rules applyRetentionOffer enforces), or null when it can. Spanish, for the owner. */
async function pauseBlocker(venueId: string, sub: { hasActiveDiscount: boolean; pausedUntil: Date | null }): Promise<string | null> {
  if (sub.hasActiveDiscount) return 'Ya tienes una oferta activa.'
  // 🔴 Codex N3: a running pause is never extended; asking again used to push it two more months, without limit.
  if (sub.pausedUntil) return `Tu cobranza ya está pausada hasta el ${sub.pausedUntil.toLocaleDateString('es-MX')}.`
  const desde = new Date()
  desde.setMonth(desde.getMonth() - RETENTION_PAUSE_COOLDOWN_MONTHS)
  const previa = await prisma.activityLog.findFirst({
    where: { venueId, action: 'PLAN_RETENTION_PAUSE', createdAt: { gte: desde } },
    select: { createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  return previa
    ? `Ya usaste una pausa el ${previa.createdAt.toLocaleDateString('es-MX')}. Si necesitas otra, escríbenos a hola@avoqado.io.`
    : null
}

export type RetentionOffer = 'discount' | 'pause'

/**
 * Apply a cancellation-retention offer to the venue's base-plan Stripe subscription.
 *
 *   - 'discount' → apply the RETENTION_30_3M coupon (30% off, 3 months) to the live
 *     subscription so the merchant stays at a reduced price. Mirrors the intro-coupon
 *     `discounts` API used by createPlanSubscription.
 *   - 'pause'    → pause collection for ~2 months (mark_uncollectible, auto-resumes) so the
 *     merchant keeps their data/config without being charged.
 *
 * Requires an active base plan (getVenueBaseTier !== null) and a Stripe subscription.
 *
 * Anti-abuse (chosen approach: Stripe-derived checks, no DB migration). The DISCOUNT offer is
 * the real gate — it must satisfy ALL of:
 *   1. an active base-plan Stripe subscription (DB-only/comped plans have nothing to discount),
 *   2. tenure ≥ 30 days since the Stripe subscription was created — THE key anti-farm rule
 *      that stops a brand-new subscriber from buy → cancel → farm-the-discount within the first
 *      billing cycle (refused with "Esta oferta está disponible después de tu primer mes…"), and
 *   3. no discount already active — non-stackable (refused with "Ya tienes una oferta activa.").
 * Because RETENTION_30_3M lasts 3 months (repeating), check (3) also naturally blocks
 * re-application for ~3 months once granted — without a schema change.
 *
 * The 'pause' branch keeps the no-active-discount gate (so a pause can't stack on an
 * already-discounted/abused sub) but intentionally does NOT require the 30-day tenure: a pause
 * grants no monetary discount to farm — it just defers collection while the venue keeps its
 * data — so the buy→cancel farming vector doesn't apply, and a struggling brand-new customer
 * who needs to pause is exactly who the pause offer is for.
 *
 * Does NOT touch the VenueFeature row — the venue keeps the same plan/entitlement.
 * Returns the fresh PlanState (same envelope as cancel/reactivate).
 */
export async function applyRetentionOffer(venueId: string, offer: RetentionOffer = 'discount'): Promise<PlanState> {
  // Active base plan required (any paid tier).
  const tier = await getVenueBaseTier(venueId)
  if (tier === null) throw new BadRequestError('Este venue no tiene un plan base activo.')

  const vf = await findPlanProFeature(venueId)
  if (!vf?.stripeSubscriptionId) {
    throw new BadRequestError('No hay suscripción de Stripe sobre la cual aplicar la oferta. Contacta a soporte.')
  }
  const subscriptionId = vf.stripeSubscriptionId

  // Read the live subscription once to re-check eligibility server-side (tenure + active discount).
  // This is the authoritative gate — never trust the client's view of eligibility.
  const sub = await retrievePlanSubscription(subscriptionId)

  // Anti-abuse (both offers): refuse if the subscription already carries an active discount.
  if (sub.hasActiveDiscount) throw new BadRequestError('Ya tienes una oferta activa.')

  // Anti-farm (discount only): refuse before the first billing cycle has elapsed.
  if (offer !== 'pause' && !meetsRetentionTenure(sub.createdAt)) {
    throw new BadRequestError('Esta oferta está disponible después de tu primer mes de suscripción.')
  }

  if (offer === 'pause') {
    const blocked = await pauseBlocker(venueId, sub)
    if (blocked) throw new BadRequestError(blocked)

    const resumesAt = new Date()
    resumesAt.setMonth(resumesAt.getMonth() + RETENTION_PAUSE_MONTHS)
    await pauseSubscriptionCollection(subscriptionId, resumesAt)

    logAction({
      venueId,
      action: 'PLAN_RETENTION_PAUSE',
      entity: 'VenueFeature',
      entityId: vf.id,
      data: { subscriptionId, resumesAt: resumesAt.toISOString() },
    })
  } else {
    await applySubscriptionCoupon(subscriptionId, RETENTION_DISCOUNT_COUPON)

    logAction({
      venueId,
      action: 'PLAN_RETENTION_DISCOUNT',
      entity: 'VenueFeature',
      entityId: vf.id,
      data: { subscriptionId, coupon: RETENTION_DISCOUNT_COUPON },
    })
  }

  return getPlanState(venueId)
}

export default { getPlanState, cancelPlan, reactivatePlan, applyRetentionOffer }
