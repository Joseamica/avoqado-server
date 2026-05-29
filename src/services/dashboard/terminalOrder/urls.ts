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
