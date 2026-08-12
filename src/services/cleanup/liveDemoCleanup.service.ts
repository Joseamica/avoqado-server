/**
 * Live Demo Cleanup Service
 *
 * Automatically cleans up expired live demo sessions.
 * Deletes venues, staff, and all associated data for sessions that have:
 * 1. Expired (expiresAt < now)
 * 2. Been inactive for > 5 hours (lastActivityAt + 5 hours < now)
 */

import prisma from '@/utils/prismaClient'
import { addHours } from 'date-fns'
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'
import { deleteOrRetainStaffWithH1ProvenanceTx, isH1ProvenanceConstraint } from '@/services/superadmin/staffDeletion.service'

const INACTIVITY_THRESHOLD_HOURS = 5

type DbClient = Prisma.TransactionClient

interface DisposableDemoSession {
  id: string
  venueId: string
  staffId: string
}

export function createDisposableDemoSessionDeletion(
  overrides: { prisma?: typeof prisma; afterVenueLock?: (venueId: string) => Promise<void> } = {},
) {
  const db = overrides.prisma ?? prisma
  return async (session: DisposableDemoSession): Promise<void> => {
    try {
      await db.$transaction(async tx => {
        // WHY: Venue disposition, Staff provenance classification, and every
        // destructive write share one transaction. The row lock makes a
        // concurrent LIVE_DEMO -> real venue transition wait until cleanup has
        // atomically committed or rolled back.
        const venues = await tx.$queryRaw<Array<{ id: string; name: string; status: string }>>(Prisma.sql`
        SELECT id, name, status FROM "Venue" WHERE id = ${session.venueId} FOR UPDATE
      `)
        const venue = venues[0]
        if (!venue || venue.status !== 'LIVE_DEMO') {
          throw new ConflictError('La sucursal ya no es un demo desechable', 'LIVE_DEMO_VENUE_NOT_DISPOSABLE')
        }
        await overrides.afterVenueLock?.(session.venueId)
        const result = await deleteOrRetainStaffWithH1ProvenanceTx(tx, session.staffId)
        if (result.retainedForAudit) {
          throw new ConflictError(
            'El Staff del demo conserva provenance H1 y requiere revisión manual',
            'LIVE_DEMO_STAFF_HAS_H1_PROVENANCE',
          )
        }
        await deleteVenueDataTx(tx, session.venueId)
        // Venue deletion cascades the session, so this remains idempotent.
        await tx.liveDemoSession.deleteMany({ where: { id: session.id } })
      })
    } catch (error) {
      if (isH1ProvenanceConstraint(error) || (error as { code?: string }).code === 'STAFF_HAS_H1_PROVENANCE') {
        throw new ConflictError('El Staff del demo conserva provenance H1 y requiere revisión manual', 'LIVE_DEMO_STAFF_HAS_H1_PROVENANCE')
      }
      throw error
    }
  }
}

export const deleteDisposableDemoSession = createDisposableDemoSessionDeletion()

/**
 * Cleans up expired and inactive live demo sessions
 * Should be run periodically (e.g., every hour via cron)
 *
 * @returns Number of sessions cleaned up
 */
