/**
 * Nightly Sales Summary Email Job
 *
 * Daily cron job that sends sales summary emails to venue admins and owners.
 * Runs at 10:00 PM Mexico City time (after most venues close).
 *
 * What it does:
 * 1. Finds all active venues
 * 2. For each venue, calculates the day's sales metrics
 * 3. Gets all admins and owners for that venue
 * 4. Sends a formatted sales summary email (similar to Square's daily digest)
 *
 * Can also be triggered manually via runNow() for testing.
 */

import { CronJob } from 'cron'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { getSalesSummary, type SalesSummaryMetrics } from '../services/dashboard/sales-summary.dashboard.service'
import emailService from '../services/email.service'
import { StaffRole, VenueStatus } from '@prisma/client'

// ============================================================
// Types
// ============================================================

interface VenueSalesSummaryData {
  venueId: string
  venueName: string
  venueTimezone: string
  venueCurrency: string
  reportDate: Date
  businessHoursStart: string
  businessHoursEnd: string
  dashboardUrl: string
  metrics: SalesSummaryMetrics
  // Comparison with previous period
  previousPeriod?: {
    netSales: number
    avgOrder: number
    transactionCount: number
  }
  // Category breakdown
  categoryBreakdown: Array<{
    name: string
    itemsSold: number
    netSales: number
  }>
  // Order source breakdown
  orderSources: Array<{
    source: string
    orders: number
    netSales: number
    avgOrder: number
  }>
  // Customer metrics (if available)
  customers?: {
    total: number
    new: number
    returning: number
  }
}

interface JobResult {
  venuesProcessed: number
  emailsSent: number
  errors: number
}

// ============================================================
// Job Class
// ============================================================

export class NightlySalesSummaryJob {
  private job: CronJob | null = null
  private isRunning: boolean = false

  constructor() {
    // Run daily at 10:00 PM Mexico City time
    // This gives time for most venues to close their business day
    this.job = new CronJob(
      '0 22 * * *', // At 22:00 (10 PM) every day
      async () => {
        await this.sendSalesSummaries()
      },
      null,
      false, // Don't start automatically
      'America/Mexico_City',
    )
  }

