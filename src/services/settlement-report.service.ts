import { Decimal } from '@prisma/client/runtime/library'
import { fromZonedTime } from 'date-fns-tz'
import prisma from '../utils/prismaClient'
import {
  calculateVenueCommissions,
  buildVenueBreakdown,
  buildGrandTotals,
  type RawPaymentRow,
  type CommissionRow,
  type VenueBreakdown,
  type GrandTotals,
} from '../jobs/venue-commission-settlement.job'

const TIMEZONE = 'America/Mexico_City'

interface SettlementReportData {
  aggregatorName: string
  ivaRate: number
  baseFees: Record<string, number>
  dateFrom: string
  dateTo: string
  rows: CommissionRow[]
  venueBreakdown: VenueBreakdown[]
  grandTotals: GrandTotals
}

// Layer 1 row (base fees report)
interface Layer1Row {
  venueName: string
  tpvSerial: string
  cardType: string
  txCount: number
  grossAmount: number
  tips: number
  rate: number
  fee: number
  ivaFee: number
  netAmount: number
}

interface Layer1ReportData {
  aggregatorName: string
  ivaRate: number
  baseFees: Record<string, number>
  dateFrom: string
  dateTo: string
  rows: Layer1Row[]
  venueSummaries: Array<{
    venueName: string
    tpvSerial: string
    txCount: number
    grossAmount: number
    tips: number
    totalFees: number
    totalIva: number
    netAmount: number
  }>
  grandTotal: {
    txCount: number
    grossAmount: number
    tips: number
    totalFees: number
    totalIva: number
    netAmount: number
  }
}

export async function validateReportToken(token: string) {
  return prisma.aggregator.findUnique({
    where: { reportToken: token },
    select: { id: true, name: true, baseFees: true, ivaRate: true, active: true },
  })
}

export async function generateReportToken(aggregatorId: string): Promise<string> {
  const token = require('crypto').randomBytes(32).toString('hex')
  await prisma.aggregator.update({
    where: { id: aggregatorId },
    data: { reportToken: token },
  })
  return token
}

export async function revokeReportToken(aggregatorId: string): Promise<void> {
  await prisma.aggregator.update({
    where: { id: aggregatorId },
    data: { reportToken: null },
  })
}

function getDateRange(dateStr: string): { startUTC: Date; endUTC: Date } {
  const startUTC = fromZonedTime(new Date(`${dateStr}T00:00:00`), TIMEZONE)
  const endUTC = fromZonedTime(new Date(`${dateStr}T23:59:59.999`), TIMEZONE)
  return { startUTC, endUTC }
}

