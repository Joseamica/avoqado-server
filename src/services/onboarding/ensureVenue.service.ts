/**
 * Provisional venue creation during the V2 onboarding wizard.
 *
 * Problem: Steps 8 (payment providers) and 9 (TPV purchase) both need a real
 * `venueId` for backend calls (ecommerceMerchant.create, terminalOrder.create),
 * but the V2 wizard historically only created the venue at the very end via
 * `setupService.completeSetup`. That left those steps with `venueId=undefined`
 * and the API calls would fail.
 *
 * Solution: lazily ensure a venue exists when the GET progress endpoint runs.
 * The schema already has `VenueStatus.ONBOARDING` (the default) for exactly
 * this case — venue exists in DB but is still being configured. completeSetup
 * is idempotent: it transitions ONBOARDING → ACTIVE/PENDING_ACTIVATION instead
 * of creating a second venue.
 *
 * Cleanup (out of scope here): a separate cron should remove venues stuck in
 * `status=ONBOARDING` with `OnboardingProgress.completedAt = null` after N
 * days. For now they accumulate harmlessly.
 *
 * Spec: docs/superpowers/specs/2026-05-29-onboarding-tpv-purchase-design.md
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { createVenueFromOnboarding } from './venueCreation.service'
import { getV2SetupDataForCompletion } from './onboardingProgress.service'

export interface EnsureVenueResult {
  id: string
  slug: string
  status: string
}

/**
 * Returns the org's venue, creating a provisional one if none exists.
 *
 * Idempotent. Safe to call from any onboarding step that needs `venueId`.
 * Returns `null` only when:
 *   - No venue exists AND
 *   - Wizard data is insufficient to build one (e.g. user hasn't completed
 *     Step 2 businessInfo yet) — callers handle this by omitting `venueId`
 *     from the response so the frontend doesn't try to invoke later steps.
 */
export async function ensureVenueForOnboarding(organizationId: string, userId: string): Promise<EnsureVenueResult | null> {
  // 1. Reuse existing venue if any. We pick the FIRST one created so a
  //    multi-venue org gets a stable answer instead of last-write-wins.
  //    Any status is OK — ACTIVE / ONBOARDING / PENDING_ACTIVATION all
  //    mean "this org has a venue, don't create another."
  const existing = await prisma.venue.findFirst({
    where: { organizationId },
    select: { id: true, slug: true, status: true },
    orderBy: { createdAt: 'asc' },
  })
  if (existing) return existing

  // 2. No venue yet — assemble the minimum CreateVenueInput from wizard data.
  //    getV2SetupDataForCompletion already does the heavy lifting (parses
  //    v2SetupData into the businessInfo / bankInfo shapes the creator wants).
  let setupData
  try {
    setupData = await getV2SetupDataForCompletion(organizationId)
  } catch (err) {
    // The most common reason this throws is "no progress record yet". Callers
    // treat null as "wizard isn't ready" — no venue is created.
    logger.info('ensureVenueForOnboarding: no progress data, skipping creation', {
      organizationId,
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  const businessName = setupData?.businessInfo?.name?.trim()
  if (!businessName) {
    // User reached this endpoint before completing Step 2 (businessInfo).
    // Don't pollute the DB with placeholder venues; the next call (after they
    // actually fill in the business name) will create it for real.
    return null
  }

  // 3. Create as a real (non-demo) venue. Demo flows use a different path
  //    (`onboardingType: 'DEMO'` from explicit user choice in V1 wizard).
  //    V2 is always REAL.
  const result = await createVenueFromOnboarding({
    organizationId,
    userId,
    onboardingType: 'REAL',
    businessInfo: setupData.businessInfo,
    // Optional inputs not yet collected at this point — venueCreation handles
    // missing fields gracefully.
    menuData: undefined,
    kycDocuments: undefined,
    paymentInfo: setupData.bankInfo,
    selectedFeatures: undefined,
    stripePaymentMethodId: undefined,
    teamInvites: undefined,
  } as any)

  return {
    id: result.venue.id,
    slug: result.venue.slug,
    status: result.venue.status,
  }
}
