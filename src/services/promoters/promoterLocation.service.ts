/**
 * Promoter Location Service
 * Append-only geolocation pings for field promoters selling without a fixed
 * store ("cambaceo"). Ingest one ping (hourly, from the TPV) and read a
 * promoter's day track (live pin + route) for the PROMOTERS_AUDIT dashboard.
 *
 * Dates are VENUE-LOCAL: the day range is built with venueStartOfDay/venueEndOfDay
 * (noon anchor) so it is independent of the Node host timezone (prod runs UTC).
 */
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '../../utils/prismaClient'
import { venueStartOfDay, venueEndOfDay, DEFAULT_TIMEZONE } from '../../utils/datetime'
import { ForbiddenError } from '../../errors/AppError'

export type PromoterLocationSourceInput = 'PERIODIC' | 'CLOCK_IN' | 'CLOCK_OUT'

export interface RecordPromoterPingInput {
  venueId: string
  staffId: string
  latitude: number
  longitude: number
  accuracy?: number | null
  capturedAt: Date
  source?: PromoterLocationSourceInput
}

export interface PromoterTrackPoint {
  lat: number
  lng: number
  accuracy: number | null
  capturedAt: Date
  source: string
}

export interface PromoterTrack {
  points: PromoterTrackPoint[]
  latest: PromoterTrackPoint | null
}

/**
 * Persist a single location ping. Returns the new row id.
 *
 * Backend-authoritative gate: refuses the write unless the venue has
 * `trackPromoterLocation` enabled — so a stale/rogue TPV cannot store pings for
 * a venue that never opted into tracking (the TPV also self-gates, this is
 * defense-in-depth).
 */
export async function recordPromoterPing(input: RecordPromoterPingInput): Promise<{ id: string }> {
  const settings = await prisma.venueSettings.findUnique({
    where: { venueId: input.venueId },
    select: { trackPromoterLocation: true },
  })
  if (!settings?.trackPromoterLocation) {
    throw new ForbiddenError('El seguimiento de ubicación no está habilitado para esta sucursal')
  }

  return prisma.promoterLocationPing.create({
    data: {
      venueId: input.venueId,
      staffId: input.staffId,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy: input.accuracy ?? null,
      capturedAt: input.capturedAt,
      source: input.source ?? 'PERIODIC',
    },
    select: { id: true },
  })
}

function toPoint(row: { latitude: any; longitude: any; accuracy: number | null; capturedAt: Date; source: string }): PromoterTrackPoint {
  const num = (v: any) => (v != null && typeof v.toNumber === 'function' ? v.toNumber() : Number(v))
  return {
    lat: num(row.latitude),
    lng: num(row.longitude),
    accuracy: row.accuracy ?? null,
    capturedAt: row.capturedAt,
    source: row.source,
  }
}

/**
 * Get a promoter's location track for one venue-local day: the ordered route
 * (`points`) plus the most recent position (`latest`, the live pin).
 */
export async function getPromoterTrack(params: {
  venueId: string
  promoterId: string
  date: string // YYYY-MM-DD (venue-local calendar day)
  timezone: string
}): Promise<PromoterTrack> {
  const { venueId, promoterId, date, timezone } = params
  // Noon anchor keeps the calendar day stable under any host timezone.
  const anchor = new Date(`${date}T12:00:00`)
  const gte = venueStartOfDay(timezone, anchor)
  const lte = venueEndOfDay(timezone, anchor)

  const rows = await prisma.promoterLocationPing.findMany({
    where: { venueId, staffId: promoterId, capturedAt: { gte, lte } },
    orderBy: { capturedAt: 'asc' },
  })

  const points = rows.map(toPoint)
  return { points, latest: points.length ? points[points.length - 1] : null }
}

/**
 * Dashboard entrypoint: resolve the venue's timezone (defaulting the date to the
 * venue-local "today" when omitted), then return the promoter's day track.
 */
export async function getPromoterTrackForVenue(params: {
  venueId: string
  promoterId: string
  date?: string // YYYY-MM-DD; defaults to venue-local today
}): Promise<PromoterTrack> {
  const venue = await prisma.venue.findUnique({ where: { id: params.venueId }, select: { timezone: true } })
  const timezone = venue?.timezone ?? DEFAULT_TIMEZONE
  const date = params.date ?? formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd')
  return getPromoterTrack({ venueId: params.venueId, promoterId: params.promoterId, date, timezone })
}
