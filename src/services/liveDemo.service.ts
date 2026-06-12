/**
 * Live Demo Service
 *
 * Manages public demo sessions for demo.dashboard.avoqado.io
 * Each browser session gets its own isolated demo venue with full features.
 * Sessions expire after 5 hours of inactivity.
 */

import { StaffRole, VenueStatus, OrgRole } from '@prisma/client'
import { addHours, addDays } from 'date-fns'
import { v4 as uuidv4 } from 'uuid'
import prisma from '@/utils/prismaClient'
import { generateSlug as slugify } from '@/utils/slugify'
import { seedDemoVenue } from './onboarding/demoSeed.service'
import { recordFastPayment } from './tpv/payment.tpv.service'
import { createReservation as createDashboardReservation } from './dashboard/reservation.dashboard.service'
import * as jwtService from '@/jwt.service'
import logger from '@/config/logger'
import { isLiveDemoVenue as isLiveDemoStatus } from '@/lib/venueStatus.constants'
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from '@/errors/AppError'

const LIVE_DEMO_DURATION_HOURS = 5
const LIVE_DEMO_ORG_NAME = 'Live Demo Organization'
const LIVE_DEMO_VENUE_PREFIX = 'live-demo'

/**
 * Recognizable marker for simulated demo payments (Avoqado Tour F2).
 * Stored in the existing Payment.referenceNumber field — NO schema changes.
 * Also used to count sim payments for the per-session cap.
 */
export const SIM_PAYMENT_REFERENCE_PREFIX = 'LIVE-DEMO-SIM'

/** Max simulated payments allowed per live-demo session (anti-abuse cap). */
export const MAX_SIM_PAYMENTS_PER_SESSION = 20

export interface LiveDemoSession {
  sessionId: string
  venueId: string
  staffId: string
  accessToken: string
  refreshToken: string
  expiresAt: Date
}

/**
 * Get or create a live demo session for a browser session ID
 * If session exists and is not expired, returns existing venue
 * Otherwise, creates a new demo venue with seeded data
 *
 * @param sessionId - Browser session cookie identifier
 * @returns Live demo session with tokens
 */
export async function getOrCreateLiveDemo(sessionId: string): Promise<LiveDemoSession> {
  try {
    logger.info(`🎭 Getting or creating live demo for session: ${sessionId}`)

    // Check if session already exists
    const existingSession = await prisma.liveDemoSession.findUnique({
      where: { sessionId },
      include: {
        venue: true,
        staff: true,
      },
    })

    // If session exists and hasn't expired, update activity and return
    if (existingSession && new Date() < existingSession.expiresAt) {
      logger.info(`✅ Found existing live demo session for ${sessionId}`)

      // Update activity timestamp
      await prisma.liveDemoSession.update({
        where: { id: existingSession.id },
        data: { lastActivityAt: new Date() },
      })

      // Generate fresh tokens
      const accessToken = jwtService.generateAccessToken(
        existingSession.staffId,
        existingSession.venue.organizationId,
        existingSession.venueId,
        StaffRole.OWNER,
      )

      const refreshToken = jwtService.generateRefreshToken(existingSession.staffId, existingSession.venue.organizationId)

      return {
        sessionId: existingSession.sessionId,
        venueId: existingSession.venueId,
        staffId: existingSession.staffId,
        accessToken,
        refreshToken,
        expiresAt: existingSession.expiresAt,
      }
    }

    // If session expired or doesn't exist, create new one
    if (existingSession) {
      logger.warn(`⏰ Live demo session expired for ${sessionId}`)
      logger.warn(`   Old venue: ${existingSession.venue.name} (${existingSession.venueId})`)
      logger.warn(`   Expired at: ${existingSession.expiresAt.toISOString()}`)

      // Try to delete old session, but don't fail if it errors
      // (cleanup script will handle stubborn sessions)
      try {
        logger.info(`🗑️ Attempting to delete expired session...`)
        await prisma.liveDemoSession.delete({
          where: { id: existingSession.id },
        })
        logger.info(`✅ Successfully deleted expired session`)
      } catch (deleteError) {
        logger.warn(`⚠️ Could not delete expired session (will be cleaned by cron job):`, deleteError)
        // Continue anyway - we'll create a new session with the same sessionId
        // This will cause a unique constraint error, so we need to handle it
        throw new Error('EXPIRED_SESSION_CLEANUP_FAILED')
      }
    }

    // Create new live demo session
    logger.info(`🆕 Creating new live demo session for ${sessionId}`)
    const session = await createLiveDemoSession(sessionId)

    return session
  } catch (error) {
    logger.error(`❌ Error in getOrCreateLiveDemo for session ${sessionId}:`, error)
    throw error
  }
}