export async function cleanupExpiredLiveDemos(): Promise<number> {
  try {
    logger.info('🧹 Starting live demo cleanup...')

    const now = new Date()
    const inactivityThreshold = addHours(now, -INACTIVITY_THRESHOLD_HOURS)

    // Find expired or inactive sessions
    const expiredSessions = await prisma.liveDemoSession.findMany({
      where: {
        OR: [
          {
            // Session has expired
            expiresAt: {
              lt: now,
            },
          },
          {
            // Session has been inactive for too long
            lastActivityAt: {
              lt: inactivityThreshold,
            },
          },
        ],
      },
      include: {
        venue: true,
        staff: true,
      },
    })

    if (expiredSessions.length === 0) {
      logger.info('✅ No expired live demo sessions found')
      return 0
    }

    logger.info(`🗑️ Found ${expiredSessions.length} expired live demo sessions to clean up`)

    let cleanedCount = 0

    for (const session of expiredSessions) {
      try {
        // Delete venue and staff data manually to avoid foreign key constraint errors
        logger.info(`🗑️ Cleaning up venue: ${session.venue.name} (${session.venue.id})`)

        // Staff deletion performs the row-lock + provenance decision before
        // any venue data is removed, so cleanup fails closed without partial loss.
        await deleteDisposableDemoSession(session)

        logger.info(`✅ Cleaned up live demo session ${session.sessionId} (venue: ${session.venue.name}, staff: ${session.staff.email})`)

        cleanedCount++
      } catch (error) {
        logger.error(`❌ Error cleaning up session ${session.sessionId}:`, error)
        // Continue with other sessions even if one fails
      }
    }

    logger.info(`✅ Live demo cleanup complete. Cleaned ${cleanedCount} sessions.`)

    return cleanedCount
  } catch (error) {
    logger.error('❌ Error in cleanupExpiredLiveDemos:', error)
    throw error
  }
}

/**
 * Cleans up ALL live demo sessions (for testing/development)
 * WARNING: This will delete all live demo venues and sessions
 *
 * @returns Number of sessions cleaned up
 */
export async function cleanupAllLiveDemos(): Promise<number> {
  try {
    logger.warn('⚠️ Cleaning up ALL live demo sessions (including active ones)...')

    const allSessions = await prisma.liveDemoSession.findMany({
      include: {
        venue: true,
        staff: true,
      },
    })

    if (allSessions.length === 0) {
      logger.info('✅ No live demo sessions found')
      return 0
    }

    logger.info(`🗑️ Found ${allSessions.length} live demo sessions to clean up`)

    let cleanedCount = 0

    for (const session of allSessions) {
      try {
        // Delete venue and staff data manually to avoid foreign key constraint errors
        logger.info(`🗑️ Cleaning up venue: ${session.venue.name} (${session.venue.id})`)

        await deleteDisposableDemoSession(session)

        logger.info(`✅ Cleaned up session ${session.sessionId}`)
        cleanedCount++
      } catch (error) {
        logger.error(`❌ Error cleaning up session ${session.sessionId}:`, error)
      }
    }

    logger.info(`✅ Cleanup complete. Cleaned ${cleanedCount} sessions.`)

    return cleanedCount
  } catch (error) {
    logger.error('❌ Error in cleanupAllLiveDemos:', error)
    throw error
  }
}

/**
 * Get statistics about live demo sessions
 *
 * @returns Live demo statistics
 */
export async function getLiveDemoStats(): Promise<{
  total: number
  active: number
  expired: number
  inactive: number
}> {
  const now = new Date()
  const inactivityThreshold = addHours(now, -INACTIVITY_THRESHOLD_HOURS)

  const total = await prisma.liveDemoSession.count()

  const active = await prisma.liveDemoSession.count({
    where: {
      expiresAt: { gte: now },
      lastActivityAt: { gte: inactivityThreshold },
    },
  })

  const expired = await prisma.liveDemoSession.count({
    where: {
      expiresAt: { lt: now },
    },
  })

  const inactive = await prisma.liveDemoSession.count({
    where: {
      lastActivityAt: { lt: inactivityThreshold },
      expiresAt: { gte: now }, // Not yet expired, just inactive
    },
  })

  return {
    total,
    active,
    expired,
    inactive,
  }
}

/**
 * Deletes all venue-related data in the correct order to avoid foreign key constraints
 *
 * @param venueId - Venue ID to delete data for
 */
