/**
 * Superadmin Dashboard Summary Service
 *
 * Aggregate counts + recent activity counters for the operations console
 * home screen. Read-only, parallelizable, no side effects.
 */

import prisma from '../../utils/prismaClient'
import { VerificationStatus, TerminalStatus, PaymentStatus, VenueStatus } from '@prisma/client'

export interface SuperadminDashboardSummary {
  venues: {
    total: number
    active: number
    suspended: number
  }
  terminals: {
    total: number
    active: number
    inactive: number
    pendingActivation: number
  }
  kyc: {
    pendingReview: number
    inReview: number
    verified: number
    rejected: number
    notSubmitted: number
  }
  staff: {
    total: number
  }
  payments24h: {
    count: number
    volumeCents: number
    failedCount: number
  }
  activityLog: {
    last24h: number
  }
}

export async function getSuperadminDashboardSummary(): Promise<SuperadminDashboardSummary> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [
    venueByStatus,
    terminalByStatus,
    venueByKyc,
    staffTotal,
    paymentStats,
    activityLast24h,
  ] = await Promise.all([
    prisma.venue.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
    prisma.terminal.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
    prisma.venue.groupBy({
      by: ['kycStatus'],
      _count: { _all: true },
    }),
    prisma.staff.count(),
    prisma.payment.aggregate({
      where: { createdAt: { gte: since24h } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.activityLog.count({
      where: { createdAt: { gte: since24h } },
    }),
  ])

  const venueCount = (status: VenueStatus): number =>
    venueByStatus.find((row) => row.status === status)?._count._all ?? 0
  const terminalCount = (status: TerminalStatus): number =>
    terminalByStatus.find((row) => row.status === status)?._count._all ?? 0
  const kycCount = (status: VerificationStatus): number =>
    venueByKyc.find((row) => row.kycStatus === status)?._count._all ?? 0

  // Failed payments in last 24h: filter the raw rows because groupBy by `status`
  // would double-fire DB calls; cheaper to query once.
  const paymentsFailed = await prisma.payment.count({
    where: {
      createdAt: { gte: since24h },
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL] },
    },
  })

  const sumAmountRaw = paymentStats._sum.amount
  const volumeCents = sumAmountRaw ? Number(sumAmountRaw) * 100 : 0

  return {
    venues: {
      total: venueByStatus.reduce((acc, row) => acc + row._count._all, 0),
      active: venueCount(VenueStatus.ACTIVE),
      suspended: venueCount(VenueStatus.SUSPENDED),
    },
    terminals: {
      total: terminalByStatus.reduce((acc, row) => acc + row._count._all, 0),
      active: terminalCount(TerminalStatus.ACTIVE),
      inactive: terminalCount(TerminalStatus.INACTIVE),
      pendingActivation: terminalCount(TerminalStatus.PENDING_ACTIVATION),
    },
    kyc: {
      pendingReview: kycCount(VerificationStatus.PENDING_REVIEW),
      inReview: kycCount(VerificationStatus.IN_REVIEW),
      verified: kycCount(VerificationStatus.VERIFIED),
      rejected: kycCount(VerificationStatus.REJECTED),
      notSubmitted: kycCount(VerificationStatus.NOT_SUBMITTED),
    },
    staff: {
      total: staffTotal,
    },
    payments24h: {
      count: paymentStats._count._all,
      volumeCents,
      failedCount: paymentsFailed,
    },
    activityLog: {
      last24h: activityLast24h,
    },
  }
}