/**
 * Creates a new live demo session with venue, staff, and seeded data
 *
 * @param sessionId - Browser session cookie identifier
 * @returns Created live demo session
 */
async function createLiveDemoSession(sessionId: string): Promise<LiveDemoSession> {
  // Get or create the shared Live Demo organization
  let organization = await prisma.organization.findFirst({
    where: { name: LIVE_DEMO_ORG_NAME },
  })

  if (!organization) {
    organization = await prisma.organization.create({
      data: {
        name: LIVE_DEMO_ORG_NAME,
        type: 'RESTAURANT',
        email: 'livedemo@avoqado.io',
        phone: '5512955555',
      },
    })
    logger.info(`🏢 Created Live Demo organization: ${organization.id}`)
  }

  // Generate unique slug for this demo venue
  const timestamp = Date.now()
  const baseSlug = `${LIVE_DEMO_VENUE_PREFIX}-${timestamp}`
  const slug = slugify(baseSlug)

  // Create demo venue
  const venue = await prisma.venue.create({
    data: {
      organizationId: organization.id,
      name: `Live Demo ${timestamp}`,
      slug,
      type: 'RESTAURANT',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      country: 'MX',

      // Mark as live demo using status (single source of truth)
      status: VenueStatus.LIVE_DEMO,
      liveDemoSessionId: sessionId,
      lastActivityAt: new Date(),

      // Active by default
      active: true,
      operationalSince: new Date(),

      // ✅ Auto-verify KYC for Live Demo
      kycStatus: 'VERIFIED',
      kycCompletedAt: new Date(),
    },
  })

  logger.info(`🏪 Created live demo venue: ${venue.id} (${venue.slug})`)

  // Create demo staff member
  const staff = await prisma.staff.create({
    data: {
      email: `demo-${timestamp}@livedemo.avoqado.io`,
      firstName: 'Demo',
      lastName: 'User',
      active: true,
      emailVerified: true,
      password: null, // No password for auto-login
    },
  })

  logger.info(`👤 Created live demo staff: ${staff.id}`)

  // Create StaffOrganization membership
  await prisma.staffOrganization.create({
    data: {
      staffId: staff.id,
      organizationId: organization.id,
      role: OrgRole.OWNER,
      isPrimary: true,
      isActive: true,
    },
  })

  // Assign staff to venue as OWNER
  await prisma.staffVenue.create({
    data: {
      staffId: staff.id,
      venueId: venue.id,
      role: StaffRole.OWNER,
      active: true,
    },
  })

  // Create venue settings
  await prisma.venueSettings.create({
    data: {
      venueId: venue.id,
      trackInventory: true,
      lowStockAlert: true,
      autoCloseShifts: false,
      requirePinLogin: false,
    },
  })

  // Seed demo data (menu, products, etc.)
  logger.info(`🌱 Seeding demo data for venue ${venue.id}`)
  await seedDemoVenue(venue.id)

  // Enable all features with no expiration
  await enableAllFeaturesForLiveDemo(venue.id)

  // Create live demo session record
  const expiresAt = addHours(new Date(), LIVE_DEMO_DURATION_HOURS)

  const liveDemoSession = await prisma.liveDemoSession.create({
    data: {
      sessionId,
      venueId: venue.id,
      staffId: staff.id,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      expiresAt,
    },
  })

  logger.info(`✅ Created live demo session: ${liveDemoSession.id}, expires at ${expiresAt.toISOString()}`)

  // Generate tokens
  const accessToken = jwtService.generateAccessToken(staff.id, organization.id, venue.id, StaffRole.OWNER)

  const refreshToken = jwtService.generateRefreshToken(staff.id, organization.id)

  return {
    sessionId: liveDemoSession.sessionId,
    venueId: venue.id,
    staffId: staff.id,
    accessToken,
    refreshToken,
    expiresAt,
  }
}

/**
 * Enables all features for a live demo venue with no expiration
 *
 * @param venueId - Venue ID to enable features for
 */
async function enableAllFeaturesForLiveDemo(venueId: string): Promise<void> {
  try {
    logger.info(`🎯 Enabling all features for live demo venue ${venueId}`)

    // Get all active features
    const features = await prisma.feature.findMany({
      where: { active: true },
    })

    logger.info(`📦 Found ${features.length} active features to enable`)

    // Create VenueFeature records for all features
    for (const feature of features) {
      await prisma.venueFeature.create({
        data: {
          venueId,
          featureId: feature.id,
          active: true,
          monthlyPrice: 0, // Free for live demo
          startDate: new Date(),
          endDate: addDays(new Date(), 365 * 10), // 10 years (effectively no expiration)
        },
      })

      logger.info(`  ✓ Enabled feature: ${feature.code}`)
    }

    logger.info(`✅ All features enabled for live demo venue ${venueId}`)
  } catch (error) {
    logger.error(`❌ Error enabling features for live demo venue ${venueId}:`, error)
    throw error
  }
}

