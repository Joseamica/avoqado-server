/**
 * Venue Commission Settlement Report (Layer 2)
 *
 * Calculates per-venue commissions on top of Layer 1 (aggregator base fees).
 * Splits the commission between external referrer (Avoqado) and aggregator (Moneygiver).
 */

import { Decimal } from '@prisma/client/runtime/library'
import { Prisma } from '@prisma/client'
import { CronJob } from 'cron'
import { fromZonedTime } from 'date-fns-tz'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import emailService from '../services/email.service'

// ─── Types ───

export interface RawPaymentRow {
  venue_name: string
  card_type: string
  tx_count: bigint
  gross_amount: Decimal
  tips: Decimal
  commission_rate: Decimal
  referred_by: string
  base_fee_rate: number
  iva_rate: number
}

export interface CommissionRow {
  venueName: string
  cardType: string
  txCount: number
  grossAmount: number
  tips: number
  layer1Rate: number
  layer1Fee: number
  layer1Iva: number
  netAfterLayer1: number
  layer2Rate: number
  layer2Fee: number
  netToVenue: number
  referredBy: string
  externalShare: number
  aggregatorShare: number
}

export interface VenueBreakdown {
  venueName: string
  referredBy: string
  txCount: number
  grossAmount: number
  tips: number
  layer1Fee: number
  layer1Iva: number
  netAfterLayer1: number
  layer2Fee: number
  netToVenue: number
  externalShare: number
  aggregatorShare: number
}

export interface GrandTotals {
  txCount: number
  grossAmount: number
  tips: number
  layer1Fee: number
  layer1Iva: number
  layer2Fee: number
  netToVenue: number
  externalShare: number
  aggregatorShare: number
}

// ─── Pure calculation functions ───

const round2 = (n: number) => Math.round(n * 100) / 100

const SPLIT_RATIOS: Record<string, { external: number; aggregator: number }> = {
  EXTERNAL: { external: 0.7, aggregator: 0.3 },
  AGGREGATOR: { external: 0.3, aggregator: 0.7 },
}

export function calculateVenueCommissions(rows: RawPaymentRow[]): CommissionRow[] {
  return rows.map(row => {
    const grossAmount = row.gross_amount.toNumber()
    const tips = row.tips.toNumber()
    const layer1Rate = row.base_fee_rate
    const layer2Rate = row.commission_rate.toNumber()
    const referredBy = row.referred_by

    const ivaRate = row.iva_rate

    const layer1Fee = round2(grossAmount * layer1Rate)
    const layer1Iva = round2(layer1Fee * ivaRate)
    const netAfterLayer1 = round2(grossAmount - layer1Fee - layer1Iva)
    const layer2Fee = round2(netAfterLayer1 * layer2Rate)
    const netToVenue = round2(netAfterLayer1 - layer2Fee)

    const split = SPLIT_RATIOS[referredBy] ?? SPLIT_RATIOS.EXTERNAL
    const externalShare = round2(layer2Fee * split.external)
    const aggregatorShare = round2(layer2Fee * split.aggregator)

    return {
      venueName: row.venue_name,
      cardType: row.card_type,
      txCount: Number(row.tx_count),
      grossAmount,
      tips,
      layer1Rate,
      layer1Fee,
      layer1Iva,
      netAfterLayer1,
      layer2Rate,
      layer2Fee,
      netToVenue,
      referredBy,
      externalShare,
      aggregatorShare,
    }
  })
}

