import prisma from '@/utils/prismaClient'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { FEATURE_CATALOG, type FeatureCatalogEntry } from '@/config/featureCatalog'
import {
  FREE_TIER_CODES,
  elPlanConcede,
  getVenueBaseTier,
  getVenueGrantedFeatureCodes,
  type BaseTier,
} from '@/services/access/basePlan.service'
import { resolveGrandfathered } from '@/services/access/grandfather'
import { catalogVersion } from './featureCatalog.service'
import { bestOffersByProduct, type BestOffers } from './hybridBestOffer'

export type FeatureAccessSource = 'GRANDFATHERED' | 'FREE' | 'PLAN' | 'CONTRACT' | 'STANDALONE' | 'NONE'

export interface FeatureAccess {
  source: FeatureAccessSource
  contractId: string | null
  paidThrough: string | null
  cancelAt: string | null
}

export interface FeatureGridOffer {
  publicationId: string
  campaignId: string
  name: string
  kind: 'PLAN' | 'FEATURES'
  planTier: 'PRO' | 'PREMIUM' | null
  /** First charge, in pesos, IVA included. */
  price: number
  /** The product's ACTIVE list price (struck through next to a promotion), or null without one. */
  listPrice: number | null
  renewal: 'SAME_PRICE' | 'REPRICE' | 'END'
  /** Price after the promotion when it renews at another price. */
  renewalPrice: number | null
  promotionCycles: number | null
  includedFeatureCodes: string[]
}

export interface FeatureGridEntry {
  id: string
  featureCode: string | null
  names: FeatureCatalogEntry['names']
  description: string
  category: FeatureCatalogEntry['category']
  minimumTier: FeatureCatalogEntry['minimumTier']
  offering: FeatureCatalogEntry['offering']
  access: FeatureAccess
  /** The cheapest single-function offer this organization can buy now, or null. */
  offer: FeatureGridOffer | null
  /** The function's LIST offer when it is not already `offer`: the alternative when a promotion can't be used (spec §5). */
  listOffer: FeatureGridOffer | null
}

export interface FeatureGrid {
  catalogVersion: string
  /** False while hybrid sales are closed: functions show, without prices or offers. */
  purchasesEnabled: boolean
  /** The purchasable PLAN offer per tier, for the plan row and "Pro ↔ Premium". */
  plans: { PRO: FeatureGridOffer | null; PREMIUM: FeatureGridOffer | null }
  /** Each tier's LIST offer, to rebuild a plan line at its list price (spec §5). */
  planListOffers: { PRO: FeatureGridOffer | null; PREMIUM: FeatureGridOffer | null }
  entries: FeatureGridEntry[]
}

interface ContractRef {
  id: string
  planTier: string | null
  paidThrough: Date | null
  cancelAt: Date | null
}

const accessOf = (source: FeatureAccessSource, contract?: ContractRef): FeatureAccess => ({
  source,
  contractId: contract?.id ?? null,
  paidThrough: contract?.paidThrough?.toISOString() ?? null,
  cancelAt: contract?.cancelAt?.toISOString() ?? null,
})

/**
 * Where one function comes from. Order matters: founder, free for everyone, contact-only, a plan, a contract, bought alone.
 * A CONTACT function is quoted ("Cotizar"), never granted by a plan tier, even when the legacy tier rule would concede it.
 */
export function resolveFeatureAccess(
  entry: FeatureCatalogEntry,
  venue: { grandfathered: boolean; legacyTier: BaseTier | null; contracts: Map<string, ContractRef>; granted: ReadonlySet<string> },
): FeatureAccess {
  if (venue.grandfathered) return accessOf('GRANDFATHERED')
  const code = entry.featureCode
  if (entry.offering === 'INCLUDED' || (code && (FREE_TIER_CODES as readonly string[]).includes(code))) return accessOf('FREE')
  const contract = code ? venue.contracts.get(code) : undefined
  if (entry.offering === 'CONTACT') return contract ? accessOf('CONTRACT', contract) : accessOf('NONE')
  if (!code) return accessOf('NONE')
  if (contract?.planTier) return accessOf('PLAN', contract)
  if (venue.legacyTier && elPlanConcede(venue.legacyTier, code)) return accessOf('PLAN')
  if (contract) return accessOf('CONTRACT', contract)
  if (venue.granted.has(code)) return accessOf('STANDALONE')
  return accessOf('NONE')
}

/**
 * The 40 catalog functions for one venue: where each comes from and the cheapest offer its organization can buy now.
 * "Can buy" shares the purchase's commercial eligibility; the quote still revalidates everything in its transaction.
 */
export async function getHybridFeatureGrid(venueId: string): Promise<FeatureGrid> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { seatCapExempt: true, organization: { select: { id: true, createdAt: true, seatCapExempt: true } } },
  })
  if (!venue?.organization) throw new NotFoundError('Negocio no encontrado.')
  const organization = venue.organization
  const now = new Date()
  const [legacyTier, granted, grants] = await Promise.all([
    getVenueBaseTier(venueId, { legacyOnly: true }),
    getVenueGrantedFeatureCodes(venueId),
    prisma.capabilityGrant.findMany({
      where: { venueId, revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now }, contractId: { not: null } },
      select: { featureCode: true, contract: { select: { id: true, planTier: true, paidThrough: true, cancelAt: true } } },
      orderBy: { id: 'asc' },
      take: 1001,
    }),
  ])
  if (grants.length > 1000) throw new ConflictError('No pudimos revisar todos los accesos del negocio.', 'HYBRID_ACCESS_UNVERIFIED')
  const contracts = new Map<string, ContractRef>()
  for (const grant of grants) if (grant.contract && !contracts.has(grant.featureCode)) contracts.set(grant.featureCode, grant.contract)
  const context = { grandfathered: resolveGrandfathered(venue), legacyTier, contracts, granted: new Set(granted) }

  const purchasesEnabled = process.env.HYBRID_BILLING_ENABLED === 'true'
  const { best, list }: BestOffers = purchasesEnabled ? await bestOffersByProduct(organization, now) : { best: new Map(), list: new Map() }

  return {
    catalogVersion,
    purchasesEnabled,
    plans: { PRO: best.get('PLAN:PRO') ?? null, PREMIUM: best.get('PLAN:PREMIUM') ?? null },
    planListOffers: { PRO: list.get('PLAN:PRO') ?? null, PREMIUM: list.get('PLAN:PREMIUM') ?? null },
    entries: FEATURE_CATALOG.map(entry => {
      const offer = (entry.featureCode && best.get(`FEATURE:${entry.featureCode}`)) || null
      const listOffer = (entry.featureCode && list.get(`FEATURE:${entry.featureCode}`)) || null
      return {
        id: entry.id,
        featureCode: entry.featureCode,
        names: entry.names,
        description: entry.description,
        category: entry.category,
        minimumTier: entry.minimumTier,
        offering: entry.offering,
        access: resolveFeatureAccess(entry, context),
        offer,
        listOffer: listOffer && listOffer.publicationId !== offer?.publicationId ? listOffer : null,
      }
    }),
  }
}