/**
 * Updates the lastActivityAt timestamp for a live demo session
 * Called on each authenticated request to extend session lifetime
 *
 * @param sessionId - Browser session cookie identifier
 */
export async function updateLiveDemoActivity(sessionId: string): Promise<void> {
  try {
    await prisma.liveDemoSession.update({
      where: { sessionId },
      data: { lastActivityAt: new Date() },
    })
  } catch (error) {
    // Don't throw - activity tracking shouldn't break requests
    logger.warn(`⚠️ Failed to update live demo activity for session ${sessionId}:`, error)
  }
}

/**
 * Checks if a venue is a live demo venue
 *
 * @param venueId - Venue ID to check
 * @returns True if venue is a live demo (status = LIVE_DEMO)
 */
export async function isLiveDemoVenue(venueId: string): Promise<boolean> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { status: true },
  })

  return venue ? isLiveDemoStatus(venue.status) : false
}

export interface SimFastPaymentResult {
  paymentId: string
  amountCents: number
  tipCents: number
}

/**
 * Simulates a TPV fast payment inside the visitor's ephemeral LIVE_DEMO venue.
 * (Avoqado Tour F2 — the "wow moment": the public guided demo simulates a TPV
 * charge, then the demo dashboard POSTs here so a REAL payment appears in Ventas.)
 *
 * Reuses the exact TPV path (`recordFastPayment`) so ALL side-effects are
 * preserved — most importantly the Socket.IO PAYMENT_COMPLETED / ORDER_UPDATED
 * broadcasts that make the payment appear in the dashboard in realtime.
 *
 * Security:
 * - Auth = the live-demo session itself (cookie validated by the caller +
 *   re-validated here against the DB, including expiry).
 * - HARD venue check: writes are refused unless the session's venue status is
 *   LIVE_DEMO — a tampered/stale session can never write into a real venue.
 * - Cap: max MAX_SIM_PAYMENTS_PER_SESSION sim payments per demo venue
 *   (counted via the SIM_PAYMENT_REFERENCE_PREFIX marker).
 *
 * @param sessionId - liveDemoSessionId cookie value
 * @param amountCents - Payment base amount in cents (> 0)
 * @param tipCents - Tip in cents (>= 0)
 */
export async function simulateFastPayment(sessionId: string, amountCents: number, tipCents: number = 0): Promise<SimFastPaymentResult> {
  // 1. Validate the live-demo session (existence + expiry) — this IS the auth
  const session = await prisma.liveDemoSession.findUnique({
    where: { sessionId },
  })

  if (!session || new Date() >= session.expiresAt) {
    throw new UnauthorizedError('No demo session')
  }

  // 2. HARD verify the venue is a LIVE_DEMO venue — never write to a real venue
  const isDemo = await isLiveDemoVenue(session.venueId)
  if (!isDemo) {
    logger.error(`🚨 simulateFastPayment refused: venue ${session.venueId} is NOT a LIVE_DEMO venue (session ${sessionId})`)
    throw new ForbiddenError('Esta operación solo está disponible en venues de demo.')
  }

  // 3. Per-session cap — count only sim-marked payments (the seeded demo data
  //    also contains payments; those must not eat into the cap)
  const simPaymentCount = await prisma.payment.count({
    where: {
      venueId: session.venueId,
      referenceNumber: { startsWith: SIM_PAYMENT_REFERENCE_PREFIX },
    },
  })

  if (simPaymentCount >= MAX_SIM_PAYMENTS_PER_SESSION) {
    throw new TooManyRequestsError('Límite de pagos simulados alcanzado para esta sesión de demo.')
  }

  // 4. Record the payment EXACTLY like the TPV fast-payment path does.
  //    recordFastPayment creates the fast Order + Payment (method CARD,
  //    status COMPLETED) + VenueTransaction + allocation, and emits the
  //    Socket.IO PAYMENT_COMPLETED + ORDER_UPDATED events to the venue room.
  const referenceNumber = `${SIM_PAYMENT_REFERENCE_PREFIX}-${uuidv4()}`

  const payment = await recordFastPayment(
    session.venueId,
    {
      venueId: session.venueId,
      amount: amountCents,
      tip: tipCents,
      status: 'COMPLETED',
      method: 'CREDIT_CARD',
      source: 'TPV', // Shows up in Ventas exactly like a real TPV charge
      splitType: 'FULLPAYMENT',
      tpvId: 'LIVE_DEMO_SIM',
      staffId: session.staffId, // The demo venue's seeded OWNER staff
      paidProductsId: [],
      currency: 'MXN',
      isInternational: false,
      // Friendly fake card metadata so the Ventas row looks real
      cardBrand: 'VISA',
      last4: '4242',
      typeOfCard: 'CREDIT',
      // ⭐ Recognizable sim marker on an EXISTING field (no schema changes).
      // Unique per request so the referenceNumber idempotency check never
      // collapses two intentional sim payments into one.
      referenceNumber,
      idempotencyKey: uuidv4(),
    },
    session.staffId,
  )

  // Keep the demo session alive — the visitor is clearly active
  await updateLiveDemoActivity(sessionId)

  logger.info(`🎭 Simulated fast payment created for live demo`, {
    sessionId,
    venueId: session.venueId,
    paymentId: payment.id,
    amountCents,
    tipCents,
    referenceNumber,
  })

  return {
    paymentId: payment.id,
    amountCents,
    tipCents,
  }
}