export function buildVenueBreakdown(rows: CommissionRow[]): VenueBreakdown[] {
  const map = new Map<string, VenueBreakdown>()

  for (const row of rows) {
    const existing = map.get(row.venueName) ?? {
      venueName: row.venueName,
      referredBy: row.referredBy,
      txCount: 0,
      grossAmount: 0,
      tips: 0,
      layer1Fee: 0,
      layer1Iva: 0,
      netAfterLayer1: 0,
      layer2Fee: 0,
      netToVenue: 0,
      externalShare: 0,
      aggregatorShare: 0,
    }

    existing.txCount += row.txCount
    existing.grossAmount += row.grossAmount
    existing.tips += row.tips
    existing.layer1Fee += row.layer1Fee
    existing.layer1Iva += row.layer1Iva
    existing.netAfterLayer1 += row.netAfterLayer1
    existing.layer2Fee += row.layer2Fee
    existing.netToVenue += row.netToVenue
    existing.externalShare += row.externalShare
    existing.aggregatorShare += row.aggregatorShare
    map.set(row.venueName, existing)
  }

  return Array.from(map.values())
}

export function buildGrandTotals(rows: CommissionRow[]): GrandTotals {
  return rows.reduce(
    (acc, row) => ({
      txCount: acc.txCount + row.txCount,
      grossAmount: acc.grossAmount + row.grossAmount,
      tips: acc.tips + row.tips,
      layer1Fee: acc.layer1Fee + row.layer1Fee,
      layer1Iva: acc.layer1Iva + row.layer1Iva,
      layer2Fee: acc.layer2Fee + row.layer2Fee,
      netToVenue: acc.netToVenue + row.netToVenue,
      externalShare: acc.externalShare + row.externalShare,
      aggregatorShare: acc.aggregatorShare + row.aggregatorShare,
    }),
    {
      txCount: 0,
      grossAmount: 0,
      tips: 0,
      layer1Fee: 0,
      layer1Iva: 0,
      layer2Fee: 0,
      netToVenue: 0,
      externalShare: 0,
      aggregatorShare: 0,
    },
  )
}

// ─── Constants ───

const TIMEZONE = 'America/Mexico_City'
const RECIPIENT = 'jose@avoqado.io'

const CARD_TYPE_LABELS: Record<string, string> = {
  DEBIT: 'Debito',
  CREDIT: 'Credito',
  AMEX: 'AMEX',
  INTERNATIONAL: 'Internacional',
  OTHER: 'Otro',
}

// ─── Job ───

