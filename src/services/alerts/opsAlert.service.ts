// src/services/alerts/opsAlert.service.ts

/**
 * Ops alert by email — a channel that does NOT depend on the log pipeline.
 *
 * Why this exists (2026-09-04, Testarudo): the "🚨 Row went UNKNOWN" alarm lived only in
 * Better Stack. Better Stack had been blind since the day before (their own Europe-region
 * incident), so a PAX terminal sat locked for 3 hours and we learned about it from the
 * customer's WhatsApp. Money events that a human must act on need a second, independent
 * channel. Email through Resend is already wired for transactional mail.
 *
 * Contract:
 * - Never throws. A failed alert must never break the money path that raised it.
 * - Recipient = `OPS_ALERT_EMAIL`. If it is not configured the alert is logged at `warn`
 *   (once per process, to avoid a warning per tick) and skipped — the 🚨 log line still
 *   exists for Better Stack.
 * - Call it OUTSIDE any retry()/transaction (cron-jobs.md: sends are never retried).
 */

import logger from '../../config/logger'
import { env } from '../../config/env'
import emailService from '../email.service'

export interface OpsAlert {
  /** Short, specific, greppable. Put the identifier a human needs (terminal, venue) in it. */
  subject: string
  /** Plain-language lines; each becomes a paragraph. First line = what happened, then what to do. */
  lines: string[]
}

const SEND_TIMEOUT_MS = 5_000

let warnedMissingRecipient = false

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function sendOpsAlert(alert: OpsAlert): Promise<boolean> {
  const recipient = env.OPS_ALERT_EMAIL
  if (!recipient) {
    if (!warnedMissingRecipient) {
      warnedMissingRecipient = true
      logger.warn('[opsAlert] OPS_ALERT_EMAIL is not configured — ops alerts are log-only', { subject: alert.subject })
    }
    return false
  }
  try {
    const html = alert.lines.map(l => `<p style="margin:0 0 12px 0;font-family:sans-serif;font-size:14px">${escapeHtml(l)}</p>`).join('')
    // Bounded: the Resend client has no timeout of its own, and callers fire this from the money
    // watchdog. A hung provider must cost at most SEND_TIMEOUT_MS, never a stalled sweep.
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), SEND_TIMEOUT_MS)
    })
    const sent = await Promise.race([
      emailService.sendEmail({ to: recipient, subject: `[Avoqado ops] ${alert.subject}`, html }),
      timeout,
    ]).finally(() => clearTimeout(timer))
    if (!sent) logger.warn('[opsAlert] email not sent (provider error or timeout)', { subject: alert.subject })
    return sent
  } catch (err) {
    logger.error('[opsAlert] failed to send', { subject: alert.subject, error: err instanceof Error ? err.message : String(err) })
    return false
  }
}
