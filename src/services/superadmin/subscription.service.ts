import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import { addDays } from 'date-fns'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { exigirSinObligacionViva } from '@/services/stripe.service'
import { PAID_PLAN_TIER_CODES, derivePlanState } from '@/services/access/basePlan.service'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'

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
const PLAN_PRO_FEATURE_CODE = 'PLAN_PRO' as const

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

/** The `select` shape every loader shares so {@link mapVenueSubscription} can map any row identically. */
const VENUE_SUBSCRIPTION_SELECT = {
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
} satisfies Prisma.VenueSelect

/** Shared loader: every venue + its single PLAN_PRO VenueFeature (if any) + owner staff. Tenant scope = superadmin (all venues). */
async function loadVenueSubscriptions(q?: string): Promise<SuperadminVenueSubscription[]> {
  const venues = (await prisma.venue.findMany({
    where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q, mode: 'insensitive' } }] } : undefined,
    select: VENUE_SUBSCRIPTION_SELECT,
    orderBy: { name: 'asc' },
  })) as unknown as VenueSubscriptionRow[]
  return Promise.all(venues.map(mapVenueSubscription))
}

/** Single-venue subscription row, mapped with the SAME logic as the list. `null` if the venue doesn't exist. */
export async function getVenueSubscription(venueId: string): Promise<SuperadminVenueSubscription | null> {
  const venue = (await prisma.venue.findFirst({
    where: { id: venueId },
    select: VENUE_SUBSCRIPTION_SELECT,
  })) as unknown as VenueSubscriptionRow | null
  if (!venue) return null
  return mapVenueSubscription(venue)
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

type PlanFeatureRow = Prisma.FeatureGetPayload<{ select: { id: true; monthlyPrice: true } }>

async function requirePlanFeatureTx(tx: Prisma.TransactionClient, venueId: string): Promise<PlanFeatureRow> {
  const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { id: true } })
  if (!venue) throw new NotFoundError('Venue no encontrado')

  const feature = await tx.feature.findUnique({
    where: { code: PLAN_PRO_FEATURE_CODE },
    select: { id: true, monthlyPrice: true },
  })
  if (!feature) throw new NotFoundError('Feature PLAN_PRO no encontrado')
  return feature
}

type PlanMutationResult = { auditData: Prisma.InputJsonObject }

async function runAuditedPlanMutation(
  venueId: string,
  actorId: string,
  action: string,
  mutate: (tx: Prisma.TransactionClient, feature: PlanFeatureRow) => Promise<PlanMutationResult>,
): Promise<SuperadminVenueSubscription> {
  const venue = await prisma.$transaction(async tx => {
    const feature = await requirePlanFeatureTx(tx, venueId)
    const { auditData } = await mutate(tx, feature)

    await writeLegacyActivityAuditTx(tx, {
      staffId: actorId,
      venueId,
      action,
      entity: 'VenueFeature',
      entityId: venueId,
      data: { featureCode: PLAN_PRO_FEATURE_CODE, ...auditData },
    })

    const updatedVenue = (await tx.venue.findFirst({
      where: { id: venueId },
      select: VENUE_SUBSCRIPTION_SELECT,
    })) as unknown as VenueSubscriptionRow | null
    if (!updatedVenue) throw new NotFoundError('Venue no encontrado')
    return updatedVenue
  })

  return mapVenueSubscription(venue)
}

export async function activateVenuePlan(venueId: string, actorId: string): Promise<SuperadminVenueSubscription> {
  return runAuditedPlanMutation(venueId, actorId, 'SUPERADMIN_PLAN_ACTIVATED', async (tx, feature) => {
    await tx.venueFeature.upsert({
      where: { venueId_featureId: { venueId, featureId: feature.id } },
      create: {
        venueId,
        featureId: feature.id,
        active: true,
        monthlyPrice: feature.monthlyPrice,
        startDate: new Date(),
      },
      update: { active: true, endDate: null, monthlyPrice: feature.monthlyPrice },
    })
    return { auditData: {} }
  })
}

export async function deactivateVenuePlan(venueId: string, actorId: string): Promise<SuperadminVenueSubscription> {
  // 🔴 R0: apagar el plan de quien sigue pagando lo deja pagando sin acceso. Para cortar, se cancela en Stripe.
  const vinculo = await vinculoDelPlan(venueId)
  await exigirSinObligacionViva(vinculo, 'desactivar el plan')
  return runAuditedPlanMutation(venueId, actorId, 'SUPERADMIN_PLAN_DEACTIVATED', async (tx, feature) => {
    await escribirPlanSiVinculoIgual(tx, venueId, feature.id, vinculo, { active: false, endDate: new Date() })
    return { auditData: {} }
  })
}

/**
 * 🔴 R0 (Codex, 21-sep): el vínculo del plan a Stripe, leído ANTES de la transacción para poder consultar a
 * Stripe fuera de ella. Dentro, `escribirPlanSiVinculoIgual` escribe SÓLO si sigue igual.
 */
async function vinculoDelPlan(venueId: string): Promise<string | null> {
  const fila = await prisma.venueFeature.findFirst({
    where: { venueId, feature: { code: PLAN_PRO_FEATURE_CODE } },
    select: { stripeSubscriptionId: true },
  })
  return fila?.stripeSubscriptionId ?? null
}

