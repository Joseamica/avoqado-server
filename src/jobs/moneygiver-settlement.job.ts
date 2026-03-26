/**
 * Moneygiver Daily Settlement Report
 *
 * Sends a daily email at 7:00 AM Mexico City time with the previous day's
 * transaction breakdown for all Moneygiver merchant accounts.
 *
 * Applies Avoqado's rates (not Blumon's) to calculate dispersal amounts:
 * - Debit: 2.5%
 * - Credit: 2.5%
 * - AMEX: 3.3%
 * - International: 3.3%
 */

import { CronJob } from 'cron'
import { Decimal } from '@prisma/client/runtime/library'
import { fromZonedTime } from 'date-fns-tz'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import emailService from '../services/email.service'

// ─── Constants ───

const TIMEZONE = 'America/Mexico_City'
const RECIPIENT = 'jose@avoqado.io'
const RATES: Record<string, number> = {
  DEBIT: 0.025,
  CREDIT: 0.025,
  AMEX: 0.033,
  INTERNATIONAL: 0.033,
  OTHER: 0.025,
}

const CARD_TYPE_LABELS: Record<string, string> = {
  DEBIT: 'Débito',
  CREDIT: 'Crédito',
  AMEX: 'AMEX',
  INTERNATIONAL: 'Internacional',
  OTHER: 'Otro',
}

// ─── Types ───

interface SettlementRow {
  venueName: string
  cardType: string
  txCount: number
  grossAmount: number
  tips: number
  rate: number
  fee: number
  ivaFee: number
  netAmount: number
}

interface VenueSummary {
  venueName: string
  txCount: number
  grossAmount: number
  tips: number
  totalFees: number
  totalIva: number
  netAmount: number
}

// ─── Job ───

