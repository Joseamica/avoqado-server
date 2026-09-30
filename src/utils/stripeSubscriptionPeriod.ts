import type Stripe from 'stripe'

/**
 * The current billing period of a Stripe subscription.
 *
 * Since API 2025-03-31.basil, `current_period_start/end` no longer live on the subscription: they live on each item
 * (`items.data[].current_period_*`). The SDK pins 2025-09-30.clover, so every API read carries them ONLY on the item.
 * A webhook payload follows its endpoint's API version and may still carry them at the top, so the subscription is
 * read first and the first item second.
 *
 * ponytail: first item only — a plan subscription has one; mixed periods per item would need the earliest end.
 */
export function subscriptionPeriod(sub: Stripe.Subscription): { start: Date | null; end: Date | null } {
  const top = sub as unknown as { current_period_start?: number; current_period_end?: number }
  const item = sub.items?.data?.[0] as { current_period_start?: number; current_period_end?: number } | undefined
  const start = typeof top.current_period_start === 'number' ? top.current_period_start : item?.current_period_start
  const end = typeof top.current_period_end === 'number' ? top.current_period_end : item?.current_period_end
  return {
    start: typeof start === 'number' ? new Date(start * 1000) : null,
    end: typeof end === 'number' ? new Date(end * 1000) : null,
  }
}
