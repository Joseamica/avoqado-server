/**
 * Mercado Pago — Daily access_token refresh.
 *
 * MP access_tokens live 180 days. We refresh tokens that expire within 30 days
 * to give us 30-day slack: if MP API has an outage, or our cron is paused for
 * a few days, we still have a working token to fall back on.
 *
 * Each refresh:
 *   1. Acquires a PostgreSQL advisory lock keyed by venueId (so cron + on-demand
 *      refreshes never race — MP rotates refresh_tokens, so a race could
 *      persist a stale token and lock us out of the seller's account).
 *   2. Decrypts the current refresh_token.
 *   3. Calls MP /oauth/token with grant_type=refresh_token.
 *   4. Persists the new {access_token, refresh_token, expiresAt, publicKey}.
 *
 * Errors are isolated per-merchant — one failing seller doesn't block the
 * rest of the batch. After 3 consecutive failures, BetterStack alerting (TODO)
 * should fire so ops can investigate.
 *
 * Cron: daily at 03:00 Mexico City.
 */
import { CronJob } from 'cron'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { refreshIfExpiring } from '../services/mercado-pago/connection.service'

const TIMEZONE = 'America/Mexico_City'
const REFRESH_THRESHOLD_DAYS = 30

export interface RefreshSummary {
  total: number
  refreshed: number
  notNeeded: number
  noCredentials: number
  errors: number
}

export class MercadoPagoTokenRefreshJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    this.job = new CronJob(
      '0 3 * * *', // Daily at 03:00
      async () => {
        await this.process()
      },
      null,
      false,
      TIMEZONE,
    )
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('MP Token Refresh Job started — daily at 03:00 Mexico City')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('MP Token Refresh Job stopped')
    }
  }

  /** Run the refresh batch immediately (useful for tests + ops triggers). */
  async runNow(): Promise<RefreshSummary> {
    return this.process()
  }

  private async process(): Promise<RefreshSummary> {
    if (this.isRunning) {
      logger.warn('MP Token Refresh Job is already running, skipping this tick')
      return { total: 0, refreshed: 0, notNeeded: 0, noCredentials: 0, errors: 0 }
    }
    this.isRunning = true

    try {
      const provider = await prisma.paymentProvider.findUnique({ where: { code: 'MERCADO_PAGO' } })
      if (!provider) {
        logger.warn('MERCADO_PAGO PaymentProvider not seeded — skipping refresh job')
        return { total: 0, refreshed: 0, notNeeded: 0, noCredentials: 0, errors: 0 }
      }

      const merchants = await prisma.ecommerceMerchant.findMany({
        where: {
          providerId: provider.id,
          providerMerchantId: { not: null }, // skip unconnected merchants
        },
        select: { id: true },
      })

      const summary: RefreshSummary = {
        total: merchants.length,
        refreshed: 0,
        notNeeded: 0,
        noCredentials: 0,
        errors: 0,
      }

      for (const merchant of merchants) {
        try {
          const result = await refreshIfExpiring(merchant.id, REFRESH_THRESHOLD_DAYS)
          if (result === 'refreshed') summary.refreshed++
          else if (result === 'not_needed') summary.notNeeded++
          else summary.noCredentials++
        } catch (err: any) {
          summary.errors++
          logger.error('MP token refresh failed for merchant', {
            err: err.message,
            ecommerceMerchantId: merchant.id,
          })
        }
      }

      logger.info('MP Token Refresh Job completed', { summary })
      return summary
    } catch (err: any) {
      logger.error('MP Token Refresh Job batch failed', { err: err.message })
      return { total: 0, refreshed: 0, notNeeded: 0, noCredentials: 0, errors: 1 }
    } finally {
      this.isRunning = false
    }
  }
}

export const mercadoPagoTokenRefreshJob = new MercadoPagoTokenRefreshJob()