export class VenueCommissionSettlementJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    this.job = new CronJob(
      '0 7 * * *',
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
      logger.info('Venue Commission Settlement Job started — daily at 7:00 AM Mexico City')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Venue Commission Settlement Job stopped')
    }
  }

  async runNow(dateOverride?: string): Promise<void> {
    return this.process(dateOverride)
  }

  private async process(dateOverride?: string): Promise<void> {
    if (this.isRunning) {
      logger.warn('Venue commission settlement already in progress, skipping')
      return
    }

    this.isRunning = true
    const startTime = Date.now()

    try {
      // Determine settlement date (today when no override)
      const today = dateOverride || new Date().toISOString().slice(0, 10)
      const todayDate = new Date(`${today}T12:00:00Z`) // noon UTC avoids DST edge cases

      // D-1 business day → Debit/Credit transactions from this date settle today
      const debitCreditDate = this.subtractBusinessDays(todayDate, 1)
      const dcDateStr = debitCreditDate.toISOString().slice(0, 10)

      // D-3 business days → AMEX/International transactions from this date settle today
      const amexIntlDate = this.subtractBusinessDays(todayDate, 3)
      const aiDateStr = amexIntlDate.toISOString().slice(0, 10)

      logger.info('Generating venue commission settlement report', {
        settlementDate: today,
        debitCreditDate: dcDateStr,
        amexIntlDate: aiDateStr,
      })

      const aggregator = await prisma.aggregator.findFirst({
        where: { active: true },
        select: { id: true, name: true, baseFees: true, ivaRate: true },
      })
      if (!aggregator) {
        logger.info('No active aggregator found, skipping venue commission report')
        return
      }

      const baseFees = aggregator.baseFees as Record<string, number>
      const ivaRate = Number(aggregator.ivaRate)

      // Query both date ranges with respective card type filters
      const dcRange = this.getDateRange(dcDateStr)
      const aiRange = this.getDateRange(aiDateStr)

      const dcRows = await this.queryPayments(dcRange.startUTC, dcRange.endUTC, aggregator.id, baseFees, ivaRate, ['DEBIT', 'CREDIT'])
      const aiRows = await this.queryPayments(aiRange.startUTC, aiRange.endUTC, aggregator.id, baseFees, ivaRate, ['AMEX', 'INTERNATIONAL'])

      const rawRows = [...dcRows, ...aiRows]

      if (rawRows.length === 0) {
        logger.info('No venue commission transactions for settlement date ' + today, {
          debitCreditDate: dcDateStr,
          amexIntlDate: aiDateStr,
        })
        return
      }

      const commissionRows = calculateVenueCommissions(rawRows)
      const venueBreakdown = buildVenueBreakdown(commissionRows)
      const grandTotals = buildGrandTotals(commissionRows)

      const html = this.generateEmailHTML(today, dcDateStr, aiDateStr, aggregator.name, commissionRows, venueBreakdown, grandTotals)
      const excelBuffer = this.generateExcel(today, aggregator.name, commissionRows, venueBreakdown, grandTotals)

      await emailService.sendEmail({
        to: RECIPIENT,
        subject: `[${aggregator.name}] Comisiones por Venue — Liquidación ${today}`,
        html,
        attachments: [
          {
            filename: `${aggregator.name}_Comisiones_Venue_${today}.xls`,
            content: excelBuffer,
            contentType: 'application/vnd.ms-excel',
          },
        ],
      })

      logger.info('Venue commission settlement report sent', {
        settlementDate: today,
        debitCreditDate: dcDateStr,
        amexIntlDate: aiDateStr,
        aggregator: aggregator.name,
        venues: venueBreakdown.length,
        transactions: grandTotals.txCount,
        totalLayer2: grandTotals.layer2Fee.toFixed(2),
        externalTotal: grandTotals.externalShare.toFixed(2),
        aggregatorTotal: grandTotals.aggregatorShare.toFixed(2),
        durationMs: Date.now() - startTime,
      })
    } catch (error) {
      logger.error('Venue commission settlement report failed', {
        error: error instanceof Error ? error.message : error,
      })
    } finally {
      this.isRunning = false
    }
  }

  /** Subtract N business days from a date (skip weekends) */
  private subtractBusinessDays(date: Date, days: number): Date {
    const result = new Date(date)
    let subtracted = 0
    while (subtracted < days) {
      result.setDate(result.getDate() - 1)
      // 0=Sun, 6=Sat — skip weekends
      if (result.getDay() !== 0 && result.getDay() !== 6) {
        subtracted++
      }
    }
    return result
  }

  /** Convert a YYYY-MM-DD date string to a UTC range using Mexico City midnight boundaries */
  private getDateRange(dateStr: string): { startUTC: Date; endUTC: Date } {
    const startUTC = fromZonedTime(new Date(`${dateStr}T00:00:00`), TIMEZONE)
    const endUTC = fromZonedTime(new Date(`${dateStr}T23:59:59.999`), TIMEZONE)
    return { startUTC, endUTC }
  }

  private async queryPayments(
    startUTC: Date,
    endUTC: Date,
    aggregatorId: string,
    baseFees: Record<string, number>,
    ivaRate: number,
    cardTypes: string[],
  ): Promise<RawPaymentRow[]> {
    const rows = await prisma.$queryRaw<
      Array<{
        venue_name: string
        card_type: string
        tx_count: bigint
        gross_amount: Decimal
        tips: Decimal
        commission_rate: Decimal
        referred_by: string
      }>
    >`
      SELECT
        v.name as venue_name,
        tc."transactionType" as card_type,
        COUNT(p.id) as tx_count,
        COALESCE(SUM(p.amount), 0) as gross_amount,
        COALESCE(SUM(p."tipAmount"), 0) as tips,
        vc.rate as commission_rate,
        vc."referredBy" as referred_by
      FROM "Payment" p
      JOIN "TransactionCost" tc ON tc."paymentId" = p.id
      JOIN "MerchantAccount" ma ON p."merchantAccountId" = ma.id
      JOIN "Venue" v ON p."venueId" = v.id
      JOIN "VenueCommission" vc ON vc."venueId" = v.id AND vc."aggregatorId" = ${aggregatorId}
      WHERE ma."aggregatorId" = ${aggregatorId}
        AND vc.active = true
        AND p.status = 'COMPLETED'
        AND p."createdAt" >= ${startUTC}
        AND p."createdAt" <= ${endUTC}
        AND tc."transactionType"::text IN (${Prisma.join(cardTypes)})
      GROUP BY v.name, tc."transactionType", vc.rate, vc."referredBy"
      ORDER BY v.name, tc."transactionType"
    `

    return rows.map(row => ({
      ...row,
      base_fee_rate: baseFees[row.card_type] ?? baseFees['OTHER'] ?? 0.025,
      iva_rate: ivaRate,
    }))
  }

  private generateEmailHTML(
    settlementDate: string,
    dcDateStr: string,
    aiDateStr: string,
    aggregatorName: string,
    rows: CommissionRow[],
    venueBreakdown: VenueBreakdown[],
    grandTotals: GrandTotals,
  ): string {
    const fmt = (n: number) => '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const pct = (n: number) => (n * 100).toFixed(2) + '%'

    const detailRows = rows
      .map(
        r => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${r.venueName}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${CARD_TYPE_LABELS[r.cardType] || r.cardType}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${r.txCount}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmt(r.grossAmount)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${pct(r.layer1Rate)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#e53e3e">${fmt(r.layer1Fee)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#e53e3e">${fmt(r.layer1Iva)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmt(r.netAfterLayer1)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${pct(r.layer2Rate)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#e53e3e">${fmt(r.layer2Fee)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:#38a169">${fmt(r.netToVenue)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;font-size:11px">${r.referredBy === 'EXTERNAL' ? '70/30' : '30/70'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#3182ce">${fmt(r.externalShare)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#805ad5">${fmt(r.aggregatorShare)}</td>
      </tr>`,
      )
      .join('')

    const venueRows = venueBreakdown
      .map(
        v => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600">${v.venueName}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;font-size:11px">${v.referredBy === 'EXTERNAL' ? 'Externo' : 'Agregador'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${v.txCount}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmt(v.grossAmount)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#e53e3e">${fmt(v.layer1Fee)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#e53e3e">${fmt(v.layer1Iva)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#e53e3e">${fmt(v.layer2Fee)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:#38a169">${fmt(v.netToVenue)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#3182ce">${fmt(v.externalShare)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#805ad5">${fmt(v.aggregatorShare)}</td>
      </tr>`,
      )
      .join('')

    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#f7f7f7">
<div style="max-width:1100px;margin:0 auto;padding:24px">

  <div style="background:#2d1b69;color:white;padding:24px 32px;border-radius:12px 12px 0 0">
    <h1 style="margin:0;font-size:20px">Comisiones por Venue — ${aggregatorName}</h1>
    <p style="margin:4px 0 0;opacity:0.8;font-size:14px">Liquidación ${settlementDate}</p>
    <p style="margin:4px 0 0;opacity:0.7;font-size:12px">Déb/Créd: transacciones del ${dcDateStr} (D+1) &nbsp;|&nbsp; AMEX/Intl: transacciones del ${aiDateStr} (D+3)</p>
  </div>

  <div style="background:white;padding:24px 32px;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,0.08)">

    <div style="display:flex;gap:16px;margin-bottom:24px">
      <div style="flex:1;background:#f0fff4;border:1px solid #c6f6d5;border-radius:8px;padding:16px">
        <p style="margin:0;font-size:12px;color:#718096">Neto a Venues</p>
        <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#38a169">${fmt(grandTotals.netToVenue)}</p>
      </div>
      <div style="flex:1;background:#ebf8ff;border:1px solid #bee3f8;border-radius:8px;padding:16px">
        <p style="margin:0;font-size:12px;color:#718096">Externo (Avoqado)</p>
        <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#3182ce">${fmt(grandTotals.externalShare)}</p>
      </div>
      <div style="flex:1;background:#faf5ff;border:1px solid #e9d8fd;border-radius:8px;padding:16px">
        <p style="margin:0;font-size:12px;color:#718096">Agregador (${aggregatorName})</p>
        <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#805ad5">${fmt(grandTotals.aggregatorShare)}</p>
      </div>
      <div style="flex:1;background:#fff5f5;border:1px solid #fed7d7;border-radius:8px;padding:16px">
        <p style="margin:0;font-size:12px;color:#718096">Comision L2 Total</p>
        <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#e53e3e">${fmt(grandTotals.layer2Fee)}</p>
        <p style="margin:4px 0 0;font-size:11px;color:#718096">${grandTotals.txCount} txns | Bruto: ${fmt(grandTotals.grossAmount)}</p>
      </div>
      <div style="flex:1;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:16px">
        <p style="margin:0;font-size:12px;color:#718096">IVA L1 Total</p>
        <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#d97706">${fmt(grandTotals.layer1Iva)}</p>
      </div>
    </div>

    <h3 style="margin:0 0 12px;font-size:15px;color:#2d3748">Desglose por Venue y Tipo de Tarjeta</h3>
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="background:#f7fafc">
          <th style="padding:8px;text-align:left;border-bottom:2px solid #e2e8f0">Venue</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #e2e8f0">Tipo</th>
          <th style="padding:8px;text-align:center;border-bottom:2px solid #e2e8f0">#</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e2e8f0">Bruto</th>
          <th style="padding:8px;text-align:center;border-bottom:2px solid #e2e8f0">Tasa L1</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e2e8f0">Fee L1</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e2e8f0">IVA L1</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e2e8f0">Neto L1</th>
          <th style="padding:8px;text-align:center;border-bottom:2px solid #e2e8f0">Tasa L2</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e2e8f0">Fee L2</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e2e8f0">Neto Venue</th>
          <th style="padding:8px;text-align:center;border-bottom:2px solid #e2e8f0">Split</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e2e8f0">Externo</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e2e8f0">Agregador</th>
        </tr>
      </thead>
      <tbody>${detailRows}</tbody>
    </table>
    </div>

    <h3 style="margin:24px 0 12px;font-size:15px;color:#2d3748">Resumen por Venue</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#f7fafc">
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Venue</th>
          <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #e2e8f0">Referido</th>
          <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #e2e8f0"># Txns</th>
          <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Bruto</th>
          <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Fee L1</th>
          <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e2e8f0">IVA L1</th>
          <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Fee L2</th>
          <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Neto Venue</th>
          <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Externo</th>
          <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Agregador</th>
        </tr>
      </thead>
      <tbody>${venueRows}</tbody>
    </table>

    <p style="margin:24px 0 0;font-size:11px;color:#a0aec0;text-align:center">
      Generado automaticamente por Avoqado | Split: Externo 70/30 | Agregador 30/70
    </p>
  </div>
</div>
</body>
</html>`
  }

  private generateExcel(
    dateStr: string,
    aggregatorName: string,
    rows: CommissionRow[],
    venueBreakdown: VenueBreakdown[],
    grandTotals: GrandTotals,
  ): Buffer {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const numCell = (n: number) => `<Cell><Data ss:Type="Number">${round2(n)}</Data></Cell>`
    const strCell = (s: string) => `<Cell><Data ss:Type="String">${esc(s)}</Data></Cell>`

    const detailRows = rows
      .map(
        r =>
          `<Row>${strCell(r.venueName)}${strCell(CARD_TYPE_LABELS[r.cardType] || r.cardType)}${numCell(r.txCount)}${numCell(r.grossAmount)}${strCell((r.layer1Rate * 100).toFixed(1) + '%')}${numCell(r.layer1Fee)}${numCell(r.layer1Iva)}${numCell(r.netAfterLayer1)}${strCell((r.layer2Rate * 100).toFixed(2) + '%')}${numCell(r.layer2Fee)}${numCell(r.netToVenue)}${strCell(r.referredBy === 'EXTERNAL' ? '70/30' : '30/70')}${numCell(r.externalShare)}${numCell(r.aggregatorShare)}</Row>`,
      )
      .join('\n')

    const totalRow = `<Row ss:StyleID="Total">${strCell('TOTAL')}${strCell('')}${numCell(grandTotals.txCount)}${numCell(grandTotals.grossAmount)}${strCell('')}${numCell(grandTotals.layer1Fee)}${numCell(grandTotals.layer1Iva)}${strCell('')}${strCell('')}${numCell(grandTotals.layer2Fee)}${numCell(grandTotals.netToVenue)}${strCell('')}${numCell(grandTotals.externalShare)}${numCell(grandTotals.aggregatorShare)}</Row>`

    const venueRows = venueBreakdown
      .map(
        v =>
          `<Row>${strCell(v.venueName)}${strCell(v.referredBy === 'EXTERNAL' ? 'Externo' : 'Agregador')}${numCell(v.txCount)}${numCell(v.grossAmount)}${numCell(v.layer1Fee)}${numCell(v.layer1Iva)}${numCell(v.layer2Fee)}${numCell(v.netToVenue)}${numCell(v.externalShare)}${numCell(v.aggregatorShare)}</Row>`,
      )
      .join('\n')

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
  <Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#F0F0F0" ss:Pattern="Solid"/></Style>
  <Style ss:ID="Total"><Font ss:Bold="1"/><Interior ss:Color="#E8F5E9" ss:Pattern="Solid"/></Style>
</Styles>
<Worksheet ss:Name="Desglose">
  <Table>
    <Column ss:Width="140"/><Column ss:Width="80"/><Column ss:Width="40"/><Column ss:Width="90"/><Column ss:Width="60"/><Column ss:Width="80"/><Column ss:Width="70"/><Column ss:Width="90"/><Column ss:Width="60"/><Column ss:Width="80"/><Column ss:Width="90"/><Column ss:Width="50"/><Column ss:Width="80"/><Column ss:Width="80"/>
    <Row ss:StyleID="Header">
      ${strCell('Venue')}${strCell('Tipo')}${strCell('#')}${strCell('Bruto')}${strCell('Tasa L1')}${strCell('Fee L1')}${strCell('IVA L1')}${strCell('Neto L1')}${strCell('Tasa L2')}${strCell('Fee L2')}${strCell('Neto Venue')}${strCell('Split')}${strCell('Externo')}${strCell('Agregador')}
    </Row>
    ${detailRows}
    ${totalRow}
  </Table>
</Worksheet>
<Worksheet ss:Name="Resumen por Venue">
  <Table>
    <Column ss:Width="140"/><Column ss:Width="80"/><Column ss:Width="40"/><Column ss:Width="90"/><Column ss:Width="80"/><Column ss:Width="70"/><Column ss:Width="80"/><Column ss:Width="90"/><Column ss:Width="80"/><Column ss:Width="80"/>
    <Row ss:StyleID="Header">
      ${strCell('Venue')}${strCell('Referido')}${strCell('# Txns')}${strCell('Bruto')}${strCell('Fee L1')}${strCell('IVA L1')}${strCell('Fee L2')}${strCell('Neto Venue')}${strCell('Externo')}${strCell('Agregador')}
    </Row>
    ${venueRows}
  </Table>
</Worksheet>
</Workbook>`

    return Buffer.from('\uFEFF' + xml, 'utf-8')
  }
}

export const venueCommissionSettlementJob = new VenueCommissionSettlementJob()