/* ==========================================================================
 * Avoqado Tour — simulated reservation (journey "reserva")
 * ========================================================================== */

/** Marker prefix on internalNotes — identifies sim reservations (cap + audit). */
export const SIM_RESERVATION_NOTE_PREFIX = 'LIVE-DEMO-SIM'

/** Per-demo-session cap of simulated reservations. */
export const MAX_SIM_RESERVATIONS_PER_SESSION = 10

export interface SimReservationResult {
  reservationId: string
  confirmationCode: string
  startsAt: string
}

/**
 * Create a REAL reservation in the visitor's LIVE_DEMO venue so the demo-tour
 * journey can show it in the Reservations calendar ("tu reserva, en vivo").
 *
 * Mirrors simulateFastPayment's security model:
 * - Auth = the live-demo session cookie (re-validated here, incl. expiry).
 * - HARD venue check: refuses non-LIVE_DEMO venues.
 * - Cap: MAX_SIM_RESERVATIONS_PER_SESSION, counted via the internalNotes marker.
 *
 * Reuses the dashboard createReservation service (no moduleConfig → permissive
 * booking window + autoConfirm CONFIRMED), channel WEB — exactly what a booking
 * made from the venue's page looks like.
 */
export async function simulateReservation(sessionId: string): Promise<SimReservationResult> {
  const session = await prisma.liveDemoSession.findUnique({
    where: { sessionId },
  })

  if (!session || new Date() >= session.expiresAt) {
    throw new UnauthorizedError('No demo session')
  }

  const isDemo = await isLiveDemoVenue(session.venueId)
  if (!isDemo) {
    logger.error(`🚨 simulateReservation refused: venue ${session.venueId} is NOT a LIVE_DEMO venue (session ${sessionId})`)
    throw new ForbiddenError('Esta operación solo está disponible en venues de demo.')
  }

  const simCount = await prisma.reservation.count({
    where: {
      venueId: session.venueId,
      internalNotes: { startsWith: SIM_RESERVATION_NOTE_PREFIX },
    },
  })
  if (simCount >= MAX_SIM_RESERVATIONS_PER_SESSION) {
    throw new TooManyRequestsError('Límite de reservas simuladas alcanzado para esta sesión de demo.')
  }

  // Next half-hour boundary at least 1h away — lands today in the calendar's
  // day view for almost every visit (UTC instants; display uses venue TZ).
  const DURATION_MIN = 45
  const startsAt = new Date(Math.ceil((Date.now() + 60 * 60_000) / (30 * 60_000)) * 30 * 60_000)
  const endsAt = new Date(startsAt.getTime() + DURATION_MIN * 60_000)

  const reservation = await createDashboardReservation(session.venueId, {
    startsAt,
    endsAt,
    duration: DURATION_MIN,
    channel: 'WEB', // customer self-service — same as the real booking widget
    guestName: 'Sofía Ramírez',
    guestPhone: '5512345678',
    partySize: 1,
    specialRequests: 'Corte de cabello — reserva creada desde el demo interactivo de avoqado.io',
    internalNotes: `${SIM_RESERVATION_NOTE_PREFIX}-${uuidv4()}`,
  })

  await updateLiveDemoActivity(sessionId)

  logger.info(`🎭 Simulated reservation created for live demo`, {
    sessionId,
    venueId: session.venueId,
    reservationId: reservation.id,
    confirmationCode: reservation.confirmationCode,
    startsAt: startsAt.toISOString(),
  })

  return {
    reservationId: reservation.id,
    confirmationCode: reservation.confirmationCode,
    startsAt: startsAt.toISOString(),
  }
}
