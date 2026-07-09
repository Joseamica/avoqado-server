/**
 * Weekly New Customers Report Job
 *
 * Sends a weekly email listing venues that both (a) completed onboarding and
 * (b) are on a paid plan — the "activated + paid" signal marketing needs to
 * cross-reference against ad platform contacts and compute cost-per-CLIENT
 * (not just cost-per-contact) per channel.
 *
 * Runs Monday mornings, reporting on the week that just ended (Mon 00:00 -
 * Sun 23:59, America/Mexico_City). Can also be triggered on demand via
 * runNow() — pass { previewOnly: true } to compute the report WITHOUT
 * sending the email (used by the superadmin preview endpoint so a human can
 * see real data before the recurring send is switched on).
 *
 * "Activated" = onboardingCompletedAt in range + status ACTIVE (not TRIAL/
 * LIVE_DEMO/SUSPENDED at report time). "Paid" = planTier is PRO/PREMIUM/
 * ENTERPRISE (GRATIS/null excluded).
 */

import { CronJob } from 'cron'
import { PlanTier, VenueStatus } from '@prisma/client'
import { formatInTimeZone, toZonedTime } from 'date-fns-tz'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import emailService from '../services/email.service'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { env } from '../config/env'

const TIMEZONE = 'America/Mexico_City'
const PAID_TIERS: PlanTier[] = [PlanTier.PRO, PlanTier.PREMIUM, PlanTier.ENTERPRISE]

interface NewCustomerRow {
  venueId: string
  name: string
  phone: string | null
  email: string | null
  planTier: PlanTier
  onboardingCompletedAt: Date
}

export interface WeeklyNewCustomersResult {
  weekStart: Date
  weekEnd: Date
  customers: NewCustomerRow[]
  emailSent: boolean
  skippedReason?: string
}

export class WeeklyNewCustomersReportJob {
  private job: CronJob | null = null

  constructor() {
    // Monday 8:07 AM Mexico City — offset off the hour/half-hour marks per
    // .claude/rules/cron-jobs.md (avoid the every-job-fires-at-:00 stampede).
    this.job = new CronJob(
      '7 8 * * 1', // 08:07 every Monday
      async () => {
        await this.runNow()
      },
      null,
      false, // Don't start automatically — wired up explicitly once approved.
      TIMEZONE,
    )
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('Weekly New Customers Report Job started - Mondays at 8:07 AM Mexico City')
    }
  }

  stop(): void {
    this.job?.stop()
  }

  getNextRun(): Date | null {
    return this.job?.nextDate()?.toJSDate() ?? null
  }

  /**
   * Compute (and optionally send) the report for the most recently completed
   * Mon-Sun week relative to `at` (defaults to now).
   *
   * @param opts.previewOnly - compute the data but never call the email API.
   * @param opts.at - override "now" for testing a specific week.
   */
  async runNow(opts: { previewOnly?: boolean; at?: Date } = {}): Promise<WeeklyNewCustomersResult> {
    const { previewOnly = false, at = new Date() } = opts
    const { weekStart, weekEnd } = getLastCompleteWeek(at)

    logger.info('Running weekly new customers report', {
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      previewOnly,
    })

    // Entry read — wrap per cron-jobs.md (pure read, safe to retry on P1001).
    const venues = await retry(
      () =>
        prisma.venue.findMany({
          where: {
            onboardingCompletedAt: { gte: weekStart, lte: weekEnd },
            status: VenueStatus.ACTIVE,
            planTier: { in: PAID_TIERS },
          },
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            planTier: true,
            onboardingCompletedAt: true,
          },
          orderBy: { onboardingCompletedAt: 'asc' },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'weekly-new-customers-report.findMany' },
    )

    const customers: NewCustomerRow[] = venues.map(v => ({
      venueId: v.id,
      name: v.name,
      phone: v.phone,
      email: v.email,
      planTier: v.planTier as PlanTier,
      onboardingCompletedAt: v.onboardingCompletedAt as Date,
    }))

    if (previewOnly) {
      return { weekStart, weekEnd, customers, emailSent: false, skippedReason: 'previewOnly' }
    }

    const recipient = env.WEEKLY_NEW_CUSTOMERS_REPORT_EMAIL
    if (!recipient) {
      logger.warn('WEEKLY_NEW_CUSTOMERS_REPORT_EMAIL not configured — skipping send', { customersFound: customers.length })
      return { weekStart, weekEnd, customers, emailSent: false, skippedReason: 'no_recipient_configured' }
    }

    const sent = await emailService.sendEmail({
      to: recipient,
      subject: `Avoqado — ${customers.length} cliente${customers.length === 1 ? '' : 's'} nuevo${customers.length === 1 ? '' : 's'} esta semana (${formatInTimeZone(weekStart, TIMEZONE, 'd MMM')} - ${formatInTimeZone(weekEnd, TIMEZONE, 'd MMM')})`,
      html: buildReportHtml(customers, weekStart, weekEnd),
    })

    logger.info('Weekly new customers report finished', { customersFound: customers.length, emailSent: sent })

    return { weekStart, weekEnd, customers, emailSent: sent }
  }
}

