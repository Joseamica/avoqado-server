/**
 * E-commerce charging capability — single source of truth for
 * "can this venue collect money online?".
 *
 * The booking widget exposes two money surfaces (reservation deposits /
 * upfront, and credit-pack purchases). Both must only be offered when the
 * venue actually has a working online-charge rail. This module centralizes
 * that decision so the public venue-info endpoint, the reservation-settings
 * API, the credit-pack checkout, and the MCP tools all agree.
 *
 * SCOPE (today): the only redirect-checkout rail wired for reservation
 * deposits and credit-pack purchases is **Stripe Connect** (chargesEnabled).
 * Mercado Pago is wired for venue-checkout/pay-links (Bricks inline) but NOT
 * for these two surfaces; Blumon e-commerce likewise. So capability here means
 * "has an active Stripe Connect merchant that can charge". `isEcommerceMerchantChargeable`
 * already understands MP/Blumon readiness — kept here so extending these
 * surfaces to those providers later is a one-file change.
 */

import prisma from '@/utils/prismaClient'

/**
 * Whether an EcommerceMerchant channel can ACTUALLY take a charge right now.
 *
 * - BLUMON: readiness is a non-empty OAuth `accessToken` in providerCredentials
 *   (Blumon has no `chargesEnabled` flag — we must look at the credential).
 * - STRIPE_CONNECT / MERCADO_PAGO: readiness is `chargesEnabled` (set by their
 *   onboarding/OAuth webhooks).
 *
 * Moved here from paymentLink.service.ts so every money surface shares one predicate.
 */
export function isEcommerceMerchantChargeable(merchant: {
  chargesEnabled: boolean
  providerCredentials: unknown
  provider: { code: string } | null
}): boolean {
  if (merchant.provider?.code === 'BLUMON') {
    const accessToken = (merchant.providerCredentials as { accessToken?: unknown } | null)?.accessToken
    return typeof accessToken === 'string' && accessToken.length > 0
  }
  return merchant.chargesEnabled === true
}

/**
 * Resolve the venue's active, chargeable Stripe Connect merchant (or null).
 *
 * This is the rail used by reservation deposits AND (after the routing fix)
 * credit-pack purchases. Returns the full merchant (provider included) so
 * callers can read `platformFeeBps` / `providerCredentials.connectAccountId`
 * and hand it to the provider registry.
 *
 * Consolidates the identical `resolveActiveStripeMerchant` that previously
 * lived in reservation.public.controller.ts and reservation.consumer.service.ts.
 */
export async function resolveChargeableStripeMerchant(venueId: string) {
  return prisma.ecommerceMerchant.findFirst({
    where: {
      venueId,
      active: true,
      chargesEnabled: true,
      provider: { code: 'STRIPE_CONNECT', active: true },
    },
    include: { provider: true },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Boolean capability flag: can this venue charge online for booking-widget
 * surfaces (reservation deposits + credit packs)?
 *
 * Today == has an active chargeable Stripe Connect merchant. Written so a
 * future extension to MP/Blumon (once those redirect-checkout flows exist for
 * these surfaces) only touches this function.
 */
export async function canVenueChargeOnline(venueId: string): Promise<boolean> {
  const merchant = await resolveChargeableStripeMerchant(venueId)
  return !!merchant
}
