import type Stripe from 'stripe'
import { ConflictError } from '@/errors/AppError'
import type { HybridOfferDefinition } from './hybridOffer.schema'

type ScheduleLine = {
  publicationId: string
  priceId: string
  renewalPriceId: string | null
  terms: Pick<HybridOfferDefinition['terms'], 'promotionCycles' | 'renewal'>
}

/** Relative month durations preserve Stripe's billing anchor, including February and month-end dates. */
export function buildHybridPhases(
  start: number,
  lines: ScheduleLine[],
): Pick<Stripe.SubscriptionScheduleUpdateParams, 'phases' | 'end_behavior'> & { phases: Stripe.SubscriptionScheduleUpdateParams.Phase[] } {
  const transitions = [
    ...new Set(
      lines.flatMap(line =>
        line.terms.renewal.kind !== 'SAME_PRICE' && line.terms.promotionCycles !== null ? [line.terms.promotionCycles] : [],
      ),
    ),
  ].sort((a, b) => a - b)
  if (!transitions.length) return { phases: [], end_behavior: 'release' }
  const boundaries = [0, ...transitions]
  const phases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = []
  let end_behavior: 'release' | 'cancel' = 'release'
  for (const [index, cycle] of boundaries.entries()) {
    const items = lines.flatMap(line => {
      if (line.terms.promotionCycles !== null && cycle >= line.terms.promotionCycles) {
        if (line.terms.renewal.kind === 'END') return []
        if (line.terms.renewal.kind === 'REPRICE') {
          if (!line.renewalPriceId) throw new ConflictError('Falta el precio de renovación.', 'HYBRID_PRICE_MISMATCH')
          return [{ price: line.renewalPriceId, quantity: 1 }]
        }
      }
      return [{ price: line.priceId, quantity: 1 }]
    })
    if (!items.length) {
      end_behavior = 'cancel'
      break
    }
    phases.push({
      ...(index === 0 ? { start_date: start } : {}),
      duration: { interval: 'month', interval_count: (boundaries[index + 1] ?? cycle + 1) - cycle },
      items,
      proration_behavior: 'none',
    })
  }
  return { phases, end_behavior }
}

import type { Prisma } from '@prisma/client'
import { hybridHash, recordedStripeWrite } from './hybridProvider'
import type { HybridQuoteSnapshot } from './hybridPurchase.service'
import prisma from '@/utils/prismaClient'

type ScheduledPurchase = Prisma.HybridPurchaseGetPayload<{ include: { contracts: { include: { publication: true } } } }>
const idOf = (value: string | { id: string } | null) => (typeof value === 'string' ? value : value?.id)

/** Provider-confirmed economic terms; lifecycle status and saved payment method may change independently. */
export function hybridScheduleReceipt(schedule: Stripe.SubscriptionSchedule) {
  return hybridHash({
    customer: idOf(schedule.customer),
    subscription: idOf(schedule.subscription) ?? idOf(schedule.released_subscription),
    end_behavior: schedule.end_behavior,
    phases: schedule.phases.map(phase => ({
      start: phase.start_date,
      end: phase.end_date,
      trialEnd: phase.trial_end,
      collectionMethod: phase.collection_method,
      automaticTax: phase.automatic_tax,
      taxRates: phase.default_tax_rates?.map(idOf).sort(),
      discounts: phase.discounts,
      proration: phase.proration_behavior,
      items: phase.items
        .map(item => ({
          price: idOf(item.price),
          quantity: item.quantity,
          discounts: item.discounts,
          taxRates: item.tax_rates?.map(idOf).sort(),
        }))
        .sort((a, b) => (a.price ?? '').localeCompare(b.price ?? '')),
    })),
  })
}

