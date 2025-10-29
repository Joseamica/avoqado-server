/**
 * Live Demo Service
 *
 * Manages public demo sessions for demo.dashboard.avoqado.io
 * Each browser session gets its own isolated demo venue with full features.
 * Sessions expire after 5 hours of inactivity.
 */

import { StaffRole } from '@prisma/client'
import { addHours, addDays } from 'date-fns'
import prisma from '@/utils/prismaClient'
import { generateSlug as slugify } from '@/utils/slugify'
import { seedDemoVenue } from './onboarding/demoSeed.service'
import * as jwtService from '@/jwt.service'
import logger from '@/config/logger'

const LIVE_DEMO_DURATION_HOURS = 5
const LIVE_DEMO_ORG_NAME = 'Live Demo Organization'
const LIVE_DEMO_VENUE_PREFIX = 'live-demo'

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
      logger.info(`⏰ Live demo session expired for ${sessionId}, creating new one`)
      // Delete old session (cascade will clean up venue and staff)
      await prisma.liveDemoSession.delete({
        where: { id: existingSession.id },
      })
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

      // Mark as live demo
      isLiveDemo: true,
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
      organizationId: organization.id,
      active: true,
      emailVerified: true,
      password: null, // No password for auto-login
    },
  })

  logger.info(`👤 Created live demo staff: ${staff.id}`)

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
 * @returns True if venue is a live demo
 */
export async function isLiveDemoVenue(venueId: string): Promise<boolean> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { isLiveDemo: true },
  })

  return venue?.isLiveDemo || false
}