/** Monday 00:00:00 through Sunday 23:59:59 (Mexico City) of the week before `at`'s week. */
function getLastCompleteWeek(at: Date): { weekStart: Date; weekEnd: Date } {
  const zoned = toZonedTime(at, TIMEZONE)
  const dayOfWeek = zoned.getDay() // 0=Sun..6=Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7 // Mon=0..Sun=6

  const thisMonday = new Date(zoned)
  thisMonday.setHours(0, 0, 0, 0)
  thisMonday.setDate(thisMonday.getDate() - daysSinceMonday)

  const weekStart = new Date(thisMonday)
  weekStart.setDate(weekStart.getDate() - 7)

  const weekEnd = new Date(thisMonday)
  weekEnd.setMilliseconds(weekEnd.getMilliseconds() - 1) // one week later, minus 1ms = prior Sunday 23:59:59.999

  return { weekStart, weekEnd }
}

function buildReportHtml(customers: NewCustomerRow[], weekStart: Date, weekEnd: Date): string {
  const range = `${formatInTimeZone(weekStart, TIMEZONE, 'd MMM yyyy')} – ${formatInTimeZone(weekEnd, TIMEZONE, 'd MMM yyyy')}`
  const planLabel: Record<string, string> = { PRO: 'Pro', PREMIUM: 'Premium', ENTERPRISE: 'Enterprise' }

  const rows = customers
    .map(
      c => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(c.name)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(c.phone || '—')}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(c.email || '—')}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${planLabel[c.planTier] || c.planTier}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${formatInTimeZone(c.onboardingCompletedAt, TIMEZONE, 'd MMM, h:mm a')}</td>
      </tr>`,
    )
    .join('')

  const empty = `<tr><td colspan="5" style="padding:16px;color:#666;text-align:center;">Ningún cliente nuevo activado y pagado esta semana.</td></tr>`

  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;">
      <h2 style="margin-bottom:4px;">Clientes nuevos activados y pagados</h2>
      <p style="color:#666;margin-top:0;">${range} · ${customers.length} cliente${customers.length === 1 ? '' : 's'}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="background:#f5f5f5;text-align:left;">
            <th style="padding:8px 12px;">Negocio</th>
            <th style="padding:8px 12px;">Teléfono</th>
            <th style="padding:8px 12px;">Email</th>
            <th style="padding:8px 12px;">Plan</th>
            <th style="padding:8px 12px;">Activado</th>
          </tr>
        </thead>
        <tbody>${customers.length ? rows : empty}</tbody>
      </table>
      <p style="color:#999;font-size:12px;margin-top:24px;">Reporte automático semanal — Avoqado.</p>
    </div>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Export singleton instance — matches the pattern used by every other job in this folder.
export const weeklyNewCustomersReportJob = new WeeklyNewCustomersReportJob()
