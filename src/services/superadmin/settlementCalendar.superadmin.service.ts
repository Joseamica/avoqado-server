/**
 * Cross-venue Settlement Calendar (superadmin)
 *
 * Answers the founder's question: "¿cuánto cae, qué día, y de qué venue?" — across
 * ALL venues at once, so nobody has to enter each venue's Saldo Disponible page one
 * by one.
 *
 * ── Why this reuses `projectPaymentSettlement` ──────────────────────────────────
 * This screen REPLACES reading the per-venue page, so its numbers MUST agree with
 * it to the cent. The per-venue page (Saldo Disponible / week strip) recomputes
 * settlement dates LIVE via `projectPaymentSettlement`, because the stored
 * `transaction.estimatedSettlementDate` goes stale (pre-2026-07-04 engine fix,
 * rate corrections, tip edits). So we import that exact helper rather than reading
 * stored dates — anything else would silently disagree with the page it replaces.
 *
 * We deliberately do NOT touch `getSettlementsLandingInWeek` (the per-venue
 * function): per this repo's superadmin namespace rule, reusing a shared helper
 * unmodified is safe, forking is for when behavior must differ. Here the per-payment
 * projection is identical; only the grouping (by venue, over a month) differs.
 *
 * Money is pesos in MAJOR units (1.00 = one peso), never cents.
 * Dates are venue-local calendar days (`yyyy-MM-dd`), never UTC-sliced.
 */

import { PaymentMethod } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'

import { projectPaymentSettlement, type ActiveConfig } from '@/services/dashboard/settlementCalendar.dashboard.service'
import logger from '@/config/logger'
import { DEFAULT_TIMEZONE } from '@/utils/datetime'
import prisma from '@/utils/prismaClient'

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * How far back to look for sales that can still land inside the window.
 * Must be ≥ the largest `settlementDays` in use + weekend/holiday slack. Mirrors
 * the per-venue week strip's constant — keep them in sync or the two screens
 * disagree at the window edges.
 */
const LOOKBACK_DAYS = 21

interface Agg {
  gross: number
  commission: number
  net: number
  count: number
}

export interface CalendarVenue extends Agg {
  venueId: string
  venueName: string
  /**
   * True when the money for this venue-day flowed through a merchant that has an
   * `Aggregator` attached. Best-effort HINT for the operator, not a settled fact:
   * prod data is inconsistent (some aggregator merchants carry the FK, others are
   * only identifiable by a "Externo" naming convention). Never gate money logic on
   * this — it is a badge.
   */
  hasAggregator: boolean
  aggregatorNames: string[]
}

export interface CalendarDay extends Agg {
  date: string
  status: 'settled' | 'today' | 'projected'
  venues: CalendarVenue[]
}

export interface CrossVenueSettlementCalendar {
  from: string
  to: string
  days: CalendarDay[]
  total: Agg
  /** Distinct venues with money landing in the window. */
  venueCount: number
  /**
   * Card money we could NOT place on a landing day — no `transactionCost` yet, or no
   * `SettlementConfiguration` matching merchant × cardType at the sale's date. It
   * belongs to no day, so it is reported separately instead of being silently
   * dropped (which would make the calendar quietly under-report).
   */
  unprojected: { count: number; gross: number }
}

const newAgg = (): Agg => ({ gross: 0, commission: 0, net: 0, count: 0 })

const roundAgg = (a: Agg): Agg => ({
  gross: round2(a.gross),
  commission: round2(a.commission),
  net: round2(a.net),
  count: a.count,
})

/**
 * Card money LANDING between `fromKey` and `toKey` (inclusive, venue-local calendar
 * days), grouped by landing day and then by venue.
 *
 * CASH is excluded on purpose: it never settles — it is already in the venue's till,
 * so it is not money anyone disperses. (In prod, cash is ~72% of payment rows, and
 * all of them carry `merchantAccountId: null`, so they'd be unprojectable noise.)
 *
 * @param fromKey venue-local day, `yyyy-MM-dd`
 * @param toKey   venue-local day, `yyyy-MM-dd` (inclusive)
 */