async function deleteVenueDataTx(tx: DbClient, venueId: string): Promise<void> {
  // 🔒 HARD GUARD — this function ERASES a venue and everything in it.
  // It must be physically impossible to point it at a real business: if a
  // LiveDemoSession row ever references a non-LIVE_DEMO venue (bug, manual
  // data edit, tampering), we refuse loudly instead of destroying it.
  const venue = await tx.venue.findUnique({
    where: { id: venueId },
    select: { status: true, name: true },
  })
  if (!venue) {
    logger.warn(`🗑️ deleteVenueData: venue ${venueId} no longer exists — nothing to delete`)
    return
  }
  if (venue.status !== 'LIVE_DEMO') {
    logger.error(
      `🚨 deleteVenueData REFUSED: venue ${venueId} ("${venue.name}") has status ${venue.status}, not LIVE_DEMO. ` +
        `A live-demo session is pointing at a REAL venue — investigate immediately.`,
    )
    throw new Error(`Refusing to delete non-LIVE_DEMO venue ${venueId} (status: ${venue.status})`)
  }

  logger.info(`🗑️ Deleting all data for venue ${venueId}...`)

  // Delete in correct order (most dependent first)
  // 1. Order items and payments
  await tx.orderItem.deleteMany({ where: { order: { venueId } } })
  await tx.payment.deleteMany({ where: { order: { venueId } } })
  await tx.order.deleteMany({ where: { venueId } })

  // 2. Reviews
  await tx.review.deleteMany({ where: { venueId } })

  // 3. Products and modifiers
  await tx.productModifierGroup.deleteMany({ where: { product: { venueId } } })
  await tx.modifier.deleteMany({ where: { group: { venueId } } })
  await tx.modifierGroup.deleteMany({ where: { venueId } })

  // 4. Recipes and inventory
  await tx.recipe.deleteMany({ where: { product: { venueId } } })
  await tx.rawMaterialMovement.deleteMany({ where: { rawMaterial: { venueId } } })
  await tx.rawMaterial.deleteMany({ where: { venueId } })
  await tx.inventory.deleteMany({ where: { venueId } })

  // 5. Products
  await tx.product.deleteMany({ where: { venueId } })

  // 6. Menu categories and menus
  await tx.menuCategoryAssignment.deleteMany({ where: { menu: { venueId } } })
  await tx.menuCategory.deleteMany({ where: { venueId } })
  await tx.menu.deleteMany({ where: { venueId } })

  // 7. Tables and areas
  await tx.table.deleteMany({ where: { venueId } })
  await tx.area.deleteMany({ where: { venueId } })

  // 8. Shifts and staff assignments
  await tx.shift.deleteMany({ where: { venueId } })
  await tx.staffVenue.deleteMany({ where: { venueId } })

  // 9. Payment config + the merchant accounts it points to.
  // MerchantAccount has NO venueId and its FK from VenuePaymentConfig is
  // onDelete: Restrict (schema.prisma) — it does NOT cascade. The Stripe/Blumon
  // demo accounts seedDemoVenue created just for this venue would otherwise
  // orphan forever in the global MerchantAccount table (found accumulating in
  // prod's superadmin "Cuentas de Comercio" screen, 2026-07-06).
  const paymentConfig = await tx.venuePaymentConfig.findUnique({ where: { venueId } })
  await tx.venuePaymentConfig.deleteMany({ where: { venueId } })
  if (paymentConfig) {
    const merchantAccountIds = [paymentConfig.primaryAccountId, paymentConfig.secondaryAccountId, paymentConfig.tertiaryAccountId].filter(
      (id): id is string => Boolean(id),
    )
    if (merchantAccountIds.length > 0) {
      await tx.merchantAccount.deleteMany({ where: { id: { in: merchantAccountIds } } })
    }
  }

  // 10. Features and settings
  await tx.venueFeature.deleteMany({ where: { venueId } })
  await tx.venueSettings.deleteMany({ where: { venueId } })

  // 11. Webhook events
  await tx.webhookEvent.deleteMany({ where: { venueId } })

  // 12. Finally, delete the venue
  await tx.venue.delete({ where: { id: venueId } })

  logger.info(`✅ Successfully deleted all data for venue ${venueId}`)
}