/**
 * 🔴 La escritura es CONDICIONAL al vínculo comprobado (R0, Codex ronda 3): comparar y después escribir sin
 * condición dejaba caber, entre las dos, un cobro que liga una suscripción nueva — y la escritura la pisaba.
 * El `UPDATE … WHERE stripeSubscriptionId = <comprobado>` ES la comparación. Si no existe la fila y hay
 * `crear`, se crea (nunca `upsert`, que pisaría una fila recién creada por otro).
 */
async function escribirPlanSiVinculoIgual(
  tx: Prisma.TransactionClient,
  venueId: string,
  featureId: string,
  esperado: string | null,
  data: Prisma.VenueFeatureUpdateManyMutationInput,
  crear?: Prisma.VenueFeatureUncheckedCreateInput,
): Promise<void> {
  const { count } = await tx.venueFeature.updateMany({ where: { venueId, featureId, stripeSubscriptionId: esperado }, data })
  if (count > 0) return
  const existe = await tx.venueFeature.findFirst({ where: { venueId, featureId }, select: { id: true } })
  if (existe || esperado !== null) {
    throw new ConflictError('El plan de este negocio cambió mientras se hacía el ajuste. Vuelve a intentarlo.', 'SUBSCRIPTION_LINK_CHANGED')
  }
  if (!crear) throw new BadRequestError('El venue no tiene un plan PLAN_PRO')
  try {
    await tx.venueFeature.create({ data: crear })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      throw new ConflictError('El plan de este negocio cambió mientras se hacía el ajuste. Vuelve a intentarlo.', 'SUBSCRIPTION_LINK_CHANGED')
    }
    throw error
  }
}

export async function grantVenuePlanTrial(venueId: string, days: number, actorId: string): Promise<SuperadminVenueSubscription> {
  // 🔴 R0: un trial local sobre una suscripción que sigue cobrando borraba su vínculo — el negocio seguía
  // pagando y, al vencer el trial, se quedaba sin acceso. Se rechaza; nunca se cancela por debajo.
  const vinculo = await vinculoDelPlan(venueId)
  await exigirSinObligacionViva(vinculo, 'conceder una prueba del plan')
  return runAuditedPlanMutation(venueId, actorId, 'SUPERADMIN_PLAN_TRIAL_GRANTED', async (tx, feature) => {
    const startDate = new Date()
    const endDate = addDays(startDate, days)
    await escribirPlanSiVinculoIgual(
      tx,
      venueId,
      feature.id,
      vinculo,
      {
        active: true,
        startDate,
        endDate,
        monthlyPrice: feature.monthlyPrice,
        stripeSubscriptionId: null,
        stripeSubscriptionItemId: null,
        suspendedAt: null,
        gracePeriodEndsAt: null,
      },
      { venueId, featureId: feature.id, active: true, monthlyPrice: feature.monthlyPrice, startDate, endDate },
    )
    return { auditData: { days, endDate: endDate.toISOString() } }
  })
}

/**
 * Superadmin management action: shift a venue's PLAN_PRO end date by `deltaDays`
 * (negative shortens it). Base is the existing endDate, or now() if it's null.
 * Returns the freshly-mapped single-venue row. Throws BadRequestError if the
 * venue has no PLAN_PRO VenueFeature.
 */
export async function adjustVenuePlanEndDate(venueId: string, deltaDays: number, actorId: string): Promise<SuperadminVenueSubscription> {
  // 🔴 R0: poner vencimiento a un plan que Stripe sigue cobrando le quita el acceso a quien paga al llegar
  // esa fecha. Sólo se ajustan planes sin suscripción viva (trials locales).
  const vinculo = await vinculoDelPlan(venueId)
  await exigirSinObligacionViva(vinculo, 'ajustar la vigencia del plan')
  return runAuditedPlanMutation(venueId, actorId, 'SUPERADMIN_PLAN_ENDDATE_ADJUSTED', async tx => {
    const vf = await tx.venueFeature.findFirst({
      where: { venueId, feature: { code: PLAN_PRO_FEATURE_CODE } },
      select: { id: true, endDate: true, stripeSubscriptionId: true },
    })
    if (!vf) throw new BadRequestError('El venue no tiene un plan PLAN_PRO')
    if ((vf.stripeSubscriptionId ?? null) !== vinculo) {
      throw new ConflictError('El plan de este negocio cambió mientras se hacía el ajuste. Vuelve a intentarlo.', 'SUBSCRIPTION_LINK_CHANGED')
    }

    const newEnd = addDays(vf.endDate ?? new Date(), deltaDays)
    const { count } = await tx.venueFeature.updateMany({ where: { id: vf.id, stripeSubscriptionId: vinculo }, data: { endDate: newEnd } })
    if (count === 0) {
      throw new ConflictError('El plan de este negocio cambió mientras se hacía el ajuste. Vuelve a intentarlo.', 'SUBSCRIPTION_LINK_CHANGED')
    }
    return { auditData: { deltaDays, endDate: newEnd.toISOString() } }
  })
}
