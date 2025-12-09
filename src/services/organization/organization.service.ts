// src/services/organization/organization.service.ts

/**
 * Organization Service
 *
 * Provides organization-level data aggregation for OWNER dashboard.
 * Aggregates data across all venues belonging to an organization.
 *
 * Design Principle: HTTP-Agnostic Business Logic Layer
 * - Accept primitive types and DTOs
 * - Return data or throw errors (never touch req/res)
 * - Throw AppError subclasses for business rule violations
 */

import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { Prisma, VenueStatus, TransactionStatus } from '@prisma/client'
import logger from '../../config/logger'

// Types for organization overview
export interface VenueMetrics {
  id: string
  name: string
  slug: string
  logo: string | null
  city: string | null
  status: VenueStatus
  revenue: number
  orderCount: number
  paymentCount: number
  staffCount: number
}

export interface OrganizationOverview {
  id: string
  name: string
  email: string
  phone: string
  totalRevenue: number
  totalOrders: number
  totalPayments: number
  totalStaff: number
  venueCount: number
  venues: VenueMetrics[]
  period: {
    from: Date
    to: Date
  }
}

export interface OrganizationVenue {
  id: string
  name: string
  slug: string
  logo: string | null
  address: string | null
  city: string | null
  state: string | null
  status: VenueStatus
  createdAt: Date
  metrics: {
    revenue: number
    orderCount: number
    paymentCount: number
    staffCount: number
    growth: number // Percentage vs previous period
  }
}

export interface OrganizationTeamMember {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  venues: Array<{
    venueId: string
    venueName: string
    venueSlug: string
    role: string
  }>
  createdAt: Date
}

// Filter options for queries
export interface DateRangeFilter {
  from?: Date
  to?: Date
  timeRange?: '7d' | '30d' | '90d' | 'ytd' | 'all'
}

/**
 * Get organization by ID with basic info
 */
export async function getOrganizationById(orgId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      taxId: true,
      type: true,
      billingEmail: true,
      billingAddress: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${orgId} not found`)
  }

  return organization
}

/**
 * Calculate date range from filter options
 */
function calculateDateRange(filter?: DateRangeFilter): { from: Date; to: Date } {
  const to = filter?.to || new Date()
  let from: Date

  if (filter?.from) {
    from = filter.from
  } else if (filter?.timeRange) {
    const now = new Date()
    switch (filter.timeRange) {
      case '7d':
        from = new Date(now.setDate(now.getDate() - 7))
        break
      case '30d':
        from = new Date(now.setDate(now.getDate() - 30))
        break
      case '90d':
        from = new Date(now.setDate(now.getDate() - 90))
        break
      case 'ytd':
        from = new Date(now.getFullYear(), 0, 1) // Jan 1 of current year
        break
      case 'all':
      default:
        from = new Date(2020, 0, 1) // Far past date
    }
  } else {
    // Default to last 30 days
    const now = new Date()
    from = new Date(now.setDate(now.getDate() - 30))
  }

  return { from, to }
}

/**
 * Get organization overview with aggregated metrics from all venues
 */
export async function getOrganizationOverview(orgId: string, filter?: DateRangeFilter): Promise<OrganizationOverview> {
  // First verify organization exists
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
    },
  })

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${orgId} not found`)
  }

  const { from, to } = calculateDateRange(filter)

  // Get all venues for the organization
  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      city: true,
      status: true,
    },
  })

  const venueIds = venues.map(v => v.id)

  // Aggregate payments for all venues
  const paymentsAgg = await prisma.payment.aggregate({
    where: {
      venueId: { in: venueIds },
      status: TransactionStatus.COMPLETED,
      createdAt: { gte: from, lte: to },
    },
    _sum: { amount: true },
    _count: true,
  })

  // Aggregate orders for all venues
  const ordersAgg = await prisma.order.aggregate({
    where: {
      venueId: { in: venueIds },
      createdAt: { gte: from, lte: to },
    },
    _count: true,
  })

  // Count total staff
  const staffCount = await prisma.staff.count({
    where: { organizationId: orgId },
  })

  // Get metrics per venue
  const venueMetrics: VenueMetrics[] = await Promise.all(
    venues.map(async venue => {
      const venuePayments = await prisma.payment.aggregate({
        where: {
          venueId: venue.id,
          status: TransactionStatus.COMPLETED,
          createdAt: { gte: from, lte: to },
        },
        _sum: { amount: true },
        _count: true,
      })

      const venueOrders = await prisma.order.count({
        where: {
          venueId: venue.id,
          createdAt: { gte: from, lte: to },
        },
      })

      const venueStaff = await prisma.staffVenue.count({
        where: { venueId: venue.id },
      })

      return {
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        logo: venue.logo,
        city: venue.city,
        status: venue.status,
        revenue: venuePayments._sum.amount?.toNumber() || 0,
        orderCount: venueOrders,
        paymentCount: venuePayments._count,
        staffCount: venueStaff,
      }
    }),
  )

  return {
    id: organization.id,
    name: organization.name,
    email: organization.email,
    phone: organization.phone,
    totalRevenue: paymentsAgg._sum.amount?.toNumber() || 0,
    totalOrders: ordersAgg._count,
    totalPayments: paymentsAgg._count,
    totalStaff: staffCount,
    venueCount: venues.length,
    venues: venueMetrics,
    period: { from, to },
  }
}

