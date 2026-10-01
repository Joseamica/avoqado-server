import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
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
import { hybridOfferDefinition, type HybridOfferDefinition } from './hybridOffer.schema'
import { hybridOfferBlocker } from './hybridOfferEligibility'

// ponytail: today a handful of listed campaigns are live; a warning fires if this ever fills up.
const OFFER_CANDIDATES_CAP = 100

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
}

export interface FeatureGrid {
  catalogVersion: string
  /** False while hybrid sales are closed: functions show, without prices or offers. */
  purchasesEnabled: boolean
  /** The purchasable PLAN offer per tier, for the plan row and "Pro ↔ Premium". */
  plans: { PRO: FeatureGridOffer | null; PREMIUM: FeatureGridOffer | null }
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

function offerView(
  campaignId: string,
  publication: { id: string; name: string; includedFeatureCodes: string[] },
  definition: HybridOfferDefinition,
): FeatureGridOffer {
  return {
    publicationId: publication.id,
    campaignId,
    name: publication.name,
    kind: definition.kind === 'PLAN' ? 'PLAN' : 'FEATURES',
    planTier: definition.kind === 'PLAN' ? definition.planTier : null,
    price: definition.terms.price,
    renewal: definition.terms.renewal.kind,
    renewalPrice: definition.terms.renewal.kind === 'REPRICE' ? definition.terms.renewal.price : null,
    promotionCycles: definition.terms.promotionCycles,
    includedFeatureCodes: publication.includedFeatureCodes,
  }
}

const cheaper = (current: FeatureGridOffer | null | undefined, candidate: FeatureGridOffer) =>
  !current || candidate.price < current.price ? candidate : current

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
  const plans: FeatureGrid['plans'] = { PRO: null, PREMIUM: null }
  const single = new Map<string, FeatureGridOffer>()
  if (purchasesEnabled) {
    const campaigns = await prisma.hybridCampaign.findMany({
      where: {
        status: 'ACTIVE',
        listed: true,
        startsAt: { lte: now },
        endsAt: { gt: now },
        OR: [
          { audience: 'ALL' },
          { audience: 'NEW_ORGANIZATIONS', startsAt: { lte: organization.createdAt } },
          { audience: 'ORGANIZATIONS', eligibleOrganizationIds: { has: organization.id } },
        ],
        redemptions: { none: { organizationId: organization.id, status: { not: 'RELEASED' } } },
      },
      select: {
        id: true,
        purpose: true,
        status: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        reservedCount: true,
        redeemedCount: true,
        audience: true,
        eligibleOrganizationIds: true,
        currentPublicationId: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: OFFER_CANDIDATES_CAP,
    })
    if (campaigns.length === OFFER_CANDIDATES_CAP)
      logger.warn('feature-grid: offer candidates reached the cap', { venueId, cap: OFFER_CANDIDATES_CAP })
    // The publication on sale is each campaign's pointer (never the highest version), read in one bounded query.
    const ids = campaigns.flatMap(campaign => (campaign.currentPublicationId ? [campaign.currentPublicationId] : []))
    const onSale = new Map(
      (ids.length
        ? await prisma.hybridOfferPublication.findMany({
            where: { id: { in: ids } },
            take: ids.length,
            select: {
              id: true,
              name: true,
              definition: true,
              includedFeatureCodes: true,
              stripePriceId: true,
              stripeProductId: true,
              stripeRenewalPriceId: true,
            },
          })
        : []
      ).map(publication => [publication.id, publication]),
    )
    for (const campaign of campaigns) {
      const publication = campaign.currentPublicationId ? onSale.get(campaign.currentPublicationId) : undefined
      if (!publication) continue
      const parsed = hybridOfferDefinition.safeParse(publication.definition)
      if (!parsed.success) {
        logger.warn('feature-grid: stored offer definition is invalid; offer skipped', {
          venueId,
          campaignId: campaign.id,
          publicationId: publication.id,
        })
        continue
      }
      const definition = parsed.data
      const blocker = hybridOfferBlocker(
        { ...campaign, latestPublicationId: campaign.currentPublicationId ?? undefined },
        { ...publication, renewalKind: definition.terms.renewal.kind },
        organization,
        now,
      )
      if (blocker) continue
      const view = offerView(campaign.id, publication, definition)
      if (definition.kind === 'PLAN') plans[definition.planTier] = cheaper(plans[definition.planTier], view)
      else if (definition.kind === 'FEATURES' && definition.featureCodes.length === 1) {
        const [code] = definition.featureCodes
        single.set(code, cheaper(single.get(code), view))
      }
    }
  }

  return {
    catalogVersion,
    purchasesEnabled,
    plans,
    entries: FEATURE_CATALOG.map(entry => ({
      id: entry.id,
      featureCode: entry.featureCode,
      names: entry.names,
      description: entry.description,
      category: entry.category,
      minimumTier: entry.minimumTier,
      offering: entry.offering,
      access: resolveFeatureAccess(entry, context),
      offer: (entry.featureCode && single.get(entry.featureCode)) || null,
    })),
  }
}
