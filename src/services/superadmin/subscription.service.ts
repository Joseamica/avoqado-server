import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import Stripe from 'stripe'
import { PAID_PLAN_TIER_CODES, derivePlanState } from '@/services/access/basePlan.service'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

export type SubscriptionState = 'none' | 'trial' | 'active' | 'canceling' | 'past_due' | 'suspended' | 'canceled'
export type SuperadminPlanTier = 'GRATIS' | 'PRO' | 'PREMIUM' | 'ENTERPRISE' | null

export type SuperadminVenueSubscription = {
  venueId: string
  name: string
  slug: string
  planTier: SuperadminPlanTier
  state: SubscriptionState
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  mrr: number
  stripeSubscriptionId: string | null
  owner: { name: string | null; email: string | null }
}

export type SubscriptionOverview = {
  counts: {
    active: number
    trial: number
    canceling: number
    past_due: number
    suspended: number
    canceled: number
    none: number
    total: number
  }
  mrr: { total: number; currency: 'MXN' }
  trialsEndingSoon: Array<{ venueId: string; name: string; trialEndsAt: string }>
}

/** Monthly-normalized gross amount (pesos) from a Stripe price. Annual → /12; N-month → /N. Stripe unit_amount is cents. */
export function monthlyMrrFromPrice(
  price: { unit_amount: number | null; recurring: { interval: string; interval_count: number } | null } | null,
): number {
  if (!price || price.unit_amount == null || !price.recurring) return 0
  const pesos = price.unit_amount / 100
  const { interval, interval_count } = price.recurring
  const months = interval === 'year' ? 12 * interval_count : interval === 'month' ? interval_count : 1
  if (months <= 0) return 0
  return Math.round((pesos / months) * 100) / 100
}

/** Tally a per-venue list into SubscriptionOverview['counts']. */
export function buildOverviewCounts(rows: SuperadminVenueSubscription[]): SubscriptionOverview['counts'] {
  const counts = { active: 0, trial: 0, canceling: 0, past_due: 0, suspended: 0, canceled: 0, none: 0, total: 0 }
  for (const r of rows) {
    counts[r.state] += 1
    counts.total += 1
  }
  return counts
}

type ListParams = { state?: SubscriptionState; q?: string; page: number; pageSize: number }

/** A single venue row as loaded by {@link loadVenueSubscriptions}: its PLAN_PRO VenueFeature (if any) + owner staff. */
type VenueSubscriptionRow = {
  id: string
  name: string
  slug: string
  planTier: string | null
  features: Array<{
    active: boolean
    endDate: Date | null
    suspendedAt: Date | null
    gracePeriodEndsAt: Date | null
    stripeSubscriptionId: string | null
    stripePriceId: string | null
    monthlyPrice: { toString(): string }
  }>
  staff: Array<{ role: string; staff: { firstName: string; lastName: string; email: string } | null }>
}

/** Map one venue row (with its PLAN_PRO feature + owner) into a SuperadminVenueSubscription, reading Stripe when a sub id exists. */
async function mapVenueSubscription(v: VenueSubscriptionRow): Promise<SuperadminVenueSubscription> {
  const vf = v.features[0] ?? null

  // Read Stripe on demand (best-effort — never throw the whole list on one bad sub).
  let stripeSub: { status: string; cancelAtPeriodEnd: boolean } | null = null
  let mrr = 0
  let currentPeriodEnd: string | null = null
  if (vf?.stripeSubscriptionId) {
    try {
      const sub = (await stripe.subscriptions.retrieve(vf.stripeSubscriptionId)) as any
      stripeSub = { status: sub.status, cancelAtPeriodEnd: !!sub.cancel_at_period_end }
      currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
      const price = sub.items?.data?.[0]?.price ?? null
      mrr = monthlyMrrFromPrice(price)
    } catch (err) {
      logger.warn(`[superadmin/subscriptions] Stripe read failed for ${vf.stripeSubscriptionId}`, err)
    }
  }

  const { state } = derivePlanState(vf, stripeSub)
  // MRR only counts for entitled states. Fallback to VenueFeature.monthlyPrice when no Stripe amount (DB-only trial).
  if (state !== 'active' && state !== 'trial') mrr = 0
  else if (mrr === 0 && vf) mrr = Number(vf.monthlyPrice.toString()) || 0

  const ownerStaff = v.staff.find(s => s.role === 'OWNER') ?? v.staff.find(s => s.role === 'ADMIN')
  const owner = ownerStaff?.staff
    ? { name: `${ownerStaff.staff.firstName} ${ownerStaff.staff.lastName}`.trim() || null, email: ownerStaff.staff.email || null }
    : { name: null, email: null }

  return {
    venueId: v.id,
    name: v.name,
    slug: v.slug,
    planTier: (v.planTier as SuperadminPlanTier) ?? null,
    state,
    trialEndsAt: vf?.endDate ? vf.endDate.toISOString() : null,
    currentPeriodEnd,
    mrr,
    stripeSubscriptionId: vf?.stripeSubscriptionId ?? null,
    owner,
  }
}

/** Shared loader: every venue + its single PLAN_PRO VenueFeature (if any) + owner staff. Tenant scope = superadmin (all venues). */
async function loadVenueSubscriptions(q?: string): Promise<SuperadminVenueSubscription[]> {
  const venues = (await prisma.venue.findMany({
    where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q, mode: 'insensitive' } }] } : undefined,
    select: {
      id: true,
      name: true,
      slug: true,
      planTier: true,
      features: {
        where: { feature: { code: { in: [...PAID_PLAN_TIER_CODES] } } },
        select: {
          active: true,
          endDate: true,
          suspendedAt: true,
          gracePeriodEndsAt: true,
          stripeSubscriptionId: true,
          stripePriceId: true,
          monthlyPrice: true,
        },
        take: 1,
      },
      staff: {
        where: { role: { in: ['OWNER', 'ADMIN'] } },
        select: { role: true, staff: { select: { firstName: true, lastName: true, email: true } } },
        take: 5,
      },
    },
    orderBy: { name: 'asc' },
  })) as unknown as VenueSubscriptionRow[]
  return Promise.all(venues.map(mapVenueSubscription))
}

/** Paginated, state-filterable per-venue subscription list. */
export async function getSubscriptionsForSuperadmin(
  params: ListParams,
): Promise<{ items: SuperadminVenueSubscription[]; total: number; page: number; pageSize: number }> {
  const all = await loadVenueSubscriptions(params.q)
  const filtered = params.state ? all.filter(r => r.state === params.state) : all
  const start = (params.page - 1) * params.pageSize
  return { items: filtered.slice(start, start + params.pageSize), total: filtered.length, page: params.page, pageSize: params.pageSize }
}

/** Fleet-wide aggregate: counts by state, total monthly-normalized MRR, trials ending in the next 7 days. */
export async function getSubscriptionOverview(): Promise<SubscriptionOverview> {
  const all = await loadVenueSubscriptions()
  const counts = buildOverviewCounts(all)
  const total = Math.round(all.reduce((sum, r) => sum + r.mrr, 0) * 100) / 100
  const now = Date.now()
  const sevenDays = now + 7 * 86400_000
  const trialsEndingSoon = all
    .filter(
      r =>
        r.state === 'trial' && r.trialEndsAt && new Date(r.trialEndsAt).getTime() <= sevenDays && new Date(r.trialEndsAt).getTime() >= now,
    )
    .map(r => ({ venueId: r.venueId, name: r.name, trialEndsAt: r.trialEndsAt as string }))
  return { counts, mrr: { total, currency: 'MXN' }, trialsEndingSoon }
}
