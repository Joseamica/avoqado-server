import { FEATURE_CATALOG } from '@/config/featureCatalog'
import { ConflictError } from '@/errors/AppError'

// Operational dependencies visible in the existing inventory/upsell routes. This is NOT an access resolver.
// It is part of every offer's definition hash (hybridOffer.service): changing it changes every published hash.
export const HYBRID_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  AUTO_REORDER: ['INVENTORY_TRACKING'],
  UPSELL_AI: ['UPSELL'],
  AGGREGATOR_PASSES: ['RESERVATIONS'], // R36: los pases de TotalPass/Wellhub sólo sirven sobre clases.
}

/** The commercial unit that brings a function: a cart line (its publication) or something the venue keeps. */
export type CoverageUnit = { kind: 'LINE'; publicationId: string } | { kind: 'RETAINED'; source: string }
/** `endsAt: null` = no known end. */
export interface CoverageItem {
  featureCode: string
  endsAt: Date | null
  unit: CoverageUnit
}
export interface DependencyTermIssue {
  featureCode: string
  requiredFeatureCode: string
  requiredUntil: Date | null
  unit: CoverageUnit | null
}

const outlasts = (a: Date | null, b: Date | null) => b !== null && (a === null || a > b)

/** Spec §4.2 rule 2: a function never outlives its dependency. Codes covered by several sources keep the LATEST end. */
export function dependencyTermIssues(items: CoverageItem[], dependencies: Record<string, readonly string[]>): DependencyTermIssue[] {
  const latest = new Map<string, CoverageItem>()
  for (const item of items) {
    const kept = latest.get(item.featureCode)
    if (!kept || outlasts(item.endsAt, kept.endsAt)) latest.set(item.featureCode, item)
  }
  return [...latest.values()]
    .sort((a, b) => a.featureCode.localeCompare(b.featureCode))
    .flatMap(item =>
      (dependencies[item.featureCode] ?? []).flatMap(requiredFeatureCode => {
        const dependency = latest.get(requiredFeatureCode)
        if (dependency && !outlasts(item.endsAt, dependency.endsAt)) return []
        return [{ featureCode: item.featureCode, requiredFeatureCode, requiredUntil: item.endsAt, unit: dependency?.unit ?? null }]
      }),
    )
}

const nameOf = (code: string) => FEATURE_CATALOG.find(entry => entry.featureCode === code)?.name ?? code

/** Spec §4.2 rule 4. The details carry every issue (dates as ISO) so a client can offer the unit that fixes it. */
export function assertDependencyTerms(items: CoverageItem[]) {
  const issues = dependencyTermIssues(items, HYBRID_DEPENDENCIES)
  if (!issues.length) return
  const [first] = issues
  // ponytail: the platform's zone; a venue-local date needs the venue's timezone threaded down here.
  const until = first.requiredUntil
    ? `al menos hasta el ${first.requiredUntil.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' })}`
    : 'mientras la conserves'
  throw new ConflictError(
    `${nameOf(first.featureCode)} necesita ${nameOf(first.requiredFeatureCode)} ${until}: agrégalo con precio de lista o consérvalo.`,
    'HYBRID_DEPENDENCY_TERM',
    issues.map(issue => ({ ...issue, requiredUntil: issue.requiredUntil?.toISOString() ?? null })),
  )
}
