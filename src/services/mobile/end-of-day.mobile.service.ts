/**
 * Mobile End-of-Day Service ("Cierre del día")
 *
 * Square's end-of-day screen aggregates, in ONE payload, everything a manager
 * must review before closing the business day:
 *   - the day's sales summary (by tender) + tips
 *   - blockers: open checks, open cash drawers, staff still clocked in
 *
 * All of these already exist as separate subsystems (Order, Payment,
 * CashDrawerSession, TimeEntry) — this service only composes them, so it is
 * READ-ONLY and additive. The "day" is the VENUE-LOCAL day (see datetime.ts:
 * Prisma stores real UTC, so boundaries must be converted with venueStartOfDay).
 */

import prisma from '../../utils/prismaClient'
import { venueStartOfDay, venueEndOfDay, DEFAULT_TIMEZONE } from '../../utils/datetime'

export interface EndOfDaySummary {
  /** Venue-local day boundaries, as ISO instants. */
  from: string
  to: string
  sales: {
    /** Sum of amount + tip across COMPLETED payments in the day. */
    totalCents: number
    tipsCents: number
    transactionCount: number
    averageTicketCents: number
    /** Per-tender totals (amount + tip), major-unit-free: cents. */
    tenders: Array<{ method: string; totalCents: number }>
  }
  /** Blockers a manager should resolve before closing. */
  openChecks: { count: number; totalCents: number }
  openDrawers: Array<{ id: string; openedByName: string; openedAt: string; startingAmountCents: number }>
  clockedInStaff: Array<{ id: string; name: string; clockInTime: string; status: string }>
  /** True when nothing blocks the close. */
  readyToClose: boolean
}

function toCents(value: any): number {
  return Math.round(Number(value) * 100)
}

export async function getEndOfDaySummary(venueId: string, referenceDate?: Date): Promise<EndOfDaySummary> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { timezone: true },
  })
  const timezone = venue?.timezone || DEFAULT_TIMEZONE
  const from = venueStartOfDay(timezone, referenceDate)
  const to = venueEndOfDay(timezone, referenceDate)

  const [payments, openOrders, openDrawers, clockedIn] = await Promise.all([
    prisma.payment.findMany({
      where: { venueId, status: 'COMPLETED', createdAt: { gte: from, lte: to } },
      select: { method: true, amount: true, tipAmount: true },
    }),
    // Open checks = orders neither completed nor cancelled/deleted.
    prisma.order.findMany({
      where: {
        venueId,
        status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] },
      },
      select: { total: true },
    }),
    prisma.cashDrawerSession.findMany({
      where: { venueId, status: 'OPEN' },
      select: { id: true, openedByName: true, openedAt: true, startingAmount: true },
    }),
    prisma.timeEntry.findMany({
      where: { venueId, status: { in: ['CLOCKED_IN', 'ON_BREAK'] } },
      select: {
        id: true,
        status: true,
        clockInTime: true,
        staff: { select: { firstName: true, lastName: true } },
      },
    }),
  ])

  // Sales by tender (amount + tip; refunds ride as negative COMPLETED rows).
  const byMethod = new Map<string, number>()
  let totalCents = 0
  let tipsCents = 0
  for (const p of payments) {
    const method = p.method || 'OTHER'
    const cents = toCents(p.amount) + toCents(p.tipAmount ?? 0)
    byMethod.set(method, (byMethod.get(method) || 0) + cents)
    totalCents += cents
    tipsCents += toCents(p.tipAmount ?? 0)
  }
  const tenders = Array.from(byMethod.entries())
    .map(([method, cents]) => ({ method, totalCents: cents }))
    .filter(t => t.totalCents !== 0)
    .sort((a, b) => b.totalCents - a.totalCents)

  const transactionCount = payments.length
  const openChecksTotal = openOrders.reduce((sum, o) => sum + toCents(o.total), 0)

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    sales: {
      totalCents,
      tipsCents,
      transactionCount,
      averageTicketCents: transactionCount > 0 ? Math.round(totalCents / transactionCount) : 0,
      tenders,
    },
    openChecks: { count: openOrders.length, totalCents: openChecksTotal },
    openDrawers: openDrawers.map(d => ({
      id: d.id,
      openedByName: d.openedByName || '',
      openedAt: d.openedAt.toISOString(),
      startingAmountCents: toCents(d.startingAmount),
    })),
    clockedInStaff: clockedIn.map(t => ({
      id: t.id,
      name: `${t.staff?.firstName ?? ''} ${t.staff?.lastName ?? ''}`.trim(),
      clockInTime: t.clockInTime.toISOString(),
      status: t.status,
    })),
    readyToClose: openOrders.length === 0 && openDrawers.length === 0 && clockedIn.length === 0,
  }
}
