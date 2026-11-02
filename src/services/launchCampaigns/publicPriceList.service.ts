import { FEATURE_CATALOG, FEATURE_CATEGORIES, type FeatureCatalogEntry } from '@/config/featureCatalog'
import { BadRequestError } from '@/errors/AppError'
import { FREE_TIER_CODES } from '@/services/access/basePlan.service'
import prisma from '@/utils/prismaClient'
import { HYBRID_DEPENDENCIES } from './hybridDependencies'
import { listPriceBoard } from './hybridListPrice.service'

/**
 * The public price list of /presentacion/precios (spec 2026-10-26-presentacion-de-precios): what a prospect may see of the
 * SUPERADMIN «Precios» board, read live on every request so it never drifts from it. Prices are MXN with IVA included.
 */
export type PublicKind = 'SUELTA' | 'INCLUIDO' | 'SE_COTIZA'
export type PlanTier = 'PRO' | 'PREMIUM'
export interface PublicFeature {
  id: string
  name: string
  description: string
  category: string
  categoryLabel: string
  requirement: string | null
  requires: string[]
  kind: PublicKind
  price: number | null
  includedIn: PlanTier[]
}
export interface PublicPlan {
  tier: PlanTier
  name: string
  price: number
}
export interface PublicPriceList {
  plans: PublicPlan[]
  features: PublicFeature[]
}
export interface PriceOption {
  kind: 'SUELTO' | PlanTier
  totalCents: number
  /** Loose functions paid on top of the plan (the plan does not sell them). */
  extras: string[]
}
export interface PriceSelection {
  /** What was ticked plus its paid requirements, in list order. */
  chosen: PublicFeature[]
  addedByRequirement: string[]
  /** «Se cotiza»: never summed. */
  quoted: PublicFeature[]
  options: PriceOption[]
  best: PriceOption
  savingsCents: number
}

/** The names of the SUPERADMIN «Precios» screen (avoqado-superadmin/src/shared/lib/feature-categories.ts), in its order. */
export const CATEGORY_LABELS: Record<string, string> = {
  sell: 'Cobrar y vender',
  customers: 'Clientes',
  inventory: 'Inventario',
  money: 'Dinero y reportes',
  team: 'Tu equipo',
  ai: 'Asistente y conexión',
  custom: 'A la medida',
}

export class PriceListChangedError extends BadRequestError {
  constructor() {
    super('Un módulo cambió o ya no está disponible. Recarga la página.', 'PRICE_LIST_CHANGED')
  }
}

const TIERS: PlanTier[] = ['PRO', 'PREMIUM']
const cents = (price: number) => Math.round(price * 100)

/** From the catalog entry, not `notEditableReason`: there a code-less BASE_* entry reads SYSTEM before FREE. */
function kindOf(entry: FeatureCatalogEntry): PublicKind {
  if (entry.offering === 'CONTACT') return 'SE_COTIZA'
  if (entry.minimumTier === 'FREE' || entry.offering === 'INCLUDED') return 'INCLUIDO'
  if (entry.featureCode && (FREE_TIER_CODES as readonly string[]).includes(entry.featureCode)) return 'INCLUIDO'
  return 'SUELTA'
}

/** What each plan's list on sale sells today: a publication freezes its composition (`planListCompositionGap`). */
async function publishedPlanCodes(): Promise<Map<PlanTier, Set<string>>> {
  const lists = await prisma.hybridCampaign.findMany({
    where: { purpose: 'LIST', listProductKey: { in: TIERS.map(tier => `PLAN:${tier}`) } },
    select: { listProductKey: true, currentPublicationId: true },
    take: TIERS.length,
  })
  const ids = lists.flatMap(list => (list.currentPublicationId ? [list.currentPublicationId] : []))
  const publications = ids.length
    ? await prisma.hybridOfferPublication.findMany({
        where: { id: { in: ids } },
        select: { id: true, includedFeatureCodes: true },
        take: ids.length,
      })
    : []
  const codes = new Map(publications.map(p => [p.id, p.includedFeatureCodes]))
  return new Map(
    lists.map(list => [list.listProductKey!.slice('PLAN:'.length) as PlanTier, new Set(codes.get(list.currentPublicationId ?? '') ?? [])]),
  )
}

