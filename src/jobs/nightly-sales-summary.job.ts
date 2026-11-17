/**
 * Nightly Sales Summary Email Job
 *
 * Daily cron job that sends sales summary emails to venue admins and owners.
 * Runs at 07:02 Mexico City time and reports YESTERDAY's full calendar day of each venue, in the venue's zone
 * (D17, founder 16-nov-2026: in the morning with yesterday complete, like Square and Toast).
 *
 * What it does:
 * 1. Finds all active venues
 * 2. For each venue, calculates the reported day's sales metrics (and the day before / same day last week)
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
import { sqlRangoHoraRealSql } from '../services/shared/horaRealDelAparato'
import { NotificationType, Prisma, StaffRole, VenueStatus } from '@prisma/client'
import { lineRevenueSql } from '../services/dashboard/lineRevenue'
import { sqlImpuestoQueSeCobraAparte } from '../services/shared/orderBalance'
import { sqlOrdenSinTarjetas } from '../services/giftCards/giftCardMarks'
import { FRONTEND_URL } from '../config/env'
import { fromZonedTime } from 'date-fns-tz'
import { zonaValida } from '../utils/datetime'
import { venueCivilDate, venueDayKey } from '../utils/venueDateKeys'
import { scheduleJob } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'

// ============================================================
// Types
// ============================================================

/** Qué día de calendario del negocio reporta el correo: el de `now` o el anterior. */
export type NightlyReportDay = 'today' | 'yesterday'

/**
 * D17 (founder, 16-nov-2026): el correo sale en la mañana con el día COMPLETO de ayer, como Square y Toast. 'today' sólo
 * sirve con un envío al cierre del día; el de las 22:02 dejaba fuera lo que se vendía después.
 */
const NIGHTLY_REPORT_DAY: NightlyReportDay = 'yesterday'

export interface ReportWindow {
  start: Date
  end: Date
}

// Email-shaped metrics: the nightly job never passes a paymentMethod filter, so
// order-derived fields are always present at runtime. We coerce nulls to 0 at
// the boundary and type the email payload with a non-nullable variant.
type SalesSummaryMetricsForEmail = {
  [K in keyof SalesSummaryMetrics]: NonNullable<SalesSummaryMetrics[K]>
}

