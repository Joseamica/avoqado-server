/**
 * URL builders for TerminalOrder magic-links and admin UI links.
 *
 * Magic-link pages (approve / reject / assign-serials) and the superadmin UI
 * live in the avoqado-superadmin app — not the venue dashboard. Sales receives
 * these URLs by email and uses them WITHOUT logging into the venue dashboard.
 *
 * Env vars:
 *   SUPERADMIN_URL  → base for sales-facing pages
 *                     (e.g. https://superadmin.avoqado.io)
 *   DASHBOARD_URL   → base for customer-facing pages
 *                     (e.g. https://dashboard.avoqado.io)
 */

function getSuperadminBaseUrl(): string {
  return process.env.SUPERADMIN_URL ?? process.env.SUPERADMIN_FRONTEND_URL ?? 'https://superadmin.avoqado.io'
}

function getDashboardBaseUrl(): string {
  return process.env.DASHBOARD_URL ?? process.env.FRONTEND_URL ?? process.env.APP_URL ?? 'https://dashboard.avoqado.io'
}

export function buildMagicLinkUrls(orderId: string, token: string) {
  const base = getSuperadminBaseUrl()
  return {
    approveUrl: `${base}/admin/tpv-orders/${orderId}/approve?token=${encodeURIComponent(token)}`,
    rejectUrl: `${base}/admin/tpv-orders/${orderId}/reject?token=${encodeURIComponent(token)}`,
    adminUiUrl: `${base}/tpv-orders/${orderId}`,
  }
}

export function buildSerialAssignmentUrls(orderId: string, token: string) {
  const base = getSuperadminBaseUrl()
  return {
    serialAssignmentUrl: `${base}/admin/tpv-orders/${orderId}/assign-serials?token=${encodeURIComponent(token)}`,
    adminUiUrl: `${base}/tpv-orders/${orderId}`,
  }
}

/**
 * Dashboard URL builder for customer-facing pages (order detail in venue dashboard).
 */
export function buildVenueOrderDetailUrl(venueSlug: string, orderId: string): string {
  const base = getDashboardBaseUrl()
  return `${base}/venues/${venueSlug}/tpv/orders/${orderId}`
}

/**
 * Stripe Checkout `success_url` / `cancel_url` for a TerminalOrder.
 *
 * `from` controls where the user lands after Stripe:
 *   - `'tpv'` (default): lands at the order detail page inside the venue
 *     dashboard. This is the normal post-onboarding purchase flow.
 *   - `'setup'`: lands at the V2 onboarding wizard, Step 9. The wizard
 *     reads `tpv_status` + `orderId` from the URL to hydrate View B
 *     (order created) or show the cancel toast.
 *
 * Spec: docs/superpowers/specs/2026-05-29-onboarding-tpv-purchase-design.md
 */
export function buildStripeCheckoutUrls(params: { orderId: string; venueSlug: string; from?: 'tpv' | 'setup' }): {
  successUrl: string
  cancelUrl: string
} {
  const base = getDashboardBaseUrl()
  const { orderId, venueSlug, from = 'tpv' } = params

  if (from === 'setup') {
    return {
      successUrl: `${base}/setup?tpv_status=success&orderId=${orderId}&session_id={CHECKOUT_SESSION_ID}#step-8`,
      cancelUrl: `${base}/setup?tpv_status=cancel&orderId=${orderId}#step-8`,
    }
  }

  return {
    successUrl: `${base}/venues/${venueSlug}/tpv/orders/${orderId}?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/venues/${venueSlug}/tpv?cancelled=true`,
  }
}
