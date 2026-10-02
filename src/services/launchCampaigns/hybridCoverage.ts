import { addDays, addMonths, startOfDay } from 'date-fns'
import { FEATURE_CATALOG } from '@/config/featureCatalog'
import { PAID_PLAN_TIER_CODES } from '@/services/access/basePlan.service'
import type { InventarioDeObligaciones } from '@/services/access/inventarioDeObligaciones'
import type { Proyeccion } from '@/services/access/obligacionesDeCobro'
import { assertDependencyTerms, type CoverageItem } from './hybridDependencies'
import { hybridOfferDefinition, type HybridOfferDefinition } from './hybridOffer.schema'
import { planIncludes } from './hybridOffer.service'

/** The functions a live obligation sells. A classic plan brings what a published plan of its tier brings. */
export const projectionCodes = (projection: Proyeccion): string[] => {
  if (projection.tipo === 'FUNCION') return [projection.featureCode]
  if (projection.tipo === 'PAQUETE') return projection.featureCodes
  if (projection.tipo === 'PLAN')
    return (
      projection.featureCodes ??
      FEATURE_CATALOG.flatMap(entry => (entry.featureCode && planIncludes(projection.tier, entry) ? [entry.featureCode] : []))
    )
  return []
}

const earliest = (...dates: Array<Date | null | undefined>) =>
  dates.reduce<Date | null>((min, date) => (date && (!min || date < min) ? date : min), null)
const endOfPromotion = (terms: HybridOfferDefinition['terms'], from: Date) =>
  terms.renewal.kind === 'END' ? addMonths(from, terms.promotionCycles ?? 0) : null

/** New cart lines as coverage: END lines end at now + promotionCycles months; others never. */
export function lineCoverage(
  lines: Array<{ publicationId: string; featureCodes: string[]; terms: HybridOfferDefinition['terms'] }>,
  now: Date,
): CoverageItem[] {
  return lines.flatMap(line => {
    const endsAt = endOfPromotion(line.terms, now)
    return line.featureCodes.map(featureCode => ({
      featureCode,
      endsAt,
      unit: { kind: 'LINE' as const, publicationId: line.publicationId },
    }))
  })
}

/**
 * Latest start of an accepted purchase's Stripe period, after its acceptance: provisioning may journal the subscription
 * until `paymentExpiresAt` (acceptance + 23 h, `acceptHybridQuote`) and then create it under that journal's key for 23 h
 * more (`recordedStripeWrite`); one more hour covers the calls in flight. An END line runs its cycles from that start.
 */
export const MAX_START_DELAY_MS = 47 * 3600000

/**
 * Spec §4.2 rule 2 for a cart: its END lines start with the Stripe period, anywhere from `now` to MAX_START_DELAY_MS
 * later (lines of one cart share that start). `addMonths` clips month ends (29–31 Jan → 28 Feb), so an end is not
 * monotone in the start across a midnight of the zone date-fns uses (the runtime's). Within one such day every line end
 * moves with the start (slope 1) and a kept end not at all (slope 0), so the gap between a function and its dependency
 * is monotone on each day: the window's two ends plus both sides of each midnight inside it cover every start.
 */
export function assertCartDependencyTerms(retained: CoverageItem[], lines: Parameters<typeof lineCoverage>[0], now: Date): void {
  const latest = new Date(now.getTime() + MAX_START_DELAY_MS)
  const starts = [now, latest]
  for (let midnight = addDays(startOfDay(now), 1); midnight <= latest; midnight = addDays(midnight, 1))
    starts.push(new Date(midnight.getTime() - 1), midnight)
  for (const start of starts) assertDependencyTerms([...retained, ...lineCoverage(lines, start)])
}

/** What the quote already read about the venue, without the subscriptions it replaces. */
export interface RetainedSources {
  inventory: Pick<InventarioDeObligaciones, 'vivas' | 'detalle'>
  replaceSubscriptionIds: readonly string[]
  /** Live (not ended) hybrid contracts of the KEPT subscriptions. */
  contracts: Array<{
    stripeSubscriptionId: string
    featureCodes: string[]
    startsAt: Date
    cancelAt: Date | null
    publication: { definition: unknown }
  }>
  /** Active, not suspended VenueFeature rows outside the replaced subscriptions (plan rows included). */
  legacy: Array<{ stripeSubscriptionId: string | null; endDate: Date | null; feature: { code: string } }>
  grants: Array<{ featureCode: string; endsAt: Date; contractId: string | null }>
}

/**
 * Retained coverage WITH END DATES (spec §4.2 rules 2-3), built from the reads the quote already does — no second walk.
 * A kept subscription covers its projection until Stripe's scheduled end; a hybrid contract inside it ends earlier at its
 * `cancelAt` (ANY renewal) or when its END promotion runs out; a legacy row never outlives its live subscription.
 */
export function retainedCoverage(sources: RetainedSources): CoverageItem[] {
  const subscriptionEnd = (id: string | null) => {
    const iso = id ? sources.inventory.detalle[id]?.terminaEn : null
    return iso ? new Date(iso) : null
  }
  const contractEnd = (contract: RetainedSources['contracts'][number]) =>
    earliest(contract.cancelAt, endOfPromotion(hybridOfferDefinition.parse(contract.publication.definition).terms, contract.startsAt))
  const retained = (source: string) => ({ kind: 'RETAINED' as const, source })
  const kept = sources.inventory.vivas.filter(source => !sources.replaceSubscriptionIds.includes(source.subscriptionId))
  return [
    ...kept.flatMap(source => {
      const contracts = sources.contracts.filter(contract => contract.stripeSubscriptionId === source.subscriptionId)
      return [...new Set(source.proyecciones.flatMap(projectionCodes))].map(featureCode => {
        const contract = contracts.find(row => row.featureCodes.includes(featureCode))
        return {
          featureCode,
          endsAt: earliest(subscriptionEnd(source.subscriptionId), contract && contractEnd(contract)),
          unit: retained(source.subscriptionId),
        }
      })
    }),
    ...sources.legacy.flatMap(row => {
      const code = row.feature.code
      const codes = (PAID_PLAN_TIER_CODES as readonly string[]).includes(code)
        ? projectionCodes({ tipo: 'PLAN', tier: code === 'PLAN_PREMIUM' ? 'PREMIUM' : 'PRO' })
        : [code]
      const endsAt = earliest(row.endDate, subscriptionEnd(row.stripeSubscriptionId))
      return codes.map(featureCode => ({ featureCode, endsAt, unit: retained(row.stripeSubscriptionId ?? 'manual') }))
    }),
    // A contract's own grants are represented by the contract above (its subscription and its limits).
    ...sources.grants.flatMap(grant =>
      grant.contractId ? [] : [{ featureCode: grant.featureCode, endsAt: grant.endsAt, unit: retained('manual') }],
    ),
  ]
}