  /**
   * Start the cron job
   */
  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('Nightly Sales Summary Job started - daily at 10:00 PM Mexico City')
    }
  }

  /**
   * Stop the cron job
   */
  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Nightly Sales Summary Job stopped')
    }
  }

  /**
   * Run manually (for testing or ad-hoc execution)
   * @param venueId Optional - if provided, only sends to this venue
   */
  async runNow(venueId?: string): Promise<JobResult> {
    return this.sendSalesSummaries(venueId)
  }

  /**
   * Main logic - send sales summaries to all active venues
   */
  private async sendSalesSummaries(specificVenueId?: string): Promise<JobResult> {
    // Prevent concurrent runs
    if (this.isRunning) {
      logger.warn('Nightly sales summary already in progress, skipping')
      return { venuesProcessed: 0, emailsSent: 0, errors: 0 }
    }

    this.isRunning = true
    const startTime = Date.now()
    let venuesProcessed = 0
    let emailsSent = 0
    let errors = 0

    try {
      logger.info('Starting nightly sales summary job...')

      // Get all active venues (or specific venue for testing)
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
          timezone: true,
          currency: true,
          email: true,
          staff: {
            where: {
              active: true,
              role: {
                in: [StaffRole.OWNER, StaffRole.ADMIN],
              },
            },
            select: {
              role: true,
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

      logger.info(`Found ${venues.length} active venues to process`)

      // Process each venue
      for (const venue of venues) {
        try {
          // Get recipients (owners and admins)
          const recipients = venue.staff
            .map(sv => sv.staff)
            .filter(s => s.email) // Only staff with emails
            .map(s => ({
              email: s.email,
              name: `${s.firstName} ${s.lastName}`.trim() || 'Usuario',
            }))

          // Also include venue email if set
          if (venue.email && !recipients.find(r => r.email === venue.email)) {
            recipients.push({
              email: venue.email,
              name: venue.name,
            })
          }

          if (recipients.length === 0) {
            logger.debug(`No recipients found for venue ${venue.name} (${venue.id}), skipping`)
            continue
          }

          // Calculate today's date range in venue's timezone
          const now = new Date()
          const timezone = venue.timezone || 'America/Mexico_City'

          // Get start and end of today in venue's timezone
          const todayStart = new Date(now.toLocaleString('en-US', { timeZone: timezone }).split(',')[0] + ' 00:00:00')
          const todayEnd = new Date(now.toLocaleString('en-US', { timeZone: timezone }).split(',')[0] + ' 23:59:59')

          // Get yesterday for comparison
          const yesterdayStart = new Date(todayStart)
          yesterdayStart.setDate(yesterdayStart.getDate() - 1)
          const yesterdayEnd = new Date(todayEnd)
          yesterdayEnd.setDate(yesterdayEnd.getDate() - 1)

          // Get last week same day for comparison
          const lastWeekStart = new Date(todayStart)
          lastWeekStart.setDate(lastWeekStart.getDate() - 7)
          const lastWeekEnd = new Date(todayEnd)
          lastWeekEnd.setDate(lastWeekEnd.getDate() - 7)

          // Get sales summary for today
          const todaySummary = await getSalesSummary(venue.id, {
            startDate: todayStart.toISOString(),
            endDate: todayEnd.toISOString(),
            groupBy: 'paymentMethod',
            timezone,
          })

          // Get yesterday's summary for comparison
          const yesterdaySummary = await getSalesSummary(venue.id, {
            startDate: yesterdayStart.toISOString(),
            endDate: yesterdayEnd.toISOString(),
            timezone,
          })

          // Get last week's summary for comparison
          const lastWeekSummary = await getSalesSummary(venue.id, {
            startDate: lastWeekStart.toISOString(),
            endDate: lastWeekEnd.toISOString(),
            timezone,
          })

          // Get category breakdown
          const categoryBreakdown = await getCategoryBreakdown(venue.id, todayStart, todayEnd)

          // Get order sources breakdown
          const orderSources = await getOrderSourcesBreakdown(venue.id, todayStart, todayEnd)

          // Prepare email data
          const summaryData: VenueSalesSummaryData = {
            venueId: venue.id,
            venueName: venue.name,
            venueTimezone: timezone,
            venueCurrency: venue.currency || 'MXN',
            reportDate: now,
            businessHoursStart: '08:00 AM',
            businessHoursEnd: '10:00 PM',
            dashboardUrl: `https://dashboard.avoqado.io/${venue.slug}`,
            metrics: todaySummary.summary,
            previousPeriod: {
              netSales: yesterdaySummary.summary.netSales,
              avgOrder:
                yesterdaySummary.summary.transactionCount > 0
                  ? yesterdaySummary.summary.netSales / yesterdaySummary.summary.transactionCount
                  : 0,
              transactionCount: yesterdaySummary.summary.transactionCount,
            },
            categoryBreakdown,
            orderSources,
          }

          // Calculate weekly comparison
          const weeklyNetSalesChange =
            lastWeekSummary.summary.netSales > 0
              ? ((todaySummary.summary.netSales - lastWeekSummary.summary.netSales) / lastWeekSummary.summary.netSales) * 100
              : 0

          // Send email to each recipient
          for (const recipient of recipients) {
            try {
              const sent = await emailService.sendSalesSummaryEmail(recipient.email, summaryData, weeklyNetSalesChange)
              if (sent) {
                emailsSent++
                logger.debug(`Sales summary sent to ${recipient.email} for ${venue.name}`)
              }
            } catch (emailError) {
              errors++
              logger.error(`Failed to send sales summary to ${recipient.email}`, { error: emailError, venueId: venue.id })
            }
          }

          venuesProcessed++
        } catch (venueError) {
          errors++
          logger.error(`Failed to process venue ${venue.name}`, { error: venueError, venueId: venue.id })
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2)

      logger.info('Nightly sales summary job completed', {
        venuesProcessed,
        emailsSent,
        errors,
        durationSeconds: duration,
      })

      return { venuesProcessed, emailsSent, errors }
    } catch (error) {
      logger.error('Nightly sales summary job failed', {
        error,
        durationSeconds: ((Date.now() - startTime) / 1000).toFixed(2),
      })

      throw error
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Check if job is currently running
   */
  isJobRunning(): boolean {
    return this.isRunning
  }

  /**
   * Get next scheduled run time
   */
  getNextRun(): Date | null {
    if (this.job) {
      return this.job.nextDate()?.toJSDate() ?? null
    }
    return null
  }
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Get sales breakdown by category
 */
async function getCategoryBreakdown(
  venueId: string,
  startDate: Date,
  endDate: Date,
): Promise<Array<{ name: string; itemsSold: number; netSales: number }>> {
  const result = await prisma.$queryRaw<Array<{ name: string; items_sold: number; net_sales: number }>>`
    SELECT
      COALESCE(c.name, 'Sin categorizar') as name,
      COALESCE(SUM(oi.quantity), 0) as items_sold,
      COALESCE(SUM(oi.quantity * oi."unitPrice"), 0) as net_sales
    FROM "OrderItem" oi
    JOIN "Order" o ON oi."orderId" = o.id
    LEFT JOIN "Product" p ON oi."productId" = p.id
    LEFT JOIN "MenuCategory" c ON p."categoryId" = c.id
    WHERE o."venueId" = ${venueId}
      AND o."createdAt" >= ${startDate}
      AND o."createdAt" <= ${endDate}
      AND o.status NOT IN ('CANCELLED')
      AND o."paymentStatus" NOT IN ('REFUNDED')
    GROUP BY c.name
    ORDER BY net_sales DESC
    LIMIT 10
  `

  return result.map(r => ({
    name: r.name,
    itemsSold: Number(r.items_sold),
    netSales: Number(r.net_sales),
  }))
}

/**
 * Get order sources breakdown (POS, QR, etc.)
 */
async function getOrderSourcesBreakdown(
  venueId: string,
  startDate: Date,
  endDate: Date,
): Promise<Array<{ source: string; orders: number; netSales: number; avgOrder: number }>> {
  const result = await prisma.$queryRaw<Array<{ source: string; orders: number; net_sales: number }>>`
    SELECT
      COALESCE(o.source, 'TPV') as source,
      COUNT(*)::int as orders,
      COALESCE(SUM(o.subtotal), 0) as net_sales
    FROM "Order" o
    WHERE o."venueId" = ${venueId}
      AND o."createdAt" >= ${startDate}
      AND o."createdAt" <= ${endDate}
      AND o.status NOT IN ('CANCELLED')
      AND o."paymentStatus" NOT IN ('REFUNDED')
    GROUP BY o.source
    ORDER BY net_sales DESC
  `

  return result.map(r => ({
    source: formatOrderSource(r.source),
    orders: Number(r.orders),
    netSales: Number(r.net_sales),
    avgOrder: r.orders > 0 ? Number(r.net_sales) / Number(r.orders) : 0,
  }))
}

/**
 * Format order source for display
 */
function formatOrderSource(source: string | null): string {
  const sources: Record<string, string> = {
    TPV: 'Punto de venta',
    POS: 'Punto de venta',
    QR: 'Avoqado QR',
    ONLINE: 'Online',
    KIOSK: 'Kiosco',
    APP: 'App',
  }
  return sources[source?.toUpperCase() || 'TPV'] || source || 'Punto de venta'
}

// Export singleton instance
export const nightlySalesSummaryJob = new NightlySalesSummaryJob()
