import { FRONTEND_URL } from '@/config/env'

/**
 * The dashboard's "Plan y facturación" page for a venue. The dashboard has no /dashboard/* route, so the old
 * `<dashboard>/dashboard/venues/<slug>/billing` links in plan emails landed on its error page. Without a slug,
 * /go/* resolves the user's default venue and keeps the query. The base is the validated FRONTEND_URL of
 * src/config/env.ts — one source of truth for every billing link.
 */
export function billingPageUrl(venueSlug?: string | null, query = ''): string {
  const path = venueSlug ? `/venues/${encodeURIComponent(venueSlug)}/settings/billing/subscriptions` : '/go/settings/billing/subscriptions'
  return `${FRONTEND_URL}${path}${query}`
}