export class MoneygiverSettlementJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    this.job = new CronJob(
      '0 7 * * *', // 7:00 AM every day
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
      logger.info('💰 Moneygiver Settlement Report Job started — daily at 7:00 AM Mexico City')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('💰 Moneygiver Settlement Report Job stopped')
    }
  }

  /** Run manually (for testing or on-demand) */
  async runNow(dateOverride?: string): Promise<void> {
    return this.process(dateOverride)
  }

  // ─── Core logic ───

  private async process(dateOverride?: string): Promise<void> {
    if (this.isRunning) {
      logger.warn('💰 Moneygiver settlement report already in progress, skipping')
      return
    }

    this.isRunning = true
    const startTime = Date.now()

    try {
      // Calculate yesterday's date range in Mexico City timezone → UTC
      const { startUTC, endUTC, dateStr } = this.getDateRange(dateOverride)

      logger.info('💰 Generating Moneygiver settlement report', {
        date: dateStr,
        startUTC: startUTC.toISOString(),
        endUTC: endUTC.toISOString(),
      })

      // Query payments grouped by venue + card type
      const { rows, ivaRate } = await this.queryPayments(startUTC, endUTC)

      if (rows.length === 0) {
        logger.info('💰 No Moneygiver transactions for ' + dateStr)
        return
      }

      // Calculate fees and net amounts
      const settlementRows = this.calculateSettlement(rows, ivaRate)
      const venueSummaries = this.buildVenueSummaries(settlementRows)
      const grandTotal = this.buildGrandTotal(settlementRows)

      // Generate email HTML
      const html = this.generateEmailHTML(dateStr, settlementRows, venueSummaries, grandTotal)

      // Generate Excel attachment
      const excelBuffer = this.generateExcel(dateStr, settlementRows, venueSummaries, grandTotal)

      // Send email with Excel attachment
      await emailService.sendEmail({
        to: RECIPIENT,
        subject: `[Moneygiver] Reporte de Dispersión — ${dateStr}`,
        html,
        attachments: [
          {
            filename: `Moneygiver_Dispersion_${dateStr}.xls`,
            content: excelBuffer,
            contentType: 'application/vnd.ms-excel',
          },
        ],
      })

      logger.info('💰 Moneygiver settlement report sent', {
        date: dateStr,
        venues: venueSummaries.length,
        transactions: grandTotal.txCount,
        grossTotal: grandTotal.grossAmount.toFixed(2),
        netTotal: grandTotal.netAmount.toFixed(2),
        durationMs: Date.now() - startTime,
      })
    } catch (error) {
      logger.error('💰 Moneygiver settlement report failed', {
        error: error instanceof Error ? error.message : error,
      })
    } finally {
      this.isRunning = false
    }
  }

  // ─── Date range ───

  private getDateRange(dateOverride?: string): { startUTC: Date; endUTC: Date; dateStr: string } {
    let dateStr: string

    if (dateOverride) {
      dateStr = dateOverride // format: YYYY-MM-DD
    } else {
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(now.getDate() - 1)
      dateStr = yesterday.toISOString().slice(0, 10)
    }

    // Convert Mexico City midnight → UTC
    const startUTC = fromZonedTime(new Date(`${dateStr}T00:00:00`), TIMEZONE)
    const endUTC = fromZonedTime(new Date(`${dateStr}T23:59:59.999`), TIMEZONE)

    return { startUTC, endUTC, dateStr }
  }

  // ─── Query ───

  private async queryPayments(
    startUTC: Date,
    endUTC: Date,
  ): Promise<{
    rows: Array<{ venue_name: string; card_type: string; tx_count: bigint; gross_amount: Decimal; tips: Decimal }>
    ivaRate: number
  }> {
    // Find the active aggregator by FK instead of ILIKE on displayName
    const aggregator = await prisma.aggregator.findFirst({
      where: { active: true },
      select: { id: true, ivaRate: true },
    })

    if (!aggregator) {
      logger.info('💰 No active aggregator found, returning empty results')
      return { rows: [], ivaRate: 0 }
    }

    const ivaRate = Number(aggregator.ivaRate ?? 0)

    const rows = await prisma.$queryRaw<
      Array<{
        venue_name: string
        card_type: string
        tx_count: bigint
        gross_amount: Decimal
        tips: Decimal
      }>
    >`
      SELECT
        v.name as venue_name,
        tc."transactionType" as card_type,
        COUNT(p.id) as tx_count,
        COALESCE(SUM(p.amount), 0) as gross_amount,
        COALESCE(SUM(p."tipAmount"), 0) as tips
      FROM "Payment" p
      JOIN "TransactionCost" tc ON tc."paymentId" = p.id
      JOIN "MerchantAccount" ma ON p."merchantAccountId" = ma.id
      JOIN "Venue" v ON p."venueId" = v.id
      WHERE ma."aggregatorId" = ${aggregator.id}
        AND p.status = 'COMPLETED'
        AND p."createdAt" >= ${startUTC}
        AND p."createdAt" <= ${endUTC}
      GROUP BY v.name, tc."transactionType"
      ORDER BY v.name, tc."transactionType"
    `

    return { rows, ivaRate }
  }

  // ─── Settlement calculation ───

  private calculateSettlement(
    rows: Array<{ venue_name: string; card_type: string; tx_count: bigint; gross_amount: Decimal; tips: Decimal }>,
    ivaRate: number,
  ): SettlementRow[] {
    return rows.map(row => {
      const grossAmount = Number(row.gross_amount)
      const tips = Number(row.tips)
      const rate = RATES[row.card_type] ?? RATES.OTHER
      const fee = Math.round(grossAmount * rate * 100) / 100
      const ivaFee = Math.round(fee * ivaRate * 100) / 100
      const netAmount = Math.round((grossAmount - fee - ivaFee) * 100) / 100

      return {
        venueName: row.venue_name,
        cardType: row.card_type,
        txCount: Number(row.tx_count),
        grossAmount,
        tips,
        rate,
        fee,
        ivaFee,
        netAmount,
      }
    })
  }

  private buildVenueSummaries(rows: SettlementRow[]): VenueSummary[] {
    const map = new Map<string, VenueSummary>()

    for (const row of rows) {
      const existing = map.get(row.venueName) || {
        venueName: row.venueName,
        txCount: 0,
        grossAmount: 0,
        tips: 0,
        totalFees: 0,
        totalIva: 0,
        netAmount: 0,
      }

      existing.txCount += row.txCount
      existing.grossAmount += row.grossAmount
      existing.tips += row.tips
      existing.totalFees += row.fee
      existing.totalIva += row.ivaFee
      existing.netAmount += row.netAmount
      map.set(row.venueName, existing)
    }

    return Array.from(map.values())
  }

  private buildGrandTotal(rows: SettlementRow[]): VenueSummary {
    return rows.reduce(
      (acc, row) => ({
        venueName: 'TOTAL',
        txCount: acc.txCount + row.txCount,
        grossAmount: acc.grossAmount + row.grossAmount,
        tips: acc.tips + row.tips,
        totalFees: acc.totalFees + row.fee,
        totalIva: acc.totalIva + row.ivaFee,
        netAmount: acc.netAmount + row.netAmount,
      }),
      { venueName: 'TOTAL', txCount: 0, grossAmount: 0, tips: 0, totalFees: 0, totalIva: 0, netAmount: 0 },
    )
  }

  // ─── Email HTML ───

  private generateEmailHTML(dateStr: string, rows: SettlementRow[], venueSummaries: VenueSummary[], grandTotal: VenueSummary): string {
    const fmt = (n: number) => '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const pct = (n: number) => (n * 100).toFixed(1) + '%'

    const detailRows = rows
      .map(
        r => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${r.venueName}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${CARD_TYPE_LABELS[r.cardType] || r.cardType}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${r.txCount}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmt(r.grossAmount)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmt(r.tips)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${pct(r.rate)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#e53e3e">${fmt(r.fee)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#e53e3e">${fmt(r.ivaFee)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:#38a169">${fmt(r.netAmount)}</td>
      </tr>`,
      )
      .join('')

    const venueRows = venueSummaries
      .map(
        v => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600">${v.venueName}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${v.txCount}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmt(v.grossAmount)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmt(v.tips)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#e53e3e">${fmt(v.totalFees)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#e53e3e">${fmt(v.totalIva)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:#38a169">${fmt(v.netAmount)}</td>
      </tr>`,
      )
      .join('')

    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#f7f7f7">
<div style="max-width:900px;margin:0 auto;padding:24px">

  <div style="background:#1a1a2e;color:white;padding:24px 32px;border-radius:12px 12px 0 0">
    <h1 style="margin:0;font-size:20px">💰 Reporte de Dispersión Moneygiver</h1>
    <p style="margin:4px 0 0;opacity:0.8;font-size:14px">Transacciones del ${dateStr}</p>
  </div>

  <div style="background:white;padding:24px 32px;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,0.08)">

    <!-- Grand Total Banner -->
    <div style="background:#f0fff4;border:1px solid #c6f6d5;border-radius:8px;padding:16px 24px;margin-bottom:24px;display:flex;justify-content:space-between">
      <div>
        <p style="margin:0;font-size:13px;color:#718096">Total a Dispersar</p>
        <p style="margin:4px 0 0;font-size:28px;font-weight:700;color:#38a169">${fmt(grandTotal.netAmount)}</p>
      </div>
      <div style="text-align:right">
        <p style="margin:0;font-size:13px;color:#718096">Monto Bruto: ${fmt(grandTotal.grossAmount)}</p>
        <p style="margin:4px 0 0;font-size:13px;color:#e53e3e">Comisiones: -${fmt(grandTotal.totalFees)}</p>
        <p style="margin:4px 0 0;font-size:13px;color:#e53e3e">IVA: -${fmt(grandTotal.totalIva)}</p>
        <p style="margin:4px 0 0;font-size:13px;color:#718096">${grandTotal.txCount} transacciones</p>
      </div>
    </div>

    <!-- Detail Table -->
    <h3 style="margin:0 0 12px;font-size:15px;color:#2d3748">Desglose por Venue y Tipo de Tarjeta</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#f7fafc">
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Venue</th>
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Tipo</th>
          <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e2e8f0"># Txns</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Bruto</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Propinas</th>
          <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e2e8f0">Tasa</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Comisión</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e2e8f0">IVA</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Neto</th>
        </tr>
      </thead>
      <tbody>${detailRows}</tbody>
      <tfoot>
        <tr style="background:#f7fafc;font-weight:700">
          <td style="padding:10px 12px;border-top:2px solid #e2e8f0" colspan="2">TOTAL</td>
          <td style="padding:10px 12px;border-top:2px solid #e2e8f0;text-align:center">${grandTotal.txCount}</td>
          <td style="padding:10px 12px;border-top:2px solid #e2e8f0;text-align:right">${fmt(grandTotal.grossAmount)}</td>
          <td style="padding:10px 12px;border-top:2px solid #e2e8f0;text-align:right">${fmt(grandTotal.tips)}</td>
          <td style="padding:10px 12px;border-top:2px solid #e2e8f0;text-align:center">—</td>
          <td style="padding:10px 12px;border-top:2px solid #e2e8f0;text-align:right;color:#e53e3e">${fmt(grandTotal.totalFees)}</td>
          <td style="padding:10px 12px;border-top:2px solid #e2e8f0;text-align:right;color:#e53e3e">${fmt(grandTotal.totalIva)}</td>
          <td style="padding:10px 12px;border-top:2px solid #e2e8f0;text-align:right;color:#38a169">${fmt(grandTotal.netAmount)}</td>
        </tr>
      </tfoot>
    </table>

    <!-- Venue Summary -->
    <h3 style="margin:24px 0 12px;font-size:15px;color:#2d3748">Resumen por Venue</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#f7fafc">
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Venue</th>
          <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e2e8f0"># Txns</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Bruto</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Propinas</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Comisiones</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e2e8f0">IVA</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e2e8f0">Neto a Dispersar</th>
        </tr>
      </thead>
      <tbody>${venueRows}</tbody>
    </table>

    <p style="margin:24px 0 0;font-size:11px;color:#a0aec0;text-align:center">
      Generado automáticamente por Avoqado • Tasas: Débito 2.5% | Crédito 2.5% | AMEX 3.3% | Internacional 3.3% + IVA 16%
    </p>
  </div>
</div>
</body>
</html>`
  }

  // ─── Excel (XML Spreadsheet) ───

  private generateExcel(dateStr: string, rows: SettlementRow[], venueSummaries: VenueSummary[], grandTotal: VenueSummary): Buffer {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const numCell = (n: number) => `<Cell><Data ss:Type="Number">${n}</Data></Cell>`
    const strCell = (s: string) => `<Cell><Data ss:Type="String">${esc(s)}</Data></Cell>`

    // Detail rows
    const detailRows = rows
      .map(
        r =>
          `<Row>${strCell(r.venueName)}${strCell(CARD_TYPE_LABELS[r.cardType] || r.cardType)}${numCell(r.txCount)}${numCell(r.grossAmount)}${numCell(r.tips)}${strCell((r.rate * 100).toFixed(1) + '%')}${numCell(r.fee)}${numCell(r.ivaFee)}${numCell(r.netAmount)}</Row>`,
      )
      .join('\n')

    // Grand total
    const totalRow = `<Row>${strCell('TOTAL')}${strCell('')}${numCell(grandTotal.txCount)}${numCell(grandTotal.grossAmount)}${numCell(grandTotal.tips)}${strCell('—')}${numCell(grandTotal.totalFees)}${numCell(grandTotal.totalIva)}${numCell(grandTotal.netAmount)}</Row>`

    // Venue summary rows
    const venueSummaryRows = venueSummaries
      .map(
        v =>
          `<Row>${strCell(v.venueName)}${numCell(v.txCount)}${numCell(v.grossAmount)}${numCell(v.tips)}${numCell(v.totalFees)}${numCell(v.totalIva)}${numCell(v.netAmount)}</Row>`,
      )
      .join('\n')

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
  <Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#F0F0F0" ss:Pattern="Solid"/></Style>
  <Style ss:ID="Total"><Font ss:Bold="1"/><Interior ss:Color="#E8F5E9" ss:Pattern="Solid"/></Style>
  <Style ss:ID="Currency"><NumberFormat ss:Format="$#,##0.00"/></Style>
</Styles>
<Worksheet ss:Name="Desglose">
  <Table>
    <Column ss:Width="150"/><Column ss:Width="90"/><Column ss:Width="60"/><Column ss:Width="100"/><Column ss:Width="80"/><Column ss:Width="60"/><Column ss:Width="90"/><Column ss:Width="90"/><Column ss:Width="110"/>
    <Row ss:StyleID="Header">
      ${strCell('Venue')}${strCell('Tipo')}${strCell('# Txns')}${strCell('Monto Bruto')}${strCell('Propinas')}${strCell('Tasa')}${strCell('Comisión')}${strCell('IVA')}${strCell('Neto a Dispersar')}
    </Row>
    ${detailRows}
    <Row ss:StyleID="Total">
      ${totalRow.replace('<Row>', '').replace('</Row>', '')}
    </Row>
  </Table>
</Worksheet>
<Worksheet ss:Name="Resumen por Venue">
  <Table>
    <Column ss:Width="150"/><Column ss:Width="60"/><Column ss:Width="100"/><Column ss:Width="80"/><Column ss:Width="90"/><Column ss:Width="90"/><Column ss:Width="110"/>
    <Row ss:StyleID="Header">
      ${strCell('Venue')}${strCell('# Txns')}${strCell('Monto Bruto')}${strCell('Propinas')}${strCell('Comisiones')}${strCell('IVA')}${strCell('Neto a Dispersar')}
    </Row>
    ${venueSummaryRows}
  </Table>
</Worksheet>
</Workbook>`

    return Buffer.from('\uFEFF' + xml, 'utf-8')
  }
}

// Export singleton instance
export const moneygiverSettlementJob = new MoneygiverSettlementJob()
