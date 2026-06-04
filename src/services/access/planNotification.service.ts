import prisma from '@/utils/prismaClient'

/**
 * Resolved recipient + locale for a plan/subscription lifecycle email.
 * `email` is null when no usable recipient exists (callers must logger.warn + skip, never throw).
 */
export interface PlanNotificationTarget {
  email: string | null
  locale: 'es' | 'en'
  venueName: string
  ownerName: string | null
}

/**
 * Resolve the recipient and locale for any plan email tied to a venue.
 *
 * Recipient precedence:
 *   1. venue.email
 *   2. active OWNER (fallback ADMIN) StaffVenue → Staff.email
 *   3. venue.organization.email
 *   4. null
 *
 * Locale: venue.language === 'en' ? 'en' : 'es' (defaults to 'es').
 */
export async function resolvePlanNotificationTarget(venueId: string): Promise<PlanNotificationTarget> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      name: true,
      email: true,
      language: true,
      organization: { select: { email: true } },
      // NOTE: the relation field on Venue to its StaffVenue rows is named `staff`
      // (see `staff StaffVenue[]` in the Venue model). Each StaffVenue row in turn
      // has a `staff` relation pointing at the Staff person.
      staff: {
        where: { active: true, role: { in: ['OWNER', 'ADMIN'] } },
        select: {
          role: true,
          staff: { select: { email: true, firstName: true, lastName: true } },
        },
      },
    },
  })

  if (!venue) {
    return { email: null, locale: 'es', venueName: 'tu negocio', ownerName: null }
  }

  // Prefer OWNER, then ADMIN; fall back to the first matching row (covers rows where
  // role is not selectable). The `where` clause already restricts to OWNER/ADMIN.
  const staffVenues = venue.staff ?? []
  const ownerVenue = staffVenues.find(sv => sv.role === 'OWNER') ?? staffVenues.find(sv => sv.role === 'ADMIN') ?? staffVenues[0]
  const owner = ownerVenue?.staff

  const email = venue.email || owner?.email || venue.organization?.email || null
  const ownerName = owner ? `${owner.firstName ?? ''} ${owner.lastName ?? ''}`.trim() || null : null
  const locale = venue.language === 'en' ? 'en' : 'es'

  return { email, locale, venueName: venue.name, ownerName }
}
