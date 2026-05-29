// jobs/tpv-order-expiry.job.ts
import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import emailService from '../services/email.service'

/**
 * Job que maneja el ciclo de vida de órdenes TPV pendientes:
 *
 * 1. Marca como EXPIRED:
 *    - AWAITING_PAYMENT > 7 días (cliente abandonó Stripe Checkout)
 *    - AWAITING_PROOF > 14 días (cliente no subió comprobante SPEI)
 * 2. Manda recordatorios SPEI:
 *    - Día 3: primer recordatorio
 *    - Día 7: último recordatorio (faltan 7 para expirar)
 *
 * Corre cada 6 horas.
 */
export class TpvOrderExpiryJob {
  private job: CronJob | null = null
  private readonly CRON_PATTERN = '0 */6 * * *' // every 6 hours
  private readonly STRIPE_EXPIRY_DAYS = 7
  private readonly SPEI_EXPIRY_DAYS = 14
  private readonly REMINDER_DAYS = [3, 7]

  constructor() {
    this.job = new CronJob(this.CRON_PATTERN, this.runOnce.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info(`📅 TPV Order Expiry Job started — runs every 6h`)
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('📅 TPV Order Expiry Job stopped')
    }
  }

  async runOnce(): Promise<void> {
    try {
      await this.expireStripeOrders()
      await this.expireSpeiOrders()
      await this.sendSpeiReminders()
    } catch (err) {
      logger.error('TpvOrderExpiryJob failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async expireStripeOrders(): Promise<number> {
    const cutoff = new Date(Date.now() - this.STRIPE_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
    const result = await prisma.terminalOrder.updateMany({
      where: {
        paymentMethod: 'CARD_STRIPE',
        paymentStatus: 'AWAITING_PAYMENT',
        createdAt: { lt: cutoff },
      },
      data: { paymentStatus: 'EXPIRED' },
    })
    if (result.count > 0) {
      logger.info(`📅 Expired ${result.count} stale Stripe AWAITING_PAYMENT orders`)
    }
    return result.count
  }

  private async expireSpeiOrders(): Promise<number> {
    const cutoff = new Date(Date.now() - this.SPEI_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
    const result = await prisma.terminalOrder.updateMany({
      where: {
        paymentMethod: 'SPEI',
        paymentStatus: 'AWAITING_PROOF',
        createdAt: { lt: cutoff },
      },
      data: { paymentStatus: 'EXPIRED' },
    })
    if (result.count > 0) {
      logger.info(`📅 Expired ${result.count} stale SPEI AWAITING_PROOF orders`)
    }
    return result.count
  }

  private async sendSpeiReminders(): Promise<number> {
    const baseUrl = process.env.DASHBOARD_URL ?? process.env.FRONTEND_URL ?? process.env.APP_URL ?? 'https://dashboard.avoqado.io'

    const speiRecipient = {
      beneficiary: process.env.SPEI_RECIPIENT_BENEFICIARY ?? '',
      clabe: process.env.SPEI_RECIPIENT_CLABE ?? '',
      rfc: process.env.SPEI_RECIPIENT_RFC ?? '',
      bank: process.env.SPEI_RECIPIENT_BANK ?? '',
    }

    let sent = 0
    for (const days of this.REMINDER_DAYS) {
      // 6-hour window centered on the target day so the job catches each order exactly once
      const windowStart = new Date(Date.now() - (days + 0.25) * 24 * 60 * 60 * 1000)
      const windowEnd = new Date(Date.now() - (days - 0.25) * 24 * 60 * 60 * 1000)

      const orders = await prisma.terminalOrder.findMany({
        where: {
          paymentMethod: 'SPEI',
          paymentStatus: 'AWAITING_PROOF',
          createdAt: { gte: windowStart, lt: windowEnd },
        },
        include: { items: true, venue: { select: { slug: true } } },
      })

      for (const order of orders) {
        try {
          const orderDetailUrl = `${baseUrl}/venues/${order.venue.slug}/tpv/orders/${order.id}`
          const daysRemaining = this.SPEI_EXPIRY_DAYS - days
          await emailService.sendTerminalOrderSpeiReminder({
            order: order as any,
            items: order.items as any,
            daysSinceCreation: days,
            daysRemaining,
            orderDetailUrl,
            speiRecipient,
          })
          sent++
        } catch (err) {
          logger.error('SPEI reminder failed for order', {
            orderId: order.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    if (sent > 0) logger.info(`📅 Sent ${sent} SPEI reminders`)
    return sent
  }
}

export const tpvOrderExpiryJob = new TpvOrderExpiryJob()
