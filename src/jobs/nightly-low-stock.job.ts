/**
 * Nightly Low Stock Digest Email Job
 *
 * Daily cron job that scans all raw materials below reorderPoint
 * and sends ONE consolidated email per venue to managers/admins/owners.
 * Similar to Square's "Alertas de bajas existencias" digest.
 *
 * Runs at 10:33 PM Mexico City time (offset from other cron jobs to avoid Resend rate limits).
 */

import { CronJob } from 'cron'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import emailService from '../services/email.service'
import socketManager from '../communication/sockets'
import { NotificationChannel, NotificationPriority, NotificationType, Prisma, StaffRole, VenueStatus } from '@prisma/client'
import { FRONTEND_URL } from '../config/env'

// ============================================================
// Types
// ============================================================

export interface LowStockItem {
  id: string
  name: string
  category: string | null
  currentStock: number
  reorderPoint: number
  unit: string
  isOutOfStock: boolean
}

interface JobResult {
  venuesProcessed: number
  emailsSent: number
  inAppNotificationsCreated: number
  itemsDetected: number
  errors: number
}

// ============================================================
// Job Class
// ============================================================

export class NightlyLowStockJob {
  private job: CronJob | null = null
  private isRunning: boolean = false

  constructor() {
    // Run daily at 10:33 PM Mexico City time (offset from */5 cron jobs to avoid Resend rate limits)
    this.job = new CronJob(
      '33 22 * * *',
      async () => {
        await this.sendLowStockDigests()
      },
      null,
      false,
      'America/Mexico_City',
    )
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('Nightly Low Stock Digest Job started - daily at 10:33 PM Mexico City')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Nightly Low Stock Digest Job stopped')
    }
  }

  /**
   * Run manually (for testing or ad-hoc execution)
   */
  async runNow(venueId?: string): Promise<JobResult> {
    return this.sendLowStockDigests(venueId)
  }

  /**
   * Main logic - scan all venues for low stock and send digest emails
   */
  private async sendLowStockDigests(specificVenueId?: string): Promise<JobResult> {
    if (this.isRunning) {
      logger.warn('Nightly low stock digest already in progress, skipping')
      return { venuesProcessed: 0, emailsSent: 0, inAppNotificationsCreated: 0, itemsDetected: 0, errors: 0 }
    }

    this.isRunning = true
    const startTime = Date.now()
    let venuesProcessed = 0
    let emailsSent = 0
    let inAppNotificationsCreated = 0
    let totalItemsDetected = 0
    let errors = 0

    try {
      logger.info('Starting nightly low stock digest job...')

      // Get all active venues
      const venues = await prisma.venue.findMany({
        where: {
          ...(specificVenueId ? { id: specificVenueId } : {}),
          status: {
            in: [VenueStatus.ACTIVE, VenueStatus.TRIAL, VenueStatus.LIVE_DEMO],
          },
        },
        select: {
          id: true,
          name: true,
          slug: true,
          staff: {
            where: {
              active: true,
              role: {
                in: [StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER],
              },
            },
            select: {
              staff: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
        },
      })

      logger.info(`Found ${venues.length} active venues to scan for low stock`)

      for (const venue of venues) {
        try {
          // Find raw materials below reorder point with notifications enabled
          const lowStockItems = await prisma.$queryRaw<
            Array<{
              id: string
              name: string
              category: string | null
              currentStock: number
              reorderPoint: number
              unit: string
            }>
          >`
            SELECT
              rm.id,
              rm.name,
              rm.category,
              rm."currentStock"::float as "currentStock",
              rm."reorderPoint"::float as "reorderPoint",
              rm.unit
            FROM "RawMaterial" rm
            WHERE rm."venueId" = ${venue.id}
              AND rm."deletedAt" IS NULL
              AND rm."notifyOnLowStock" = true
              AND rm."currentStock" <= rm."reorderPoint"
            ORDER BY
              CASE WHEN rm."currentStock" = 0 THEN 0 ELSE 1 END,
              (rm."currentStock" / NULLIF(rm."reorderPoint", 0)) ASC
          `

          if (lowStockItems.length === 0) continue

          totalItemsDetected += lowStockItems.length

          // Check which items were already notified in the last 24 hours
          const recentAlerts = await prisma.lowStockAlert.findMany({
            where: {
              venueId: venue.id,
              status: 'ACTIVE',
              lastNotifiedAt: {
                gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
              },
            },
            select: { rawMaterialId: true },
          })
          const recentlyNotifiedIds = new Set(recentAlerts.map(a => a.rawMaterialId))

          // Filter to only items not notified in the last 24h
          const itemsToNotify = lowStockItems.filter(item => !recentlyNotifiedIds.has(item.id))

          if (itemsToNotify.length === 0) {
            logger.debug(`All low stock items already notified for ${venue.name}, skipping`)
            continue
          }

          // Get recipients who have LOW_INVENTORY + EMAIL enabled
          const optedOutStaff = await prisma.notificationPreference.findMany({
            where: {
              venueId: venue.id,
              type: NotificationType.LOW_INVENTORY,
              OR: [{ enabled: false }, { channels: { equals: [] } }],
            },
            select: { staffId: true },
          })
          const optedOutIds = new Set(optedOutStaff.map(p => p.staffId))

          // Also check staff who have LOW_INVENTORY enabled but without EMAIL channel
          const noEmailStaff = await prisma.notificationPreference.findMany({
            where: {
              venueId: venue.id,
              type: NotificationType.LOW_INVENTORY,
              enabled: true,
              NOT: { channels: { has: NotificationChannel.EMAIL } },
            },
            select: { staffId: true },
          })
          const noEmailIds = new Set(noEmailStaff.map(p => p.staffId))

          // Staff who have LOW_INVENTORY enabled but explicitly opted out of IN_APP channel
          const noInAppStaff = await prisma.notificationPreference.findMany({
            where: {
              venueId: venue.id,
              type: NotificationType.LOW_INVENTORY,
              enabled: true,
              NOT: { channels: { has: NotificationChannel.IN_APP } },
            },
            select: { staffId: true },
          })
          const noInAppIds = new Set(noInAppStaff.map(p => p.staffId))

          const emailRecipients = venue.staff
            .filter(sv => !optedOutIds.has(sv.staff.id) && !noEmailIds.has(sv.staff.id))
            .map(sv => sv.staff)
            .filter(s => s.email)

          const inAppRecipients = venue.staff
            .filter(sv => !optedOutIds.has(sv.staff.id) && !noInAppIds.has(sv.staff.id))
            .map(sv => sv.staff)

          if (emailRecipients.length === 0 && inAppRecipients.length === 0) {
            logger.debug(`No recipients (email or in-app) for low stock digest in ${venue.name}`)
            continue
          }

          // Prepare items for email & in-app payload
          const emailItems: LowStockItem[] = itemsToNotify.map(item => ({
            id: item.id,
            name: item.name,
            category: item.category,
            currentStock: item.currentStock,
            reorderPoint: item.reorderPoint,
            unit: item.unit,
            isOutOfStock: item.currentStock === 0,
          }))

          const dashboardUrl = `${FRONTEND_URL}/venues/${venue.slug}/inventory/raw-materials`

          // Send email to each recipient (with 500ms delay to respect Resend's 2/sec rate limit)
          for (const recipient of emailRecipients) {
            try {
              const sent = await emailService.sendLowStockDigestEmail(recipient.email, {
                venueName: venue.name,
                items: emailItems,
                dashboardUrl,
                preferencesUrl: `${FRONTEND_URL}/venues/${venue.slug}/notifications/preferences`,
              })

              if (sent) {
                emailsSent++
                logger.debug(`Low stock digest sent to ${recipient.email} for ${venue.name}`)
              }

              // Rate limit: 500ms between emails (same as marketing job)
              await new Promise(resolve => setTimeout(resolve, 500))
            } catch (emailError) {
              errors++
              logger.error(`Failed to send low stock digest to ${recipient.email}`, {
                error: emailError,
                venueId: venue.id,
              })
            }
          }

          // Create in-app (bell) notifications — one consolidated row per recipient
          if (inAppRecipients.length > 0) {
            const outOfStockCount = emailItems.filter(i => i.isOutOfStock).length
            const lowStockCount = emailItems.length - outOfStockCount
            const previewItems = emailItems
              .slice(0, 3)
              .map(i => i.name)
              .join(', ')
            const remainder = emailItems.length > 3 ? ` y ${emailItems.length - 3} más` : ''
            const title =
              outOfStockCount > 0
                ? lowStockCount > 0
                  ? `⚠️ ${outOfStockCount} sin stock, ${lowStockCount} bajo`
                  : `⚠️ ${outOfStockCount} producto${outOfStockCount === 1 ? '' : 's'} sin stock`
                : `📉 ${lowStockCount} producto${lowStockCount === 1 ? '' : 's'} con stock bajo`
            const message = `${previewItems}${remainder}`
            const priority = outOfStockCount > 0 ? NotificationPriority.URGENT : NotificationPriority.HIGH

            const broadcastingService = socketManager.getBroadcastingService()
            for (const recipient of inAppRecipients) {
              try {
                const notification = await prisma.notification.create({
                  data: {
                    recipientId: recipient.id,
                    venueId: venue.id,
                    type: NotificationType.LOW_INVENTORY,
                    title,
                    message,
                    actionUrl: `/venues/${venue.slug}/inventory/raw-materials`,
                    actionLabel: 'Ver inventario',
                    entityType: 'LowStockDigest',
                    metadata: {
                      venueName: venue.name,
                      itemCount: emailItems.length,
                      outOfStockCount,
                      lowStockCount,
                      items: emailItems as unknown as Prisma.InputJsonValue,
                    },
                    priority,
                    channels: [NotificationChannel.IN_APP],
                    sentAt: new Date(),
                  },
                })
                inAppNotificationsCreated++

                // Realtime push so the bell updates immediately and the browser
                // (if it has permission) shows the native notification.
                if (broadcastingService) {
                  broadcastingService.broadcastNewNotification({
                    notificationId: notification.id,
                    recipientId: notification.recipientId,
                    venueId: notification.venueId || '',
                    userId: notification.recipientId,
                    type: notification.type,
                    title: notification.title,
                    message: notification.message,
                    priority: notification.priority as 'LOW' | 'NORMAL' | 'HIGH',
                    isRead: notification.isRead,
                    actionUrl: notification.actionUrl || undefined,
                    actionLabel: notification.actionLabel || undefined,
                    metadata: (notification.metadata as Record<string, any>) || undefined,
                  })
                }
              } catch (notificationError) {
                errors++
                logger.error(`Failed to create in-app low stock notification`, {
                  error: notificationError,
                  venueId: venue.id,
                  staffId: recipient.id,
                })
              }
            }
          }

          // Update lastNotifiedAt on alerts for notified items
          for (const item of itemsToNotify) {
            await prisma.lowStockAlert.updateMany({
              where: {
                venueId: venue.id,
                rawMaterialId: item.id,
                status: 'ACTIVE',
              },
              data: { lastNotifiedAt: new Date() },
            })

            // Create alert if it doesn't exist yet
            const existingAlert = await prisma.lowStockAlert.findFirst({
              where: {
                venueId: venue.id,
                rawMaterialId: item.id,
                status: 'ACTIVE',
              },
            })

            if (!existingAlert) {
              await prisma.lowStockAlert.create({
                data: {
                  venueId: venue.id,
                  rawMaterialId: item.id,
                  alertType: item.currentStock === 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK',
                  threshold: item.reorderPoint,
                  currentLevel: item.currentStock,
                  lastNotifiedAt: new Date(),
                },
              })
            }
          }

          venuesProcessed++
        } catch (venueError) {
          errors++
          logger.error(`Failed to process low stock for venue ${venue.name}`, {
            error: venueError,
            venueId: venue.id,
          })
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2)

      logger.info('Nightly low stock digest job completed', {
        venuesProcessed,
        emailsSent,
        inAppNotificationsCreated,
        itemsDetected: totalItemsDetected,
        errors,
        durationSeconds: duration,
      })

      return { venuesProcessed, emailsSent, inAppNotificationsCreated, itemsDetected: totalItemsDetected, errors }
    } catch (error) {
      logger.error('Nightly low stock digest job failed', {
        error,
        durationSeconds: ((Date.now() - startTime) / 1000).toFixed(2),
      })
      throw error
    } finally {
      this.isRunning = false
    }
  }

  isJobRunning(): boolean {
    return this.isRunning
  }

  getNextRun(): Date | null {
    if (this.job) {
      return this.job.nextDate()?.toJSDate() ?? null
    }
    return null
  }
}

export const nightlyLowStockJob = new NightlyLowStockJob()
