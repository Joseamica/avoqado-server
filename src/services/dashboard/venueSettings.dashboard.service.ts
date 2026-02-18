// src/services/dashboard/venueSettings.dashboard.service.ts

/**
 * VenueSettings Dashboard Service
 *
 * Manages venue configuration settings including TPV screen toggles,
 * inventory settings, payment options, and operational preferences.
 *
 * Pattern: HTTP-agnostic service layer (see venue.dashboard.service.ts)
 */

import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import logger from '../../config/logger'
import { VenueSettings, Prisma } from '@prisma/client'

/**
 * Default settings for new venues
 * Used when VenueSettings record doesn't exist yet
 *
 * NOTE: TPV Settings (showReviewScreen, showTipScreen, etc.) have been moved
 * to per-terminal configuration in Terminal.config.settings (2025-11-29)
 */
export const DEFAULT_VENUE_SETTINGS = {
  // Operations
  autoCloseShifts: false,
  shiftDuration: 8,
  enableShifts: true, // Enable/disable shift system for venue
  requirePinLogin: true,

  // Attendance — lateness detection
  expectedCheckInTime: '09:00', // "HH:mm" — expected check-in time
  latenessThresholdMinutes: 30, // Minutes of tolerance after expectedCheckInTime
  geofenceRadiusMeters: 500, // Max distance (meters) from venue for valid clock-in

  // Auto Clock-Out (HR automation - Square-style)
  autoClockOutEnabled: false, // Enable automatic clock-out at fixed time
  autoClockOutTime: null as string | null, // "HH:mm" format - e.g., "03:00" for 3 AM
  maxShiftDurationEnabled: false, // Enable max shift duration enforcement
  maxShiftDurationHours: 12, // Max hours before auto clock-out

  // Reviews
  autoReplyReviews: false,
  notifyBadReviews: true,
  badReviewThreshold: 3,
  badReviewAlertRoles: ['OWNER', 'ADMIN', 'MANAGER'],

  // Inventory
  trackInventory: false,
  lowStockAlert: true,
  lowStockThreshold: 10,
  costingMethod: 'FIFO' as const,

  // Customer features
  allowReservations: false,
  allowTakeout: false,
  allowDelivery: false,

  // Payment
  acceptCash: true,
  acceptCard: true,
  acceptDigitalWallet: true,
  tipSuggestions: [15, 18, 20, 25],
  paymentTiming: 'PAY_AFTER' as const,
  inventoryDeduction: 'ON_ORDER_CREATE' as const,
}

/**
 * Get venue settings by venue ID
 * Creates default settings if they don't exist
 *
 * @param venueId - Venue ID
 * @returns VenueSettings object
 */
export async function getVenueSettings(venueId: string): Promise<VenueSettings> {
  // Verify venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Try to get existing settings
  let settings = await prisma.venueSettings.findUnique({
    where: { venueId },
  })

  // Create default settings if they don't exist
  if (!settings) {
    logger.info(`Creating default VenueSettings for venue: ${venueId}`)
    settings = await prisma.venueSettings.create({
      data: {
        venueId,
        ...DEFAULT_VENUE_SETTINGS,
      },
    })
  }

  return settings
}

/**
 * Update venue settings
 * Only updates fields that are provided
 *
 * @param venueId - Venue ID
 * @param updates - Partial settings to update
 * @returns Updated VenueSettings object
 */
export async function updateVenueSettings(venueId: string, updates: Prisma.VenueSettingsUpdateInput): Promise<VenueSettings> {
  // Verify venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Prepare create data with defaults
  const createData: Prisma.VenueSettingsUncheckedCreateInput = {
    venueId,
    autoCloseShifts: DEFAULT_VENUE_SETTINGS.autoCloseShifts,
    shiftDuration: DEFAULT_VENUE_SETTINGS.shiftDuration,
    enableShifts: DEFAULT_VENUE_SETTINGS.enableShifts,
    requirePinLogin: DEFAULT_VENUE_SETTINGS.requirePinLogin,
    // Attendance — lateness detection
    expectedCheckInTime: DEFAULT_VENUE_SETTINGS.expectedCheckInTime,
    latenessThresholdMinutes: DEFAULT_VENUE_SETTINGS.latenessThresholdMinutes,
    // Auto Clock-Out
    autoClockOutEnabled: DEFAULT_VENUE_SETTINGS.autoClockOutEnabled,
    autoClockOutTime: DEFAULT_VENUE_SETTINGS.autoClockOutTime,
    maxShiftDurationEnabled: DEFAULT_VENUE_SETTINGS.maxShiftDurationEnabled,
    maxShiftDurationHours: DEFAULT_VENUE_SETTINGS.maxShiftDurationHours,
    autoReplyReviews: DEFAULT_VENUE_SETTINGS.autoReplyReviews,
    notifyBadReviews: DEFAULT_VENUE_SETTINGS.notifyBadReviews,
    badReviewThreshold: DEFAULT_VENUE_SETTINGS.badReviewThreshold,
    badReviewAlertRoles: [...DEFAULT_VENUE_SETTINGS.badReviewAlertRoles],
    trackInventory: DEFAULT_VENUE_SETTINGS.trackInventory,
    lowStockAlert: DEFAULT_VENUE_SETTINGS.lowStockAlert,
    lowStockThreshold: DEFAULT_VENUE_SETTINGS.lowStockThreshold,
    costingMethod: DEFAULT_VENUE_SETTINGS.costingMethod,
    allowReservations: DEFAULT_VENUE_SETTINGS.allowReservations,
    allowTakeout: DEFAULT_VENUE_SETTINGS.allowTakeout,
    allowDelivery: DEFAULT_VENUE_SETTINGS.allowDelivery,
    acceptCash: DEFAULT_VENUE_SETTINGS.acceptCash,
    acceptCard: DEFAULT_VENUE_SETTINGS.acceptCard,
    acceptDigitalWallet: DEFAULT_VENUE_SETTINGS.acceptDigitalWallet,
    tipSuggestions: DEFAULT_VENUE_SETTINGS.tipSuggestions,
    paymentTiming: DEFAULT_VENUE_SETTINGS.paymentTiming,
    inventoryDeduction: DEFAULT_VENUE_SETTINGS.inventoryDeduction,
    // TPV Settings removed - now stored per-terminal in Terminal.config.settings
  }

  // Upsert settings (create if not exists, update if exists)
  const settings = await prisma.venueSettings.upsert({
    where: { venueId },
    create: createData,
    update: updates,
  })

  logger.info(`Updated VenueSettings for venue: ${venueId}`, {
    updatedFields: Object.keys(updates),
  })

  return settings
}

// TPV Settings functions removed (2025-11-29)
// TPV settings are now stored per-terminal in Terminal.config.settings
// Use tpv.dashboard.service.ts: getTpvSettings(tpvId) and updateTpvSettings(tpvId, updates)
