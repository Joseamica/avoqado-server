import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { NotFoundError } from '@/errors/AppError'
import { logAction } from './activity-log.service'
import { resolveBrandFallbackColor } from './branding.shared'

/**
 * Default reservation branding. All toggles default to "show". `accentColor`
 * null = inherit Venue.primaryColor (resolved in mergeReservationBranding).
 * Mirrored in avoqado-web-dashboard reservationBranding.service.ts.
 */
export const DEFAULT_RESERVATION_BRANDING = {
  showLogo: true,
  accentColor: null as string | null,
  buttonShape: 'rounded' as 'rounded' | 'square' | 'pill',
  fontFamily: 'DM Sans',
  showHeroImage: true,
  showDescriptions: true,
  showDuration: true,
  showPrices: true,
}

export type ReservationBranding = typeof DEFAULT_RESERVATION_BRANDING

/**
 * Merge stored branding with defaults. `accentColor` resolves to a concrete
 * color: explicit stored value → venue primaryColor → legacy blue. Read-time
 * only; the resolved value is NEVER written back (see updateReservationBranding).
 */
export function mergeReservationBranding(raw: unknown, primaryColor?: string | null): ReservationBranding {
  const accentFallback = resolveBrandFallbackColor(primaryColor)
  const stored = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReservationBranding>
  return {
    showLogo: stored.showLogo ?? DEFAULT_RESERVATION_BRANDING.showLogo,
    accentColor: stored.accentColor ?? accentFallback,
    buttonShape: stored.buttonShape ?? DEFAULT_RESERVATION_BRANDING.buttonShape,
    fontFamily: stored.fontFamily ?? DEFAULT_RESERVATION_BRANDING.fontFamily,
    showHeroImage: stored.showHeroImage ?? DEFAULT_RESERVATION_BRANDING.showHeroImage,
    showDescriptions: stored.showDescriptions ?? DEFAULT_RESERVATION_BRANDING.showDescriptions,
    showDuration: stored.showDuration ?? DEFAULT_RESERVATION_BRANDING.showDuration,
    showPrices: stored.showPrices ?? DEFAULT_RESERVATION_BRANDING.showPrices,
  }
}

export async function getReservationBranding(venueId: string): Promise<ReservationBranding> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { reservationBranding: true, primaryColor: true },
  })
  if (!venue) throw new NotFoundError('Venue no encontrado')
  return mergeReservationBranding(venue.reservationBranding, venue.primaryColor)
}

export async function updateReservationBranding(
  venueId: string,
  data: Partial<ReservationBranding>,
  staffId: string,
): Promise<ReservationBranding> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { reservationBranding: true, primaryColor: true },
  })
  if (!venue) throw new NotFoundError('Venue no encontrado')

  // Merge WITHOUT primaryColor so the inherited accent is never frozen into
  // storage (keeps live inheritance). Persist accentColor as-is (may be null).
  const stored = (
    venue.reservationBranding && typeof venue.reservationBranding === 'object' ? venue.reservationBranding : {}
  ) as Partial<ReservationBranding>
  const next = {
    showLogo: data.showLogo ?? stored.showLogo ?? DEFAULT_RESERVATION_BRANDING.showLogo,
    accentColor: data.accentColor !== undefined ? data.accentColor : (stored.accentColor ?? null),
    buttonShape: data.buttonShape ?? stored.buttonShape ?? DEFAULT_RESERVATION_BRANDING.buttonShape,
    fontFamily: data.fontFamily ?? stored.fontFamily ?? DEFAULT_RESERVATION_BRANDING.fontFamily,
    showHeroImage: data.showHeroImage ?? stored.showHeroImage ?? DEFAULT_RESERVATION_BRANDING.showHeroImage,
    showDescriptions: data.showDescriptions ?? stored.showDescriptions ?? DEFAULT_RESERVATION_BRANDING.showDescriptions,
    showDuration: data.showDuration ?? stored.showDuration ?? DEFAULT_RESERVATION_BRANDING.showDuration,
    showPrices: data.showPrices ?? stored.showPrices ?? DEFAULT_RESERVATION_BRANDING.showPrices,
  }

  await prisma.venue.update({
    where: { id: venueId },
    data: { reservationBranding: next as unknown as Prisma.InputJsonValue },
  })

  logAction({
    venueId,
    staffId,
    action: 'RESERVATION_BRANDING_UPDATED',
    entity: 'Venue',
    entityId: venueId,
    data: { to: next },
  })

  // Return resolved (with inheritance) so the editor shows the effective color.
  return mergeReservationBranding(next, venue.primaryColor)
}