/**
 * Get all venues for an organization with detailed metrics
 */
export async function getOrganizationVenues(orgId: string, filter?: DateRangeFilter): Promise<OrganizationVenue[]> {
  const { from, to } = calculateDateRange(filter)

  // Calculate previous period for growth comparison
  const periodDuration = to.getTime() - from.getTime()
  const previousFrom = new Date(from.getTime() - periodDuration)
  const previousTo = new Date(from.getTime() - 1)

  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      address: true,
      city: true,
      state: true,
      status: true,
      createdAt: true,
    },
    orderBy: { name: 'asc' },
  })

  return Promise.all(
    venues.map(async venue => {
      // Current period metrics
      const currentPayments = await prisma.payment.aggregate({
        where: {
          venueId: venue.id,
          status: TransactionStatus.COMPLETED,
          createdAt: { gte: from, lte: to },
        },
        _sum: { amount: true },
        _count: true,
      })

      const currentOrders = await prisma.order.count({
        where: {
          venueId: venue.id,
          createdAt: { gte: from, lte: to },
        },
      })

      // Previous period metrics for growth calculation
      const previousPayments = await prisma.payment.aggregate({
        where: {
          venueId: venue.id,
          status: TransactionStatus.COMPLETED,
          createdAt: { gte: previousFrom, lte: previousTo },
        },
        _sum: { amount: true },
      })

      const staffCount = await prisma.staffVenue.count({
        where: { venueId: venue.id },
      })

      // Calculate growth percentage
      const currentRevenue = currentPayments._sum.amount?.toNumber() || 0
      const previousRevenue = previousPayments._sum.amount?.toNumber() || 0
      const growth = previousRevenue > 0 ? ((currentRevenue - previousRevenue) / previousRevenue) * 100 : currentRevenue > 0 ? 100 : 0

      return {
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        logo: venue.logo,
        address: venue.address,
        city: venue.city,
        state: venue.state,
        status: venue.status,
        createdAt: venue.createdAt,
        metrics: {
          revenue: currentRevenue,
          orderCount: currentOrders,
          paymentCount: currentPayments._count,
          staffCount,
          growth: Math.round(growth * 100) / 100, // Round to 2 decimal places
        },
      }
    }),
  )
}

/**
 * Get all team members across all venues in the organization
 */
export async function getOrganizationTeam(orgId: string): Promise<OrganizationTeamMember[]> {
  const staff = await prisma.staff.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      createdAt: true,
      venues: {
        select: {
          venueId: true,
          role: true,
          venue: {
            select: {
              name: true,
              slug: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return staff.map(member => ({
    id: member.id,
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    phone: member.phone,
    createdAt: member.createdAt,
    venues: member.venues.map(v => ({
      venueId: v.venueId,
      venueName: v.venue.name,
      venueSlug: v.venue.slug,
      role: v.role,
    })),
  }))
}

/**
 * Update organization details
 */
export async function updateOrganization(
  orgId: string,
  data: {
    name?: string
    email?: string
    phone?: string
    taxId?: string | null
    billingEmail?: string | null
    billingAddress?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput
  },
) {
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
  })

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${orgId} not found`)
  }

  return prisma.organization.update({
    where: { id: orgId },
    data,
  })
}

/**
 * Get organization statistics summary (lightweight version for header/nav)
 */
export async function getOrganizationStats(orgId: string) {
  const [venueCount, staffCount, organization] = await Promise.all([
    prisma.venue.count({ where: { organizationId: orgId } }),
    prisma.staff.count({ where: { organizationId: orgId } }),
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true },
    }),
  ])

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${orgId} not found`)
  }

  return {
    id: organization.id,
    name: organization.name,
    venueCount,
    staffCount,
  }
}