interface VenueSalesSummaryData {
  venueId: string
  venueName: string
  venueTimezone: string
  venueCurrency: string
  reportDate: Date
  businessHoursStart: string
  businessHoursEnd: string
  dashboardUrl: string
  metrics: SalesSummaryMetricsForEmail
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
  // Last week's metrics for weekly comparison
  lastWeekMetrics?: {
    grossSales: number
    items: number
    serviceCosts: number
    discounts: number
    refunds: number
    netSales: number
    taxes: number
    tips: number
    totalCollected: number
    platformFees: number
    transactionCount: number
  }
  // Customer metrics (if available)
  customers?: {
    total: number
    new: number
    returning: number
  }
  /**
   * D15: el puente QR legacy (MindForm) no contestó en alguno de los tres resúmenes del correo (el día reportado, el
   * anterior o el mismo día de la semana pasada): el total o sus comparaciones pueden estar incompletos y el correo lo dice.
   */
  legacyUnavailable?: true
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
    // Run daily at 07:02 AM Mexico City time (offset from */5 cron jobs to avoid Resend rate limits).
    // By then the calendar day being reported (yesterday, NIGHTLY_REPORT_DAY) has closed in every Mexican zone
    // (Tijuana is 05:02-06:02, Cancún 08:02), so the reported day is complete.
    this.job = scheduleJob(
      'nightly-sales-summary',
      '2 7 * * *', // At 07:02 every day
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
      logger.info('Nightly Sales Summary Job started - daily at 07:02 AM Mexico City (reports yesterday)')
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
      const venues = await retry(
        () =>
          prisma.venue.findMany({
            where: {
              ...(specificVenueId ? { id: specificVenueId } : {}),
              // Sin LIVE_DEMO: los negocios demo no mandan correos a nadie (candado demo, capa 3).
              status: {
                in: [VenueStatus.ACTIVE, VenueStatus.TRIAL],
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
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'nightly-sales-summary.findVenues' },
      )

      logger.info(`Found ${venues.length} active venues to process`)

      // One anchor for the whole run: every venue reports the same calendar day even if the run takes minutes.
      const now = new Date()

      // Process each venue
      for (const venue of venues) {
        try {
          // Opt-in: only send to staff who explicitly enabled daily sales summary
          const optedInStaff = await prisma.notificationPreference.findMany({
            where: {
              venueId: venue.id,
              type: NotificationType.DAILY_SALES_SUMMARY,
              enabled: true,
            },
            select: { staffId: true },
          })
          const optedInIds = new Set(optedInStaff.map(p => p.staffId))

          // Get recipients (only owners/admins who explicitly opted in)
          const recipients = venue.staff
            .filter(sv => optedInIds.has(sv.staff.id))
            .map(sv => sv.staff)
            .filter(s => s.email)
            .map(s => ({
              email: s.email,
              name: `${s.firstName} ${s.lastName}`.trim() || 'Usuario',
            }))

          // NOTE: Venue email is no longer auto-included.
          // Only staff who explicitly opt-in via notification preferences receive the summary.

          if (recipients.length === 0) {
            logger.debug(`No recipients found for venue ${venue.name} (${venue.id}), skipping`)
            continue
          }

          // D17: the reported day, the day before and the same day last week, as calendar days in the VENUE's zone
          // (never the process's: production runs in UTC). An unknown or broken zone falls back to Mexico City.
          const timezone = zonaValida(venue.timezone)
          const { reportDay, previousDay, sameDayLastWeek, reportDate } = nightlyReportWindows(now, timezone, NIGHTLY_REPORT_DAY)

          // Get sales summary for the reported day
          const todaySummary = await getSalesSummary(venue.id, {
            startDate: reportDay.start.toISOString(),
            endDate: reportDay.end.toISOString(),
            groupBy: 'paymentMethod',
            timezone,
          })

          // Get the day before for comparison
          const yesterdaySummary = await getSalesSummary(venue.id, {
            startDate: previousDay.start.toISOString(),
            endDate: previousDay.end.toISOString(),
            timezone,
          })

          // Get last week's same day for comparison
          const lastWeekSummary = await getSalesSummary(venue.id, {
            startDate: sameDayLastWeek.start.toISOString(),
            endDate: sameDayLastWeek.end.toISOString(),
            timezone,
          })

          // Get category breakdown
          const categoryBreakdown = await getCategoryBreakdown(venue.id, reportDay.start, reportDay.end)

          // Get order sources breakdown
          const orderSources = await getOrderSourcesBreakdown(venue.id, reportDay.start, reportDay.end)

          // Prepare email data
          const lwSummary = lastWeekSummary.summary
          const summaryData: VenueSalesSummaryData = {
            venueId: venue.id,
            venueName: venue.name,
            venueTimezone: timezone,
            venueCurrency: venue.currency || 'MXN',
            reportDate,
            businessHoursStart: '', // Not tracked per venue yet
            businessHoursEnd: '',
            dashboardUrl: `${FRONTEND_URL}/venues/${venue.slug}`,
            // Nightly job never passes paymentMethod, so order-derived metrics
            // (grossSales/items/etc.) are guaranteed non-null at runtime —
            // coerce with `?? 0` to satisfy the email service's strict `number` shape.
            metrics: {
              ...todaySummary.summary,
              grossSales: todaySummary.summary.grossSales ?? 0,
              items: todaySummary.summary.items ?? 0,
              serviceCosts: todaySummary.summary.serviceCosts ?? 0,
              discounts: todaySummary.summary.discounts ?? 0,
              netSales: todaySummary.summary.netSales ?? 0,
              deferredSales: todaySummary.summary.deferredSales ?? 0,
              taxes: todaySummary.summary.taxes ?? 0,
            },
            previousPeriod: {
              netSales: yesterdaySummary.summary.netSales ?? 0,
              avgOrder:
                yesterdaySummary.summary.transactionCount > 0
                  ? (yesterdaySummary.summary.netSales ?? 0) / yesterdaySummary.summary.transactionCount
                  : 0,
              transactionCount: yesterdaySummary.summary.transactionCount,
            },
            lastWeekMetrics: {
              grossSales: lwSummary.grossSales ?? 0,
              items: lwSummary.items ?? 0,
              serviceCosts: lwSummary.serviceCosts ?? 0,
              discounts: lwSummary.discounts ?? 0,
              refunds: lwSummary.refunds,
              netSales: lwSummary.netSales ?? 0,
              taxes: lwSummary.taxes ?? 0,
              tips: lwSummary.tips,
              totalCollected: lwSummary.totalCollected,
              platformFees: lwSummary.platformFees,
              transactionCount: lwSummary.transactionCount,
            },
            categoryBreakdown,
            orderSources,
            ...(todaySummary.legacyUnavailable || yesterdaySummary.legacyUnavailable || lastWeekSummary.legacyUnavailable
              ? { legacyUnavailable: true as const }
              : {}),
          }

          // Calculate weekly comparison — coerce nullable netSales to 0 because
          // the nightly job never filters (so these are always present at runtime).
          const todayNetSales = todaySummary.summary.netSales ?? 0
          const lastWeekNetSales = lastWeekSummary.summary.netSales ?? 0
          const weeklyNetSalesChange = lastWeekNetSales > 0 ? ((todayNetSales - lastWeekNetSales) / lastWeekNetSales) * 100 : 0

          // Send email to each recipient (with 500ms delay to respect Resend's 2/sec rate limit)
          for (const recipient of recipients) {
            try {
              const sent = await emailService.sendSalesSummaryEmail(recipient.email, summaryData, weeklyNetSalesChange)
              if (sent) {
                emailsSent++
                logger.debug(`Sales summary sent to ${recipient.email} for ${venue.name}`)
              }

              // Rate limit: 500ms between emails (same as marketing job)
              await new Promise(resolve => setTimeout(resolve, 500))
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
 * D17: the windows of the nightly email, as calendar days in the venue's zone, whatever the zone of the process.
 *
 * The old code formatted the venue's date and parsed «MM/DD/YYYY 00:00:00» back with `new Date`, which reads it in the
 * PROCESS zone: in production (UTC) a Mexico City «today» ran from 18:00 of the day before to 17:59. The day arithmetic
 * here is on the civil date (UTC calendar math, no hours), so a DST day lasts its real 23 or 25 hours and «last week»
 * lands on that day's own midnight.
 *
 * A day starts at the first instant whose civil date in the zone is that day and ends 1 ms before the next one starts
 * (inclusive window; 00:00:00.000 to 23:59:59.999 wherever midnight exists). Consecutive days are contiguous and never
 * overlap in any IANA zone (Codex r1): where midnight does not exist (Santiago, Havana, Beirut) the day starts at the jump,
 * and a repeated hour before midnight belongs only to the day it shows.
 */
export function nightlyReportWindows(
  now: Date,
  timezone: string | null | undefined,
  day: NightlyReportDay,
): { reportDay: ReportWindow; previousDay: ReportWindow; sameDayLastWeek: ReportWindow; reportDate: Date } {
  const tz = zonaValida(timezone)
  const hoy = venueCivilDate(now, tz)
  const llave = (offset: number) => new Date(Date.UTC(hoy.year, hoy.month - 1, hoy.day + offset)).toISOString().slice(0, 10)
  const dia = (offset: number): ReportWindow => ({
    start: new Date(firstInstantOfDay(llave(offset), tz)),
    end: new Date(firstInstantOfDay(llave(offset + 1), tz) - 1),
  })
  const base = day === 'today' ? 0 : -1
  const reportDay = dia(base)
  return {
    reportDay,
    previousDay: dia(base - 1),
    sameDayLastWeek: dia(base - 7),
    // The email prints it with toLocaleDateString(…, { timeZone: venue }): the middle of the window is always inside its day.
    reportDate: new Date(Math.floor((reportDay.start.getTime() + reportDay.end.getTime()) / 2)),
  }
}

/**
 * The first instant (epoch ms) whose civil date in `tz` is `dayKey` (yyyy-mm-dd). `fromZonedTime` of a midnight that does
 * not exist lands on the day before, and of a repeated hour it picks either occurrence, so its answer is only a starting
 * point: if it is not the first instant of the day, binary-search the jump within ±12 h of it.
 */
function firstInstantOfDay(dayKey: string, tz: string): number {
  const guess = fromZonedTime(`${dayKey}T00:00:00.000`, tz).getTime()
  const civil = (t: number) => venueDayKey(new Date(t), tz)
  if (civil(guess) === dayKey && civil(guess - 1) < dayKey) return guess
  let before = guess - 12 * 3_600_000 // civil(before) < dayKey
  let from = guess + 12 * 3_600_000 // civil(from) >= dayKey
  while (from - before > 1) {
    const mid = Math.floor((before + from) / 2)
    if (civil(mid) < dayKey) before = mid
    else from = mid
  }
  return from
}

/**
 * Get sales breakdown by category
 */
export async function getCategoryBreakdown(
  venueId: string,
  startDate: Date,
  endDate: Date,
): Promise<Array<{ name: string; itemsSold: number; netSales: number }>> {
  const result = await prisma.$queryRaw<Array<{ name: string; items_sold: number; net_sales: number }>>`
    SELECT
      COALESCE(c.name, 'Sin categorizar') as name,
      COALESCE(SUM(oi.quantity), 0) as items_sold,
      -- This column, its SQL alias and the TS return type all say NET, but it
      -- used to sum unitPrice * quantity — the LIST price — so a category with
      -- a combo was overstated in the owner's nightly email.
      COALESCE(SUM(${Prisma.raw(lineRevenueSql())}), 0) as net_sales
    FROM "OrderItem" oi
    JOIN "Order" o ON oi."orderId" = o.id
    LEFT JOIN "Product" p ON oi."productId" = p.id
    LEFT JOIN "MenuCategory" c ON p."categoryId" = c.id
    WHERE o."venueId" = ${venueId}
      AND ${sqlRangoHoraRealSql('o', startDate, endDate)} -- D93: la hora real, la misma del resumen de arriba
      AND o.status NOT IN ('CANCELLED')
      AND o."paymentStatus" NOT IN ('REFUNDED')
      AND oi."removedAt" IS NULL -- a line the delivery provider removed sold nothing
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
 * Orders whose discount exceeds their own subtotal — the ones `LEAST(discount, subtotal)`
 * clamps in `getOrderSourcesBreakdown`.
 *
 * A clamp that corrects in silence is how a damaged row stays damaged forever:
 * the email looks right, so nobody ever learns the order needs fixing. This is
 * the cheap second pass that names them.
 *
 * Diagnostics only — it must NEVER break the owner's nightly email, so a failure
 * here is swallowed after being logged. The email is the product; this is not.
 */
async function warnOnClampedOrders(venueId: string, startDate: Date, endDate: Date): Promise<void> {
  const SAMPLE_LIMIT = 20

  try {
    const damaged = await prisma.$queryRaw<
      Array<{ id: string; orderNumber: string; subtotal: unknown; discounts: unknown; net_sales: unknown }>
    >`
      SELECT
        o.id,
        o."orderNumber",
        o.subtotal,
        o."discountAmount" as discounts,
        o.subtotal - o."discountAmount" as net_sales
      FROM "Order" o
      WHERE o."venueId" = ${venueId}
        AND ${sqlRangoHoraRealSql('o', startDate, endDate)}
        AND o.status NOT IN ('CANCELLED')
        AND o."paymentStatus" NOT IN ('REFUNDED')
        -- D43: the same per-order net as getOrderSourcesBreakdown (a table cortesía is already out of the subtotal).
        AND o.subtotal - o."discountAmount" < 0
        -- B2c F2: desde B2/B2c la cabecera es Σ filas SIN tope; una cortesía sobre un fijo (160 sobre 150, total 0) es legítima.
        -- Sólo es daño la cabecera que sus FILAS no explican: sin filas (ORD-1779465117373) o Σ filas ≠ cabecera.
        AND (SELECT SUM(od.amount) FROM "OrderDiscount" od WHERE od."orderId" = o.id) IS DISTINCT FROM o."discountAmount"
      ORDER BY net_sales ASC
      LIMIT ${SAMPLE_LIMIT + 1}
    `

    if (damaged.length === 0) return

    // Data damage, not money at risk — the sale was already clamped to 0, so
    // nothing is being over- or under-paid. Someone just has to go fix the row.
    const base = { venueId, clampedOrders: damaged.length > SAMPLE_LIMIT ? `${SAMPLE_LIMIT}+` : damaged.length }

    if (damaged.length > SAMPLE_LIMIT) {
      logger.warn('⚠️ Órdenes con descuento mayor que su subtotal: net sales negativo, se reportó 0 (data dañada)', {
        ...base,
        note: `Más de ${SAMPLE_LIMIT} órdenes afectadas; se omite el detalle`,
      })
      return
    }

    for (const order of damaged) {
      logger.warn('⚠️ Orden con descuento mayor que su subtotal: net sales negativo, se reportó 0 (data dañada)', {
        ...base,
        orderId: order.id,
        orderNumber: order.orderNumber,
        subtotal: Number(order.subtotal),
        discounts: Number(order.discounts),
        netSalesBeforeClamp: Number(order.net_sales),
      })
    }
  } catch (error) {
    // Never let an observability query take down the nightly email.
    logger.warn('⚠️ No se pudo revisar órdenes con net sales negativo', { venueId, error })
  }
}

/**
 * Get order sources breakdown (POS, QR, etc.)
 */
export async function getOrderSourcesBreakdown(
  venueId: string,
  startDate: Date,
  endDate: Date,
): Promise<Array<{ source: string; orders: number; netSales: number; avgOrder: number }>> {
  const result = await prisma.$queryRaw<Array<{ source: string; orders: number; net_sales: number }>>`
    SELECT
      COALESCE(o.source, 'TPV') as source,
      COUNT(*)::int as orders,
      -- Same defect as getCategoryBreakdown above, same email, same "netSales"
      -- label: this summed Order.subtotal, which is GROSS of every giveaway.
      -- A 100%-cortesía order that charged 0 was reported as a full sale.
      --
      -- 🔴 D43 (12-nov-2026): the per-order net is the SAME one the Sales Summary
      -- uses (its netSales is the email's headline): subtotal − LEAST(discount,
      -- subtotal), plus the IVA charged on top. It used to also subtract the
      -- line discounts of «net» lines (isItemLevelDiscountSql), but a table
      -- cortesía from the POS (compOrderItem → subtotal = Σ OrderItem.total)
      -- is ALREADY out of the subtotal: the Agua was taken off twice and a
      -- $49.50 check read $29.50. A «Cobrar»/terminal cortesía keeps its line
      -- gross and books the giveaway in Order.discountAmount (COMP row), so the
      -- same formula covers both. Header-only on purpose: imported orders have
      -- no OrderItem rows, and no JOIN means no fan-out by line count.
      -- LEAST caps a single order at zero: 3 orders in live data carry a
      -- discount larger than their own subtotal (one has subtotal 0 with a 300
      -- discount) — an order that sold NOTHING must read as 0 in the owner's
      -- email, never as a negative that cancels a real sale in the same bucket.
      COALESCE(SUM(
        o.subtotal - LEAST(o."discountAmount", o.subtotal)
      -- D16: the IVA an order charged ON TOP is part of what the customer paid (same rule as the summary's netSales),
      -- added outside the clamp like computeStoredOrderTotal does.
      + ${Prisma.raw(sqlImpuestoQueSeCobraAparte('o'))}), 0) as net_sales
    FROM "Order" o
    WHERE o."venueId" = ${venueId}
      AND ${sqlRangoHoraRealSql('o', startDate, endDate)} -- D93: la hora real, la misma del resumen de arriba
      AND o.status NOT IN ('CANCELLED')
      AND o."paymentStatus" NOT IN ('REFUNDED')
    GROUP BY o.source
    ORDER BY net_sales DESC
  `

  // 🔴 D46 (14-nov-2026): the headline netSales is gross − discounts − REFUNDS, but this breakdown never
  // subtracted refunds: $10 returned from a $100 sale read $90 above and $100 in its channel. Each channel
  // now subtracts the refunds made in the window on ITS orders, with the SAME population as the Sales
  // Summary's refund aggregate (getSalesSummary, «3. Refunds»): REFUND payments by their own createdAt
  // (a refund today of yesterday's sale counts today, like the headline), sale + tip portion, on an order
  // that is neither cancelled/deleted nor a gift-card sale. Σ channels = headline netSales, to the cent.
  // A refund whose order was sold before the window still lands in its channel, even with 0 orders today.
  const refundsBySource = await prisma.$queryRaw<Array<{ source: string; refunds: unknown }>>`
    SELECT
      COALESCE(o.source::text, 'TPV') as source,
      -- Refund rows are negative (amount and tipAmount); −SUM keeps Σ groups = |Σ all| like the summary.
      COALESCE(-SUM(p.amount + p."tipAmount"), 0) as refunds
    FROM "Payment" p
    JOIN "Order" o ON o.id = p."orderId"
    WHERE p."venueId" = ${venueId}
      AND p.type = 'REFUND'
      AND ${sqlRangoHoraRealSql('p', startDate, endDate)}
      AND o.status NOT IN ('CANCELLED', 'DELETED')
      AND ${sqlOrdenSinTarjetas('o.id')}
    GROUP BY COALESCE(o.source::text, 'TPV')
  `

  // The clamp above may have silently zeroed a damaged order. Name them.
  await warnOnClampedOrders(venueId, startDate, endDate)

  const bySource = new Map<string, { orders: number; netSales: number }>()
  for (const r of result) {
    const key = r.source ?? 'TPV'
    const prev = bySource.get(key) ?? { orders: 0, netSales: 0 }
    bySource.set(key, { orders: prev.orders + Number(r.orders), netSales: prev.netSales + Number(r.net_sales) })
  }
  for (const r of refundsBySource) {
    const prev = bySource.get(r.source) ?? { orders: 0, netSales: 0 }
    bySource.set(r.source, { orders: prev.orders, netSales: prev.netSales - Number(r.refunds) })
  }

  return [...bySource.entries()]
    .map(([source, v]) => {
      const netSales = Math.round(v.netSales * 100) / 100
      return {
        source: formatOrderSource(source),
        orders: v.orders,
        netSales,
        avgOrder: v.orders > 0 ? netSales / v.orders : 0,
      }
    })
    .sort((a, b) => b.netSales - a.netSales)
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
