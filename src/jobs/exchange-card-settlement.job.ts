import type { CronJob } from 'cron'
import { Prisma } from '@prisma/client'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { utcTs } from '../utils/sqlDates'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { scheduleJob } from '../observability/jobContext'
import { getVenueName } from '../observability/venueNames'
import { settleExchangeCharge, cancelExchange } from '../services/exchanges/exchange.service'
import { sqlPaymentIsNotExchangeCredit } from '../services/exchanges/exchangeMarks'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { conNegocio } from '../services/demo/candadoDemo'

type Lane = 'PENDING_PAYMENT' | 'CANCELLED'
type Candidate = { id: string; venueId: string; createdAt: Date }
type Cursor = { after: Candidate | null; cycleUntil: Date | null }

export class ExchangeCardSettlementJob {
  private readonly job: CronJob
  private isRunning = false
  private firstLane: Lane = 'PENDING_PAYMENT'
  // shortcut: el cursor reinicia con el proceso, persistir si reinicios repetidos impiden completar vueltas
  private readonly cursors: Record<Lane, Cursor> = {
    PENDING_PAYMENT: { after: null, cycleUntil: null },
    CANCELLED: { after: null, cycleUntil: null },
  }

  constructor() {
    this.job = scheduleJob(
      'exchange-card-settlement',
      DATABASE_JOB_SCHEDULES.exchangeCardSettlement,
      async () => {
        await this.run()
      },
      null,
      false,
      'America/Mexico_City',
    )
  }

  start(): void {
    this.job.start()
    void this.run()
  }

  stop(): void {
    this.job.stop()
  }

  async run(now = new Date()): Promise<{ settled: number; reviewed: number; released: number }> {
    const totals = { settled: 0, reviewed: 0, released: 0 }
    if (this.isRunning) return totals
    this.isRunning = true
    const startedAt = Date.now()
    const lanes: Lane[] = [this.firstLane, this.firstLane === 'PENDING_PAYMENT' ? 'CANCELLED' : 'PENDING_PAYMENT']
    this.firstLane = lanes[1]
    try {
      for (const lane of lanes) {
        if (Date.now() - startedAt >= 20_000) break
        const cursor = this.cursors[lane]
        const cycleUntil = cursor.cycleUntil ?? now
        const after = cursor.after
        let rows: Candidate[]
        try {
          rows = await retry(
            () =>
              prisma.$queryRaw<Candidate[]>(Prisma.sql`
            SELECT e.id, e."venueId", e."createdAt" FROM "Exchange" e
            WHERE e."settlementKind" = 'COLLECT' AND e."settlementMethod" = 'CARD_TERMINAL'
              AND e.status = ${lane}::"ExchangeStatus" AND e."createdAt" <= ${utcTs(cycleUntil)}
              ${after ? Prisma.sql`AND (e."createdAt", e.id) > (${utcTs(after.createdAt)}, ${after.id})` : Prisma.empty}
              ${
                lane === 'CANCELLED'
                  ? Prisma.sql`AND (
                e."chargePaymentId" IS NOT NULL OR EXISTS (
                  SELECT 1 FROM "Payment" p WHERE p."venueId" = e."venueId" AND p."orderId" = e."newOrderId"
                    AND p.status IN ('COMPLETED', 'REFUNDED') AND (p.type IS NULL OR p.type <> 'REFUND')
                    AND ${sqlPaymentIsNotExchangeCredit('p')}
                ) OR EXISTS (
                  SELECT 1 FROM "TerminalPaymentRequest" r WHERE r."venueId" = e."venueId" AND r."orderId" = e."newOrderId"
                    AND r.status = 'COMPLETED' AND r."paymentId" IS NOT NULL AND r."paymentId" <> ''
                )
              )`
                  : Prisma.empty
              }
            ORDER BY e."createdAt" ASC, e.id ASC LIMIT 50
          `),
            { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: `exchange-card-settlement.${lane}` },
          )
        } catch (error) {
          logger.error('🚨 [Exchange] Card sweep selection failed', { lane, error })
          continue
        }
        cursor.cycleUntil = cycleUntil
        let attempted = 0
        for (const candidate of rows) {
          if (Date.now() - startedAt >= 20_000) break
          // ponytail: sin contador de intentos; un cierre que falla siempre se reintenta cada 30 s y grita 🚨 — agregar backoff si pasa
          try {
            // Con el negocio de la fila en el contexto (candado demo, capa 3).
            const result = await conNegocio(candidate.venueId, () =>
              settleExchangeCharge({ venueId: candidate.venueId, exchangeId: candidate.id, actorStaffId: null }),
            )
            if (result.outcome === 'SETTLED') totals.settled++
            if (result.outcome === 'REVIEW') totals.reviewed++
            if (result.outcome === 'NOT_CHARGED') {
              const exchange = await conNegocio(candidate.venueId, () =>
                cancelExchange({
                  venueId: candidate.venueId,
                  exchangeId: candidate.id,
                  actorStaffId: null,
                  origin: 'SWEEP',
                }),
              )
              if (exchange.status === 'CANCELLED') totals.released++
            }
          } catch (error) {
            logger.error('🚨 [Exchange] Card sweep candidate failed', {
              exchangeId: candidate.id,
              venueId: candidate.venueId,
              venueName: getVenueName(candidate.venueId),
              error,
            })
          } finally {
            cursor.after = candidate
            attempted++
          }
        }
        if (attempted === rows.length && rows.length < 50) {
          cursor.after = null
          cursor.cycleUntil = null
        }
      }
    } finally {
      this.isRunning = false
    }
    return totals
  }
}

export const exchangeCardSettlementJob = new ExchangeCardSettlementJob()