export async function getCrossVenueSettlementCalendar(fromKey: string, toKey: string): Promise<CrossVenueSettlementCalendar> {
  // Widen the SQL window by the lookback: a sale made before `fromKey` can still
  // land inside it. We cannot filter on the settlement date in SQL — it is computed
  // in JS by the engine — so we over-fetch by sale date and filter after projecting.
  const sqlFrom = new Date(`${fromKey}T00:00:00.000Z`)
  sqlFrom.setUTCDate(sqlFrom.getUTCDate() - LOOKBACK_DAYS)
  // +1 day of slack on the upper bound for the same reason in reverse (tz offsets).
  const sqlTo = new Date(`${toKey}T23:59:59.999Z`)
  sqlTo.setUTCDate(sqlTo.getUTCDate() + 1)

  const payments = await prisma.payment.findMany({
    where: {
      status: 'COMPLETED',
      method: { not: PaymentMethod.CASH },
      merchantAccountId: { not: null },
      createdAt: { gte: sqlFrom, lte: sqlTo },
    },
    select: {
      amount: true,
      tipAmount: true,
      createdAt: true,
      venueId: true,
      merchantAccountId: true,
      transactionCost: { select: { transactionType: true, venueChargeAmount: true, venueFixedFee: true } },
      venue: { select: { id: true, name: true, timezone: true } },
      merchantAccount: { select: { aggregatorId: true, aggregator: { select: { name: true } } } },
    },
  })

  const merchantIds = Array.from(new Set(payments.map(p => p.merchantAccountId).filter((x): x is string => Boolean(x))))
  const configs: ActiveConfig[] = merchantIds.length
    ? await prisma.settlementConfiguration.findMany({
        where: { merchantAccountId: { in: merchantIds } },
        select: {
          merchantAccountId: true,
          cardType: true,
          settlementDays: true,
          settlementDayType: true,
          cutoffTime: true,
          cutoffTimezone: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
        orderBy: { effectiveFrom: 'desc' },
      })
    : []

  const dayMap = new Map<string, { total: Agg; venues: Map<string, CalendarVenue> }>()
  const unprojected = { count: 0, gross: 0 }

  for (const p of payments) {
    const merchantId = p.merchantAccountId
    if (!merchantId) continue

    // Each venue projects in ITS OWN timezone. Today every venue is
    // America/Mexico_City, but reading the venue's own tz keeps this correct if a
    // venue in another tz is ever onboarded — the same way the per-venue page does it.
    const venueTz = p.venue?.timezone || DEFAULT_TIMEZONE

    const projected = p.transactionCost
      ? projectPaymentSettlement(
          {
            amount: p.amount,
            tipAmount: p.tipAmount,
            createdAt: p.createdAt,
            merchantAccountId: merchantId,
            transactionCost: p.transactionCost,
          },
          configs,
          venueTz,
        )
      : null

    if (!projected) {
      // No cost yet, or no settlement rule for this merchant × cardType at sale time.
      // Can't honestly place it on a day — surface it instead of dropping it.
      unprojected.count += 1
      unprojected.gross += Number(p.amount) + Number(p.tipAmount ?? 0)
      continue
    }

    const key = projected.settlementDateKey
    if (key < fromKey || key > toKey) continue // lands outside the requested window

    if (!dayMap.has(key)) dayMap.set(key, { total: newAgg(), venues: new Map() })
    const day = dayMap.get(key)!

    day.total.gross += projected.gross
    day.total.commission += projected.commission
    day.total.net += projected.net
    day.total.count += 1

    if (!day.venues.has(p.venueId)) {
      day.venues.set(p.venueId, {
        venueId: p.venueId,
        venueName: p.venue?.name ?? 'Venue',
        hasAggregator: false,
        aggregatorNames: [],
        ...newAgg(),
      })
    }
    const v = day.venues.get(p.venueId)!
    v.gross += projected.gross
    v.commission += projected.commission
    v.net += projected.net
    v.count += 1

    // A venue can route through several merchants (primary/secondary/tertiary), so
    // aggregator-ness is a property of the MERCHANT, not the venue: one venue-day can
    // mix aggregator and direct money. We flag the venue-day if ANY of its money went
    // through an aggregator, and list which — rather than pretending it's homogeneous.
    const aggName = p.merchantAccount?.aggregator?.name
    if (p.merchantAccount?.aggregatorId && aggName) {
      v.hasAggregator = true
      if (!v.aggregatorNames.includes(aggName)) v.aggregatorNames.push(aggName)
    }
  }

  // "Today" is resolved in the platform's default tz. All 70 prod venues share it;
  // if that ever stops being true, a day's status is cosmetic (colour), not money.
  const todayKey = formatInTimeZone(new Date(), DEFAULT_TIMEZONE, 'yyyy-MM-dd')

  const days: CalendarDay[] = Array.from(dayMap.entries())
    .map(([date, d]) => ({
      date,
      status: (date < todayKey ? 'settled' : date === todayKey ? 'today' : 'projected') as CalendarDay['status'],
      ...roundAgg(d.total),
      venues: Array.from(d.venues.values())
        .map(v => ({ ...v, ...roundAgg(v) }))
        .sort((a, b) => b.net - a.net),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  const total = roundAgg(
    days.reduce(
      (acc, d) => ({
        gross: acc.gross + d.gross,
        commission: acc.commission + d.commission,
        net: acc.net + d.net,
        count: acc.count + d.count,
      }),
      newAgg(),
    ),
  )

  const venueCount = new Set(days.flatMap(d => d.venues.map(v => v.venueId))).size

  logger.info('Cross-venue settlement calendar computed', {
    fromKey,
    toKey,
    dayCount: days.length,
    venueCount,
    net: total.net,
    unprojectedCount: unprojected.count,
  })

  return {
    from: fromKey,
    to: toKey,
    days,
    total,
    venueCount,
    unprojected: { count: unprojected.count, gross: round2(unprojected.gross) },
  }
}