export async function ensureHybridSchedule(purchase: ScheduledPurchase, subscription: Stripe.Subscription) {
  const quote = purchase.quote as unknown as HybridQuoteSnapshot
  const recipe = buildHybridPhases(
    Math.min(...purchase.contracts.map(c => c.startsAt.getTime() / 1000)),
    quote.lines.map(line => {
      const publication = purchase.contracts.find(c => c.publicationId === line.publicationId)!.publication
      return {
        publicationId: line.publicationId,
        priceId: publication.stripePriceId!,
        renewalPriceId: publication.stripeRenewalPriceId,
        terms: line.terms,
      }
    }),
  )
  if (!recipe.phases.length) return
  const { stripe, STRIPE_DENTRO_DEL_CANDADO: options } = await import('@/services/stripe.service')
  const certifyOwner = (schedule: Stripe.SubscriptionSchedule) => {
    if (
      idOf(schedule.customer) !== purchase.stripeCustomerId ||
      (idOf(schedule.subscription) ?? idOf(schedule.released_subscription)) !== subscription.id
    )
      throw new ConflictError('La renovación no pertenece a esta compra.', 'HYBRID_SCHEDULE_MISMATCH')
    return schedule
  }
  const schedule = await recordedStripeWrite(
    purchase.id,
    'SCHEDULE_CREATE',
    { from_subscription: subscription.id },
    async (saved, idempotencyKey) => certifyOwner(await stripe.subscriptionSchedules.create(saved, { ...options, idempotencyKey })),
    async providerId => {
      const live = await stripe.subscriptions.retrieve(subscription.id, {}, options)
      const id = providerId ?? idOf(live.schedule)
      return id ? certifyOwner(await stripe.subscriptionSchedules.retrieve(id, {}, options)) : null
    },
  )
  const recipeHash = hybridHash(recipe)
  const params: Stripe.SubscriptionScheduleUpdateParams = {
    ...recipe,
    phases: recipe.phases.map(phase => ({ ...phase, discounts: '', automatic_tax: { enabled: false }, default_tax_rates: [] })),
    proration_behavior: 'none',
    metadata: { hybridPurchaseId: purchase.id, venueId: purchase.venueId, recipeHash },
  }
  const matches = (saved: Stripe.SubscriptionSchedule) =>
    saved.metadata?.recipeHash === recipeHash &&
    saved.end_behavior === params.end_behavior &&
    saved.phases.length === recipe.phases.length &&
    saved.phases.every(
      (phase, index) =>
        phase.items.length === recipe.phases[index].items.length &&
        recipe.phases[index].items.every(
          item => phase.items.filter(actual => idOf(actual.price) === item.price && actual.quantity === 1).length === 1,
        ),
    )
  const configured = await recordedStripeWrite(
    purchase.id,
    'SCHEDULE_CONFIGURE',
    { scheduleId: schedule.id, params },
    async (saved, idempotencyKey) => {
      const updated = certifyOwner(
        await stripe.subscriptionSchedules.update(saved.scheduleId, saved.params, { ...options, idempotencyKey }),
      )
      if (!matches(updated)) throw new ConflictError('La renovación no coincide con las condiciones aceptadas.', 'HYBRID_SCHEDULE_MISMATCH')
      return updated
    },
    async () => {
      const current = certifyOwner(await stripe.subscriptionSchedules.retrieve(schedule.id, {}, options))
      return matches(current) ? current : null
    },
  )
  await prisma.hybridBillingOperation.update({
    where: { purchaseId_step: { purchaseId: purchase.id, step: 'SCHEDULE_CONFIGURE' } },
    data: { resultHash: hybridScheduleReceipt(configured) },
  })
}

/** Remove a whole commercial line at its paid boundary while preserving every remaining price transition. */
export function buildHybridCancellationPhases(schedule: Stripe.SubscriptionSchedule, now: number, effectiveAt: number, priceIds: string[]) {
  if (effectiveAt <= now) throw new ConflictError('La renovación ya está en curso.', 'HYBRID_RENEWAL_PENDING')
  const phases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = []
  const remaining = schedule.phases.filter(phase => phase.end_date > now)
  let end_behavior: 'release' | 'cancel' = schedule.end_behavior === 'cancel' ? 'cancel' : 'release'
  let stopped = false
  for (const phase of remaining) {
    const boundaries = [
      phase.start_date,
      ...(effectiveAt > phase.start_date && effectiveAt < phase.end_date ? [effectiveAt] : []),
      phase.end_date,
    ]
    for (let i = 0; i < boundaries.length - 1; i++) {
      const items = phase.items
        .filter(item => boundaries[i] < effectiveAt || !priceIds.includes(idOf(item.price)!))
        .map(item => ({ price: idOf(item.price)!, quantity: item.quantity ?? 1 }))
      if (!items.length) {
        end_behavior = 'cancel'
        stopped = true
        break
      }
      phases.push({
        start_date: boundaries[i],
        end_date: boundaries[i + 1],
        items,
        discounts: '',
        default_tax_rates: [],
        automatic_tax: { enabled: false },
        proration_behavior: 'none',
      })
    }
    if (stopped) break
  }
  const last = remaining.at(-1)
  if (!stopped && last && schedule.end_behavior !== 'cancel' && effectiveAt >= last.end_date) {
    if (effectiveAt > last.end_date) phases.push({ ...phases.at(-1)!, start_date: last.end_date, end_date: effectiveAt })
    const items = last.items
      .filter(item => !priceIds.includes(idOf(item.price)!))
      .map(item => ({ price: idOf(item.price)!, quantity: item.quantity ?? 1 }))
    if (items.length)
      phases.push({
        start_date: effectiveAt,
        duration: { interval: 'month', interval_count: 1 },
        items,
        discounts: '',
        default_tax_rates: [],
        automatic_tax: { enabled: false },
        proration_behavior: 'none',
      })
    else end_behavior = 'cancel'
  }
  if (!phases.length || phases.length > 10)
    throw new ConflictError('No pudimos verificar todas las fases de renovación.', 'HYBRID_SCHEDULE_MISMATCH')
  return { phases, end_behavior }
}