export async function getLayer1Report(aggregatorId: string, dateFrom: string, dateTo: string): Promise<Layer1ReportData | null> {
  const aggregator = await prisma.aggregator.findUnique({
    where: { id: aggregatorId },
    select: { name: true, baseFees: true, ivaRate: true },
  })
  if (!aggregator) return null

  const baseFees = (aggregator.baseFees ?? {}) as Record<string, number>
  const ivaRate = Number(aggregator.ivaRate ?? 0)

  const { startUTC } = getDateRange(dateFrom)
  const { endUTC } = getDateRange(dateTo)

  const rawRows = await prisma.$queryRaw<
    Array<{
      venue_name: string
      card_type: string
      tx_count: bigint
      gross_amount: Decimal
      tips: Decimal
      tpv_serial: string
    }>
  >`
    SELECT
      v.name as venue_name,
      tc."transactionType" as card_type,
      COUNT(p.id) as tx_count,
      COALESCE(SUM(p.amount), 0) as gross_amount,
      COALESCE(SUM(p."tipAmount"), 0) as tips,
      STRING_AGG(DISTINCT ma."blumonSerialNumber", ', ') as tpv_serial
    FROM "Payment" p
    JOIN "TransactionCost" tc ON tc."paymentId" = p.id
    JOIN "MerchantAccount" ma ON p."merchantAccountId" = ma.id
    JOIN "Venue" v ON p."venueId" = v.id
    WHERE ma."aggregatorId" = ${aggregatorId}
      AND p.status = 'COMPLETED'
      AND p."createdAt" >= ${startUTC}
      AND p."createdAt" <= ${endUTC}
    GROUP BY v.name, tc."transactionType"
    ORDER BY v.name, tc."transactionType"
  `

  const round2 = (n: number) => Math.round(n * 100) / 100

  const rows: Layer1Row[] = rawRows.map(row => {
    const grossAmount = row.gross_amount.toNumber()
    const tips = row.tips.toNumber()
    const rate = baseFees[row.card_type] ?? baseFees['OTHER'] ?? 0.025
    const fee = round2(grossAmount * rate)
    const ivaFee = round2(fee * ivaRate)
    const netAmount = round2(grossAmount - fee - ivaFee)
    return {
      venueName: row.venue_name,
      tpvSerial: row.tpv_serial || '',
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

  // Build venue summaries
  const venueMap = new Map<
    string,
    {
      venueName: string
      tpvSerial: string
      txCount: number
      grossAmount: number
      tips: number
      totalFees: number
      totalIva: number
      netAmount: number
    }
  >()
  for (const row of rows) {
    const existing = venueMap.get(row.venueName) || {
      venueName: row.venueName,
      tpvSerial: row.tpvSerial,
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
    venueMap.set(row.venueName, existing)
  }

  const grandTotal = rows.reduce(
    (acc, r) => ({
      txCount: acc.txCount + r.txCount,
      grossAmount: acc.grossAmount + r.grossAmount,
      tips: acc.tips + r.tips,
      totalFees: acc.totalFees + r.fee,
      totalIva: acc.totalIva + r.ivaFee,
      netAmount: acc.netAmount + r.netAmount,
    }),
    { txCount: 0, grossAmount: 0, tips: 0, totalFees: 0, totalIva: 0, netAmount: 0 },
  )

  return {
    aggregatorName: aggregator.name,
    ivaRate,
    baseFees,
    dateFrom,
    dateTo,
    rows,
    venueSummaries: Array.from(venueMap.values()),
    grandTotal,
  }
}

export async function getLayer2Report(aggregatorId: string, dateFrom: string, dateTo: string): Promise<SettlementReportData | null> {
  const aggregator = await prisma.aggregator.findUnique({
    where: { id: aggregatorId },
    select: { name: true, baseFees: true, ivaRate: true },
  })
  if (!aggregator) return null

  const baseFees = (aggregator.baseFees ?? {}) as Record<string, number>
  const ivaRate = Number(aggregator.ivaRate ?? 0)

  const { startUTC } = getDateRange(dateFrom)
  const { endUTC } = getDateRange(dateTo)

  const rawRows = await prisma.$queryRaw<
    Array<{
      venue_name: string
      card_type: string
      tx_count: bigint
      gross_amount: Decimal
      tips: Decimal
      commission_rate: Decimal
      referred_by: string
      tpv_serial: string
    }>
  >`
    SELECT
      v.name as venue_name,
      tc."transactionType" as card_type,
      COUNT(p.id) as tx_count,
      COALESCE(SUM(p.amount), 0) as gross_amount,
      COALESCE(SUM(p."tipAmount"), 0) as tips,
      vc.rate as commission_rate,
      vc."referredBy" as referred_by,
      STRING_AGG(DISTINCT ma."blumonSerialNumber", ', ') as tpv_serial
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
    GROUP BY v.name, tc."transactionType", vc.rate, vc."referredBy"
    ORDER BY v.name, tc."transactionType"
  `

  const enrichedRows: RawPaymentRow[] = rawRows.map(row => ({
    ...row,
    tpv_serial: row.tpv_serial || '',
    base_fee_rate: baseFees[row.card_type] ?? baseFees['OTHER'] ?? 0.025,
    iva_rate: ivaRate,
  }))

  const commissionRows = calculateVenueCommissions(enrichedRows)
  const venueBreakdown = buildVenueBreakdown(commissionRows)
  const grandTotals = buildGrandTotals(commissionRows)

  return {
    aggregatorName: aggregator.name,
    ivaRate,
    baseFees,
    dateFrom,
    dateTo,
    rows: commissionRows,
    venueBreakdown,
    grandTotals,
  }
}