export async function getPublicPriceList(): Promise<PublicPriceList> {
  const [board, composition] = await Promise.all([listPriceBoard(), publishedPlanCodes()])
  const onSale = new Map(board.filter(r => r.status === 'ACTIVE' && r.price !== null).map(r => [r.productKey, r.price as number]))
  const plans = TIERS.flatMap(tier => {
    const price = onSale.get(`PLAN:${tier}`)
    return price === undefined ? [] : [{ tier, name: tier === 'PRO' ? 'Pro' : 'Premium', price }]
  })
  const order = (category: string) => (FEATURE_CATEGORIES as readonly string[]).indexOf(category)
  const features = [...FEATURE_CATALOG]
    .sort((a, b) => order(a.category) - order(b.category))
    .flatMap((entry): PublicFeature[] => {
      const kind = kindOf(entry)
      const price = kind === 'SUELTA' ? onSale.get(`FEATURE:${entry.featureCode ?? entry.id}`) : null
      if (price === undefined) return [] // paused or without a price: not for sale loose today
      return [
        {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          category: entry.category,
          categoryLabel: CATEGORY_LABELS[entry.category] ?? entry.category,
          requirement: entry.requirement,
          requires: entry.featureCode ? [...(HYBRID_DEPENDENCIES[entry.featureCode] ?? [])] : [],
          kind,
          price,
          includedIn: plans.filter(p => entry.featureCode && composition.get(p.tier)?.has(entry.featureCode)).map(p => p.tier),
        },
      ]
    })
  // Codex plan-r1 #1: a loose function whose paid requirement is not on sale cannot be bought today. Showing it would
  // sum its price without the requirement's, so it leaves the list too (repeat: a requirement may itself fall out).
  let sellable = features
  for (let changed = true; changed; ) {
    const loose = new Set(sellable.filter(f => f.kind === 'SUELTA').map(f => f.id))
    const next = sellable.filter(f => f.kind !== 'SUELTA' || f.requires.every(id => loose.has(id)))
    changed = next.length !== sellable.length
    sellable = next
  }
  return { plans, features: sellable }
}

/**
 * The money of the «B» option, in integer cents. The page mirrors it only to paint; the e-mail uses this one.
 * Loose = Σ ticked loose functions (and their paid requirements); each plan = its price + the loose ones it does not sell.
 * The cheapest wins; ties go to the first of SUELTO, PRO, PREMIUM.
 */
export function priceSelection(list: PublicPriceList, ids: string[]): PriceSelection {
  const byId = new Map(list.features.map(f => [f.id, f]))
  if (new Set(ids).size !== ids.length) throw new PriceListChangedError()
  const picked = new Set<string>()
  const add = (id: string) => {
    const feature = byId.get(id)
    if (!feature || picked.has(id) || feature.kind !== 'SUELTA') return
    picked.add(id)
    feature.requires.forEach(add)
  }
  for (const id of ids) {
    const feature = byId.get(id)
    if (!feature || feature.kind === 'INCLUIDO') throw new PriceListChangedError()
    if (feature.kind === 'SUELTA') add(id)
  }
  const chosen = list.features.filter(f => picked.has(f.id))
  const quoted = list.features.filter(f => f.kind === 'SE_COTIZA' && ids.includes(f.id))
  const sum = (features: PublicFeature[]) => features.reduce((total, f) => total + cents(f.price!), 0)
  const options: PriceOption[] = [
    { kind: 'SUELTO', totalCents: sum(chosen), extras: [] },
    ...list.plans.map(plan => {
      const extras = chosen.filter(f => !f.includedIn.includes(plan.tier))
      return { kind: plan.tier, totalCents: cents(plan.price) + sum(extras), extras: extras.map(f => f.id) }
    }),
  ]
  const best = options.reduce((min, option) => (option.totalCents < min.totalCents ? option : min))
  return {
    chosen,
    addedByRequirement: chosen.filter(f => !ids.includes(f.id)).map(f => f.id),
    quoted,
    options,
    best,
    savingsCents: options[0].totalCents - best.totalCents,
  }
}
