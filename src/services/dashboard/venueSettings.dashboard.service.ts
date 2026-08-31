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
import { ForbiddenError, NotFoundError } from '../../errors/AppError'
import logger from '../../config/logger'
import { logAction } from './activity-log.service'
import { VenueSettings, Prisma } from '@prisma/client'
import { CASH_RECONCILIATION_FEATURE } from '../access/cashReconciliationAccess.service'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { withSerializableRetry } from '../../utils/serializableRetry'

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
  cashReconciliationEnabled: false, // PRO + explicit opt-in; no current venue is activated
  requirePinLogin: true,
  // Propiedad de mesa (PRO) — apagado por default: cualquier staff con permiso
  // puede tocar cualquier mesa (conducta histórica).
  enforceTableOwnership: false,

  // Attendance — lateness detection
  // null = no venue-level override → attendance logic falls back to
  // OrganizationAttendanceConfig, then to the system default ('09:00'/30/500).
  // We DON'T hardcode '09:00'/30/500 here anymore because the venue-level
  // TpvConfig form used to silently save these defaults on every save,
  // turning inherited NULL values into accidental overrides (prod bug).
  expectedCheckInTime: null as string | null, // "HH:mm" — explicit venue override
  latenessThresholdMinutes: null as number | null, // Minutes of tolerance after expectedCheckInTime
  geofenceRadiusMeters: null as number | null, // Max distance (meters) from venue for valid clock-in

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
export async function updateVenueSettings(
  venueId: string,
  updates: Prisma.VenueSettingsUpdateInput,
  actorStaffId?: string,
): Promise<VenueSettings> {
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
    cashReconciliationEnabled:
      typeof updates.cashReconciliationEnabled === 'boolean'
        ? updates.cashReconciliationEnabled
        : DEFAULT_VENUE_SETTINGS.cashReconciliationEnabled,
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
    allowTakeout: DEFAULT_VENUE_SETTINGS.allowTakeout,
    allowDelivery: DEFAULT_VENUE_SETTINGS.allowDelivery,
    acceptCash: DEFAULT_VENUE_SETTINGS.acceptCash,
    acceptCard: DEFAULT_VENUE_SETTINGS.acceptCard,
    acceptDigitalWallet: DEFAULT_VENUE_SETTINGS.acceptDigitalWallet,
    tipSuggestions: DEFAULT_VENUE_SETTINGS.tipSuggestions,
    paymentTiming: DEFAULT_VENUE_SETTINGS.paymentTiming,
    inventoryDeduction: DEFAULT_VENUE_SETTINGS.inventoryDeduction,
    googleReviewLink: (updates.googleReviewLink as string | null | undefined) ?? null,
    // TPV Settings removed - now stored per-terminal in Terminal.config.settings
    ...(typeof updates.promotionsPanelCashier === 'string' && { promotionsPanelCashier: updates.promotionsPanelCashier }),
    ...(typeof updates.promotionsPanelCustomer === 'string' && { promotionsPanelCustomer: updates.promotionsPanelCustomer }),
    // PIN de autorización de gerente. Un venue SIN fila de settings toma esta
    // rama: sin esta línea el switch se vería encendido en el dashboard y la
    // fila nacería en false — el POS nunca ofrecería el PIN.
    ...(typeof updates.managerPinOverrideEnabled === 'boolean' && { managerPinOverrideEnabled: updates.managerPinOverrideEnabled }),
    // Interruptor de asistencia. 53 de 68 venues locales NO tienen fila: sin estas dos
    // líneas el primer "apagar" de un negocio caía en esta rama, Postgres ponía true/10 y
    // el dashboard enseñaba el valor pedido, no el guardado (auditoría Codex fase 2, P2-1).
    ...(typeof updates.attendanceEnabled === 'boolean' && { attendanceEnabled: updates.attendanceEnabled }),
    ...(typeof updates.attendanceGraceMinutes === 'number' && { attendanceGraceMinutes: updates.attendanceGraceMinutes }),
    ...(typeof updates.attendanceLateAlertEnabled === 'boolean' && { attendanceLateAlertEnabled: updates.attendanceLateAlertEnabled }),
    ...(typeof updates.rotatingShiftsEnabled === 'boolean' && { rotatingShiftsEnabled: updates.rotatingShiftsEnabled }),
  }

  const hasCashReconciliationUpdate = Object.prototype.hasOwnProperty.call(updates, 'cashReconciliationEnabled')
  if (hasCashReconciliationUpdate) {
    const requestedValue = updates.cashReconciliationEnabled === true
    // Only the OFF -> ON direction needs a paid entitlement check. OFF must remain available after
    // downgrade, and lookup failures must surface as retryable rather than masquerading as a 403.
    if (requestedValue) {
      const entitled = await venueHasFeatureAccess(venueId, CASH_RECONCILIATION_FEATURE)
      if (!entitled) {
        throw new ForbiddenError('Cash reconciliation requires an eligible PRO plan or explicit grant.', 'CASH_RECONCILIATION_REQUIRES_PRO')
      }
    }

    // The read, mutation, and audit share a serializable transaction. Concurrent toggles either
    // observe the committed predecessor on retry or fail retryably; they cannot commit a stale
    // previousValue in the audit trail.
    return withSerializableRetry(async tx => {
      const previousSettings = await tx.venueSettings.findUnique({
        where: { venueId },
        select: { id: true, cashReconciliationEnabled: true },
      })

      const settings = await tx.venueSettings.upsert({
        where: { venueId },
        create: createData,
        update: updates,
      })

      await tx.activityLog.create({
        data: {
          staffId: actorStaffId ?? null,
          venueId,
          action: 'CASH_RECONCILIATION_SETTING_UPDATED',
          entity: 'VenueSettings',
          entityId: settings.id,
          data: {
            previousValue: previousSettings?.cashReconciliationEnabled ?? false,
            newValue: requestedValue,
          },
        },
      })

      return settings
    })
  }

  // Lo de antes, para que la bitácora diga "de X a Y" y no sólo "cambió". Un venue sin fila
  // no tiene "antes": queda `undefined` y así se registra.
  const previous = (await prisma.venueSettings.findUnique({ where: { venueId } })) as Record<string, unknown> | null

  // Upsert settings (create if not exists, update if exists)
  const settings = await prisma.venueSettings.upsert({
    where: { venueId },
    create: createData,
    update: updates,
  })

  const updatedFields = Object.keys(updates)
  logger.info(`Updated VenueSettings for venue: ${venueId}`, { updatedFields })

  // Con actor: apagar la asistencia de un negocio tiene que decir QUIÉN lo hizo (Codex P3-1).
  logAction({
    staffId: actorStaffId,
    venueId,
    action: 'SETTINGS_UPDATED',
    entity: 'VenueSettings',
    entityId: venueId,
    data: {
      updatedFields,
      changes: Object.fromEntries(
        updatedFields.map(k => [k, { from: previous?.[k], to: (updates as Record<string, unknown>)[k] }]),
      ) as unknown as Prisma.InputJsonValue,
    },
  })

  return settings
}

// TPV Settings functions removed (2025-11-29)
// TPV settings are now stored per-terminal in Terminal.config.settings
// Use tpv.dashboard.service.ts: getTpvSettings(tpvId) and updateTpvSettings(tpvId, updates)
