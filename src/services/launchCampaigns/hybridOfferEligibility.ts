// src/services/launchCampaigns/hybridOfferEligibility.ts
import type { HybridOfferDefinition } from './hybridOffer.schema'

export type HybridOfferBlocker = 'UNAVAILABLE' | 'FULL' | 'INELIGIBLE' | 'PREPARING'

export interface EligibilityCampaign {
  status: string
  startsAt: Date
  endsAt: Date
  capacity: number
  reservedCount: number
  redeemedCount: number
  audience: string
  eligibleOrganizationIds: string[]
  latestPublicationId: string | undefined
}

export interface EligibilityPublication {
  id: string
  stripePriceId: string | null
  stripeProductId: string | null
  stripeRenewalPriceId: string | null
  renewalKind: HybridOfferDefinition['terms']['renewal']['kind']
}

/** Whether a campaign's audience includes this organization. */
export function audienceIncludes(
  campaign: Pick<EligibilityCampaign, 'audience' | 'eligibleOrganizationIds' | 'startsAt'>,
  organization: { id: string; createdAt: Date },
): boolean {
  if (campaign.audience === 'ORGANIZATIONS') return campaign.eligibleOrganizationIds.includes(organization.id)
  if (campaign.audience === 'NEW_ORGANIZATIONS') return organization.createdAt >= campaign.startsAt
  return true
}

/**
 * Why an offer can't be bought right now, or null when it can. The quote turns each answer into its error; the feature
 * grid only proposes candidates (the quote revalidates). Redemption per organization is a query, not part of this.
 */
export function hybridOfferBlocker(
  campaign: EligibilityCampaign,
  publication: EligibilityPublication,
  organization: { id: string; createdAt: Date },
  now: Date,
): HybridOfferBlocker | null {
  if (campaign.status !== 'ACTIVE' || campaign.startsAt > now || campaign.endsAt <= now || campaign.latestPublicationId !== publication.id)
    return 'UNAVAILABLE'
  if (campaign.reservedCount + campaign.redeemedCount >= campaign.capacity) return 'FULL'
  if (!audienceIncludes(campaign, organization)) return 'INELIGIBLE'
  if (
    !publication.stripePriceId ||
    !publication.stripeProductId ||
    (publication.renewalKind === 'REPRICE' && !publication.stripeRenewalPriceId)
  )
    return 'PREPARING'
  return null
}
