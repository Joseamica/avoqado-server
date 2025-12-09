import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { VenueStatus } from '@prisma/client'
import { PRODUCTION_VENUE_STATUSES, OPERATIONAL_VENUE_STATUSES, DEMO_VENUE_STATUSES } from '@/lib/venueStatus.constants'

// ===== PRODUCTION VENUE FILTER =====
// Excludes demo/trial venues (LIVE_DEMO, TRIAL) from analytics to prevent skewed metrics
// Uses status as single source of truth (not isOnboardingDemo boolean)
const PRODUCTION_VENUE_FILTER = {
  status: { in: PRODUCTION_VENUE_STATUSES, notIn: DEMO_VENUE_STATUSES },
}

export interface SuperadminDashboardData {
  kpis: {
    totalRevenue: number
    monthlyRecurringRevenue: number
    totalVenues: number
    activeVenues: number
    totalUsers: number
    averageRevenuePerUser: number
    churnRate: number
    growthRate: number
    systemUptime: number
    // Platform earnings
    totalCommissionRevenue: number
    subscriptionRevenue: number
    featureRevenue: number
  }
  revenueMetrics: {
    totalPlatformRevenue: number // Total money Avoqado actually earns
    totalCommissionRevenue: number // Fees from transactions
    subscriptionRevenue: number // Monthly subscription fees from venues
    featureRevenue: number // Premium feature fees
    invoicedRevenue: number // Formally billed revenue
    settledRevenue: number // Actually received revenue
    transactionCount: number
    newVenues: number
    churnedVenues: number
  }
  recentActivity: Array<{
    id: string
    type: string
    description: string
    venueName?: string
    amount?: number
    timestamp: string
  }>
  alerts: Array<{
    id: string
    type: 'error' | 'warning' | 'info'
    title: string
    message: string
    isRead: boolean
  }>
  topVenues: Array<{
    name: string
    revenue: number
    commission: number
    growth: number
  }>
}

export interface PlatformFeature {
  id: string
  code: string
  name: string
  description: string
  category: string
  status: string
  pricingModel: string
  basePrice?: number
  usagePrice?: number
  usageUnit?: string
  isCore: boolean
  createdAt: string
  updatedAt: string
}

export interface SuperadminVenue {
  id: string
  name: string
  slug: string
  status: VenueStatus // Use enum type
  subscriptionPlan: string
  monthlyRevenue: number
  commissionRate: number
  totalTransactions: number
  totalRevenue: number
  organizationId: string
  organization: {
    id: string
    name: string
    email: string
    phone?: string
  }
  owner: {
    id: string
    firstName: string
    lastName: string
    email: string
    phone?: string
  }
  features: string[]
  analytics: {
    monthlyTransactions: number
    monthlyRevenue: number
    averageOrderValue: number
    activeUsers: number
    lastActivityAt: string
  }
  billing: {
    nextBillingDate: string
    monthlySubscriptionFee: number
    additionalFeaturesCost: number
    totalMonthlyBill: number
    paymentStatus: string
  }
  kycStatus?: string | null
  statusChangedAt?: string | null
  suspensionReason?: string | null
  approvedAt?: string
  approvedBy?: string
  createdAt: string
  updatedAt: string
}

/**
 * Get comprehensive dashboard data for superadmin overview
 */
export async function getSuperadminDashboardData(): Promise<SuperadminDashboardData> {
  try {
    // Get venue statistics (exclude demo venues)
    const [totalVenues, activeVenues, totalUsers] = await Promise.all([
      prisma.venue.count({ where: PRODUCTION_VENUE_FILTER }),
      prisma.venue.count({
        where: {
          ...PRODUCTION_VENUE_FILTER,
          status: { in: OPERATIONAL_VENUE_STATUSES },
        },
      }),
      prisma.staff.count(),
    ])

    // Get transaction data for revenue calculations (exclude demo venues)
    const payments = await prisma.payment.findMany({
      where: {
        createdAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        },
        order: {
          venue: PRODUCTION_VENUE_FILTER,
        },
      },
      include: {
        order: {
          include: {
            venue: true,
          },
        },
      },
    })

    // Calculate revenue metrics
    const totalRevenue = payments.reduce((sum, payment) => sum + Number(payment.amount), 0)
    const monthlyRecurringRevenue = totalRevenue // Simplified for now
    const transactionCount = payments.length
    const _averageRevenuePerUser = totalUsers > 0 ? totalRevenue / totalUsers : 0

    // Calculate commission (assuming 15% average commission rate)
    const _totalCommissionRevenue = totalRevenue * 0.15

    // Calculate actual subscription revenue from venue monthly fees
    const _subscriptionRevenue = await calculateSubscriptionRevenue(
      new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      new Date(),
    )

    // Calculate actual feature revenue from premium features
    const _featureRevenue = await calculateFeatureRevenue(new Date(new Date().getFullYear(), new Date().getMonth(), 1), new Date())

    // Get recent venue registrations for growth metrics (exclude demo venues)
    const recentVenues = await prisma.venue.findMany({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
        },
        ...PRODUCTION_VENUE_FILTER,
      },
    })

    const newVenues = recentVenues.length
    const churnRate = 2.3 // Mock value - would need more complex calculation
    const growthRate = 12.8 // Mock value - would calculate based on historical data
    const systemUptime = 99.97 // Would integrate with monitoring system

    // Generate recent activity (simplified)
    const recentActivity = await generateRecentActivity()

    // Generate alerts (simplified)
    const alerts = await generateSystemAlerts()

    // Get top performing venues
    const topVenues = await getTopPerformingVenues()

    // Calculate actual platform revenue (what we earn)
    const platformRevenueMetrics = await calculatePlatformRevenue(new Date(new Date().getFullYear(), new Date().getMonth(), 1), new Date())

    return {
      kpis: {
        totalRevenue,
        monthlyRecurringRevenue,
        totalVenues,
        activeVenues,
        totalUsers,
        averageRevenuePerUser: totalUsers > 0 ? platformRevenueMetrics.totalPlatformRevenue / totalUsers : 0,
        churnRate,
        growthRate,
        systemUptime,
        // Add platform revenue to KPIs
        totalCommissionRevenue: platformRevenueMetrics.actualCommissionRevenue,
        subscriptionRevenue: platformRevenueMetrics.subscriptionRevenue,
        featureRevenue: platformRevenueMetrics.featureRevenue,
      },
      revenueMetrics: {
        totalPlatformRevenue: platformRevenueMetrics.totalPlatformRevenue,
        totalCommissionRevenue: platformRevenueMetrics.actualCommissionRevenue,
        subscriptionRevenue: platformRevenueMetrics.subscriptionRevenue,
        featureRevenue: platformRevenueMetrics.featureRevenue,
        invoicedRevenue: platformRevenueMetrics.invoicedRevenue,
        settledRevenue: platformRevenueMetrics.settledRevenue,
        transactionCount,
        newVenues,
        churnedVenues: 0, // Would calculate based on cancellations
      },
      recentActivity,
      alerts,
      topVenues,
    }
  } catch (error) {
    logger.error('Error getting superadmin dashboard data:', error)
    throw new Error('Failed to fetch dashboard data')
  }
}

/**
 * Get all venues with detailed information for superadmin management
 * @param includeDemos - Whether to include demo venues (default: false)
 */
export async function getAllVenuesForSuperadmin(includeDemos = false): Promise<SuperadminVenue[]> {
  try {
    const venues = await prisma.venue.findMany({
      where: includeDemos ? undefined : PRODUCTION_VENUE_FILTER,
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        staff: {
          where: {
            role: 'ADMIN',
          },
          include: {
            staff: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
              },
            },
          },
          take: 1,
        },
        orders: {
          where: {
            createdAt: {
              gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
            },
          },
          include: {
            payments: true,
          },
        },
      },
    })

    return venues.map(venue => {
      const monthlyOrders = venue.orders
      const monthlyRevenue = monthlyOrders.reduce(
        (sum, order) => sum + order.payments.reduce((paySum, payment) => paySum + Number(payment.amount), 0),
        0,
      )
      const totalTransactions = monthlyOrders.length
      const averageOrderValue = totalTransactions > 0 ? monthlyRevenue / totalTransactions : 0
      const ownerRel = venue.staff[0]
      const owner = ownerRel?.staff
        ? {
            id: ownerRel.staff.id,
            firstName: ownerRel.staff.firstName,
            lastName: ownerRel.staff.lastName,
            email: ownerRel.staff.email,
            phone: ownerRel.staff.phone,
          }
        : { id: '', firstName: 'Unknown', lastName: 'Owner', email: 'unknown@email.com' }

      return {
        id: venue.id,
        name: venue.name,
        slug: venue.slug || venue.name.toLowerCase().replace(/\s+/g, '-'),
        status: venue.status, // Use actual status from database
        subscriptionPlan: 'PROFESSIONAL', // Would come from subscription model
        monthlyRevenue,
        commissionRate: 15, // Default commission rate
        totalTransactions,
        totalRevenue: monthlyRevenue, // Simplified for now
        organizationId: venue.organizationId,
        organization: {
          id: venue.organization.id,
          name: venue.organization.name,
          email: venue.organization.email,
          phone: venue.organization.phone,
        },
        owner: owner ? { ...owner, phone: owner.phone ?? undefined } : owner,
        features: [], // Would come from feature assignments
        analytics: {
          monthlyTransactions: totalTransactions,
          monthlyRevenue,
          averageOrderValue,
          activeUsers: venue.staff.length,
          lastActivityAt: new Date().toISOString(),
        },
        billing: {
          nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          monthlySubscriptionFee: 299,
          additionalFeaturesCost: 0,
          totalMonthlyBill: 299,
          paymentStatus: 'PAID',
        },
        kycStatus: venue.kycStatus || null, // Include KYC status for superadmin review
        statusChangedAt: venue.statusChangedAt?.toISOString() || null, // When status changed
        suspensionReason: venue.suspensionReason || null, // Why suspended (if applicable)
        createdAt: venue.createdAt.toISOString(),
        updatedAt: venue.updatedAt.toISOString(),
      }
    })
  } catch (error) {
    logger.error('Error getting venues for superadmin:', error)
    throw new Error('Failed to fetch venues data')
  }
}

/**
 * Get all platform features for management
 */
export async function getAllPlatformFeatures(): Promise<PlatformFeature[]> {
  try {
    const features = await prisma.feature.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    })

    return features.map(feature => ({
      id: feature.id,
      code: feature.code,
      name: feature.name,
      description: feature.description || '',
      category: feature.category,
      status: feature.active ? 'ACTIVE' : 'INACTIVE',
      pricingModel: 'FIXED', // Default since Feature doesn't have this field yet
      basePrice: Number(feature.monthlyPrice) || 0,
      isCore: false, // Default since Feature doesn't have this field yet
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }))
  } catch (error) {
    logger.error('Error getting platform features from database:', error)
    throw new Error('Failed to fetch platform features')
  }
}

/**
 * Approve a venue for platform access (Superadmin action)
 * Transitions venue from PENDING_ACTIVATION to ACTIVE
 */
export async function approveVenue(venueId: string, approvedBy: string): Promise<void> {
  try {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { status: true, name: true },
    })

    if (!venue) {
      throw new Error('Venue not found')
    }

    // Can only approve from PENDING_ACTIVATION status
    if (venue.status !== VenueStatus.PENDING_ACTIVATION) {
      throw new Error(`Cannot approve venue in ${venue.status} status. Expected PENDING_ACTIVATION.`)
    }

    await prisma.venue.update({
      where: { id: venueId },
      data: {
        status: VenueStatus.ACTIVE,
        statusChangedAt: new Date(),
        statusChangedBy: approvedBy,
        active: true, // Keep backwards compatible
        updatedAt: new Date(),
      },
    })

    logger.info(`Venue ${venue.name} (${venueId}) approved by ${approvedBy}`)
  } catch (error) {
    logger.error('Error approving venue:', error)
    throw error instanceof Error ? error : new Error('Failed to approve venue')
  }
}

/**
 * Suspend a venue by Superadmin (ADMIN_SUSPENDED status)
 * Use this for non-payment, policy violations, or administrative actions
 */
export async function suspendVenueByAdmin(venueId: string, reason: string, suspendedBy: string): Promise<void> {
  try {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { status: true, name: true },
    })

    if (!venue) {
      throw new Error('Venue not found')
    }

    // Can only suspend from ACTIVE status
    if (venue.status !== VenueStatus.ACTIVE) {
      throw new Error(`Cannot suspend venue in ${venue.status} status. Expected ACTIVE.`)
    }

    await prisma.venue.update({
      where: { id: venueId },
      data: {
        status: VenueStatus.ADMIN_SUSPENDED,
        statusChangedAt: new Date(),
        statusChangedBy: suspendedBy,
        suspensionReason: reason,
        active: false, // Keep backwards compatible
        updatedAt: new Date(),
      },
    })

    logger.info(`Venue ${venue.name} (${venueId}) suspended by admin ${suspendedBy}. Reason: ${reason}`)
  } catch (error) {
    logger.error('Error suspending venue:', error)
    throw error instanceof Error ? error : new Error('Failed to suspend venue')
  }
}

/**
 * Reactivate a suspended venue (Superadmin action)
 * Transitions venue from SUSPENDED or ADMIN_SUSPENDED back to ACTIVE
 */
export async function reactivateVenueByAdmin(venueId: string, reactivatedBy: string): Promise<void> {
  try {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { status: true, name: true },
    })

    if (!venue) {
      throw new Error('Venue not found')
    }

    // Can only reactivate from SUSPENDED or ADMIN_SUSPENDED
    if (venue.status !== VenueStatus.SUSPENDED && venue.status !== VenueStatus.ADMIN_SUSPENDED) {
      throw new Error(`Cannot reactivate venue in ${venue.status} status. Expected SUSPENDED or ADMIN_SUSPENDED.`)
    }

    await prisma.venue.update({
      where: { id: venueId },
      data: {
        status: VenueStatus.ACTIVE,
        statusChangedAt: new Date(),
        statusChangedBy: reactivatedBy,
        suspensionReason: null, // Clear suspension reason
        active: true, // Keep backwards compatible
        updatedAt: new Date(),
      },
    })

    logger.info(`Venue ${venue.name} (${venueId}) reactivated by ${reactivatedBy}`)
  } catch (error) {
    logger.error('Error reactivating venue:', error)
    throw error instanceof Error ? error : new Error('Failed to reactivate venue')
  }
}

/**
 * Get venues by status (for superadmin dashboard)
 */
export async function getVenuesByStatus(status?: VenueStatus): Promise<{ status: VenueStatus; count: number }[]> {
  try {
    if (status) {
      const count = await prisma.venue.count({
        where: { status },
      })
      return [{ status, count }]
    }

    // Get counts for all statuses
    const allStatuses = Object.values(VenueStatus)
    const counts = await Promise.all(
      allStatuses.map(async s => ({
        status: s,
        count: await prisma.venue.count({ where: { status: s } }),
      })),
    )

    return counts.filter(c => c.count > 0)
  } catch (error) {
    logger.error('Error getting venues by status:', error)
    throw new Error('Failed to get venues by status')
  }
}

/**
 * @deprecated Use suspendVenueByAdmin instead
 * Legacy function for backwards compatibility
 */
export async function suspendVenue(venueId: string, reason: string): Promise<void> {
  // Delegate to new function with unknown suspender
  return suspendVenueByAdmin(venueId, reason, 'system')
}

/**
 * Enable a feature for a venue
 */
export async function enableFeatureForVenue(venueId: string, featureCode: string): Promise<void> {
  try {
    // Ensure venue exists
    const venue = await prisma.venue.findUnique({ where: { id: venueId } })
    if (!venue) {
      throw new Error('Venue not found')
    }

    // Find feature by code
    const feature = await prisma.feature.findUnique({ where: { code: featureCode } })
    if (!feature) {
      throw new Error('Feature not found')
    }

    // Upsert venue-feature association and activate it
    await prisma.venueFeature.upsert({
      where: { venueId_featureId: { venueId, featureId: feature.id } },
      create: {
        venueId,
        featureId: feature.id,
        active: true,
        monthlyPrice: feature.monthlyPrice,
        startDate: new Date(),
      },
      update: {
        active: true,
        endDate: null,
        monthlyPrice: feature.monthlyPrice,
      },
    })
  } catch (error) {
    logger.error('Error enabling feature for venue:', error)
    throw new Error('Failed to enable feature for venue')
  }
}

/**
 * Disable a feature for a venue
 */
export async function disableFeatureForVenue(venueId: string, featureCode: string): Promise<void> {
  try {
    // Ensure venue exists
    const venue = await prisma.venue.findUnique({ where: { id: venueId } })
    if (!venue) {
      throw new Error('Venue not found')
    }

    // Find feature by code
    const feature = await prisma.feature.findUnique({ where: { code: featureCode } })
    if (!feature) {
      throw new Error('Feature not found')
    }

    // Update association to inactive if exists
    await prisma.venueFeature.update({
      where: { venueId_featureId: { venueId, featureId: feature.id } },
      data: {
        active: false,
        endDate: new Date(),
      },
    })
  } catch (error) {
    logger.error('Error disabling feature for venue:', error)
    throw new Error('Failed to disable feature for venue')
  }
}

/**
 * Grant a DB-only trial for a venue (no Stripe subscription)
 * Sets an endDate that will be expired by the daily cron job
 */
export async function grantTrialForVenue(venueId: string, featureCode: string, trialDays: number): Promise<{ endDate: Date }> {
  try {
    // Ensure venue exists
    const venue = await prisma.venue.findUnique({ where: { id: venueId } })
    if (!venue) {
      throw new Error('Venue not found')
    }

    // Find feature by code
    const feature = await prisma.feature.findUnique({ where: { code: featureCode } })
    if (!feature) {
      throw new Error('Feature not found')
    }

    // Calculate trial end date
    const startDate = new Date()
    const endDate = new Date(startDate)
    endDate.setDate(endDate.getDate() + trialDays)

    // Upsert venue-feature association with trial end date
    await prisma.venueFeature.upsert({
      where: { venueId_featureId: { venueId, featureId: feature.id } },
      create: {
        venueId,
        featureId: feature.id,
        active: true,
        monthlyPrice: feature.monthlyPrice,
        startDate,
        endDate, // Trial expires on this date
        // No stripeSubscriptionId = DB-only trial
      },
      update: {
        active: true,
        startDate,
        endDate, // Trial expires on this date
        monthlyPrice: feature.monthlyPrice,
        // Clear any previous Stripe subscription
        stripeSubscriptionId: null,
        stripeSubscriptionItemId: null,
        suspendedAt: null,
        gracePeriodEndsAt: null,
      },
    })

    logger.info(`Granted ${trialDays}-day DB-only trial for ${featureCode} to venue ${venueId}`, {
      venueId,
      featureCode,
      trialDays,
      endDate,
    })

    return { endDate }
  } catch (error) {
    logger.error('Error granting trial for venue:', error)
    throw new Error('Failed to grant trial for venue')
  }
}

/**
 * Get venue details by ID
 */
export async function getVenueDetails(venueId: string): Promise<SuperadminVenue | null> {
  try {
    const venues = await getAllVenuesForSuperadmin()
    return venues.find(venue => venue.id === venueId) || null
  } catch (error) {
    logger.error('Error getting venue details:', error)
    throw new Error('Failed to fetch venue details')
  }
}

/**
 * Verify superadmin permissions
 */
type RoleCarrier = { role?: string } | null | undefined
export function verifySuperadminAccess(user: RoleCarrier): boolean {
  return user?.role === 'SUPERADMIN'
}

// Helper functions
async function generateRecentActivity() {
  return [
    {
      id: '1',
      type: 'venue_approved',
      description: 'New venue "La Taquería" approved',
      venueName: 'La Taquería',
      timestamp: '2 mins ago',
    },
    {
      id: '2',
      type: 'payment_received',
      description: 'Payment received from Premium Plan',
      amount: 299,
      timestamp: '5 mins ago',
    },
    {
      id: '3',
      type: 'feature_enabled',
      description: 'AI Chatbot enabled for "Bistro Central"',
      venueName: 'Bistro Central',
      timestamp: '12 mins ago',
    },
  ]
}

async function generateSystemAlerts() {
  return [
    {
      id: '1',
      type: 'warning' as const,
      title: 'High Churn Alert',
      message: '5 venues cancelled this week',
      isRead: false,
    },
    {
      id: '2',
      type: 'error' as const,
      title: 'Payment Failed',
      message: '3 venues have failed payments',
      isRead: false,
    },
  ]
}

async function getTopPerformingVenues() {
  return [
    { name: 'Restaurante El Patrón', revenue: 45000, commission: 6750, growth: 12.5 },
    { name: 'Sushi Zen', revenue: 38500, commission: 5775, growth: 8.3 },
    { name: 'Pizza Corner', revenue: 32000, commission: 4800, growth: -2.1 },
    { name: 'Café Bistro', revenue: 28750, commission: 4312, growth: 15.2 },
  ]
}

// ===== REVENUE TRACKING INTERFACES =====

export interface RevenueMetrics {
  totalRevenue: number
  commissionRevenue: number
  subscriptionRevenue: number
  featureRevenue: number
  growthRate: number
  transactionCount: number
  averageOrderValue: number
}

export interface RevenueBreakdown {
  byVenue: VenueRevenue[]
  byPeriod: PeriodRevenue[]
  byFeature: FeatureRevenue[]
  commissionAnalysis: CommissionAnalysis
}

export interface VenueRevenue {
  venueId: string
  venueName: string
  revenue: number
  commission: number
  transactionCount: number
  averageOrderValue: number
  growth: number
}

export interface PeriodRevenue {
  period: string
  revenue: number
  commission: number
  transactionCount: number
  date: string
}

export interface FeatureRevenue {
  featureCode: string
  featureName: string
  activeVenues: number
  monthlyRevenue: number
  totalRevenue: number
}

export interface CommissionAnalysis {
  totalCommission: number
  averageCommissionRate: number
  commissionByVenue: { venueId: string; venueName: string; commission: number }[]
  projectedMonthlyCommission: number
}

// ===== REVENUE TRACKING FUNCTIONS =====

/**
 * Get comprehensive revenue metrics for a date range
 */
export async function getRevenueMetrics(startDate?: Date, endDate?: Date): Promise<RevenueMetrics> {
  try {
    // Default to current month if no dates provided
    const start = startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    const end = endDate || new Date()

    // Get all payments in the date range (exclude demo venues)
    const payments = await prisma.payment.findMany({
      where: {
        createdAt: {
          gte: start,
          lte: end,
        },
        status: 'COMPLETED', // Only count completed payments
        order: {
          venue: PRODUCTION_VENUE_FILTER,
        },
      },
      include: {
        order: {
          include: {
            venue: true,
          },
        },
      },
    })

    // Calculate base metrics
    const totalRevenue = payments.reduce((sum, payment) => sum + Number(payment.amount), 0)
    const transactionCount = payments.length
    const averageOrderValue = transactionCount > 0 ? totalRevenue / transactionCount : 0

    // Calculate commission (varies by venue plan, defaulting to 15%)
    const commissionRevenue = totalRevenue * 0.15

    // Calculate subscription revenue (from venue fees)
    const subscriptionRevenue = await calculateSubscriptionRevenue(start, end)

    // Calculate feature revenue (from premium features)
    const featureRevenue = await calculateFeatureRevenue(start, end)

    // Calculate growth rate compared to previous period
    const growthRate = await calculateGrowthRate(start, end)

    return {
      totalRevenue,
      commissionRevenue,
      subscriptionRevenue,
      featureRevenue,
      growthRate,
      transactionCount,
      averageOrderValue,
    }
  } catch (error) {
    logger.error('Error calculating revenue metrics:', error)
    throw new Error('Failed to calculate revenue metrics')
  }
}

/**
 * Get detailed revenue breakdown
 */
export async function getRevenueBreakdown(startDate?: Date, endDate?: Date): Promise<RevenueBreakdown> {
  try {
    const start = startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    const end = endDate || new Date()

    const [byVenue, byPeriod, byFeature, commissionAnalysis] = await Promise.all([
      getRevenueByVenue(start, end),
      getRevenueByPeriod(start, end),
      getRevenueByFeature(start, end),
      getCommissionAnalysis(start, end),
    ])

    return {
      byVenue,
      byPeriod,
      byFeature,
      commissionAnalysis,
    }
  } catch (error) {
    logger.error('Error getting revenue breakdown:', error)
    throw new Error('Failed to get revenue breakdown')
  }
}

/**
 * Calculate subscription revenue from venue monthly fees (prorated)
 */
async function calculateSubscriptionRevenue(startDate: Date, endDate: Date): Promise<number> {
  // Get venues that were operational during the period (exclude demo venues)
  // Uses status as single source of truth instead of deprecated isOnboardingDemo boolean
  const activeVenues = await prisma.venue.findMany({
    where: {
      status: {
        in: OPERATIONAL_VENUE_STATUSES, // Only count operational venues
        notIn: DEMO_VENUE_STATUSES, // Exclude LIVE_DEMO and TRIAL
      },
      createdAt: {
        lte: endDate,
      },
    },
    select: {
      id: true,
      createdAt: true,
    },
  })

  const monthlyFeePerVenue = 99
  const _totalDaysInPeriod = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
  let totalSubscriptionRevenue = 0

  // Calculate prorated revenue for each venue based on when it was created
  for (const venue of activeVenues) {
    // Find when the venue became active within our period
    const venueActiveStartDate = venue.createdAt > startDate ? venue.createdAt : startDate

    // Calculate days the venue was active in this period
    const daysActive = Math.ceil((endDate.getTime() - venueActiveStartDate.getTime()) / (1000 * 60 * 60 * 24))

    // Calculate prorated monthly fee (daily rate × days active)
    const dailyRate = monthlyFeePerVenue / 30 // Assuming 30 days per month
    const proratedRevenue = dailyRate * Math.max(0, daysActive)

    totalSubscriptionRevenue += proratedRevenue
  }

  return Math.round(totalSubscriptionRevenue * 100) / 100 // Round to 2 decimal places
}

/**
 * Calculate feature revenue from premium features
 */
async function calculateFeatureRevenue(startDate: Date, endDate: Date): Promise<number> {
  try {
    const venueFeatures = await prisma.venueFeature.findMany({
      where: {
        active: true,
        startDate: {
          lte: endDate,
        },
        OR: [{ endDate: null }, { endDate: { gte: startDate } }],
      },
      include: {
        feature: true,
      },
    })

    return venueFeatures.reduce((sum, vf) => {
      const monthlyPrice = Number(vf.monthlyPrice || vf.feature.monthlyPrice || 0)
      const monthsInPeriod = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 30)))
      return sum + monthlyPrice * monthsInPeriod
    }, 0)
  } catch (error) {
    logger.error('Error calculating feature revenue:', error)
    return 0
  }
}

/**
 * Calculate growth rate compared to previous period
 */
async function calculateGrowthRate(startDate: Date, endDate: Date): Promise<number> {
  try {
    const periodLength = endDate.getTime() - startDate.getTime()
    const previousStart = new Date(startDate.getTime() - periodLength)
    const previousEnd = startDate

    const [currentRevenue, previousRevenue] = await Promise.all([
      getRevenueForPeriod(startDate, endDate),
      getRevenueForPeriod(previousStart, previousEnd),
    ])

    if (previousRevenue === 0) return 0
    return ((currentRevenue - previousRevenue) / previousRevenue) * 100
  } catch (error) {
    logger.error('Error calculating growth rate:', error)
    return 0
  }
}

/**
 * Get revenue for a specific period (exclude demo venues)
 */
async function getRevenueForPeriod(startDate: Date, endDate: Date): Promise<number> {
  const payments = await prisma.payment.findMany({
    where: {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
      status: 'COMPLETED',
      order: {
        venue: PRODUCTION_VENUE_FILTER,
      },
    },
  })

  return payments.reduce((sum, payment) => sum + Number(payment.amount), 0)
}

/**
 * Get revenue breakdown by venue (exclude demo venues)
 */
async function getRevenueByVenue(startDate: Date, endDate: Date): Promise<VenueRevenue[]> {
  try {
    const payments = await prisma.payment.findMany({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
        status: 'COMPLETED',
        order: {
          venue: PRODUCTION_VENUE_FILTER,
        },
      },
      include: {
        order: {
          include: {
            venue: true,
          },
        },
      },
    })

    const venueRevenueMap = new Map<string, VenueRevenue>()

    payments.forEach(payment => {
      const venue = payment.order.venue
      const venueId = venue.id
      const amount = Number(payment.amount)

      if (!venueRevenueMap.has(venueId)) {
        venueRevenueMap.set(venueId, {
          venueId,
          venueName: venue.name,
          revenue: 0,
          commission: 0,
          transactionCount: 0,
          averageOrderValue: 0,
          growth: 0,
        })
      }

      const venueRevenue = venueRevenueMap.get(venueId)!
      venueRevenue.revenue += amount
      venueRevenue.commission += amount * 0.15 // 15% commission
      venueRevenue.transactionCount += 1
    })

    // Calculate average order values
    venueRevenueMap.forEach(venueRevenue => {
      venueRevenue.averageOrderValue = venueRevenue.transactionCount > 0 ? venueRevenue.revenue / venueRevenue.transactionCount : 0
    })

    return Array.from(venueRevenueMap.values()).sort((a, b) => b.revenue - a.revenue)
  } catch (error) {
    logger.error('Error getting revenue by venue:', error)
    return []
  }
}

/**
 * Get revenue breakdown by time period (daily/weekly/monthly) - exclude demo venues
 */
async function getRevenueByPeriod(startDate: Date, endDate: Date): Promise<PeriodRevenue[]> {
  try {
    const payments = await prisma.payment.findMany({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
        status: 'COMPLETED',
        order: {
          venue: PRODUCTION_VENUE_FILTER,
        },
      },
    })

    const periodMap = new Map<string, PeriodRevenue>()

    payments.forEach(payment => {
      const date = payment.createdAt
      const periodKey = date.toISOString().split('T')[0] // Group by day
      const amount = Number(payment.amount)

      if (!periodMap.has(periodKey)) {
        periodMap.set(periodKey, {
          period: periodKey,
          revenue: 0,
          commission: 0,
          transactionCount: 0,
          date: periodKey,
        })
      }

      const periodRevenue = periodMap.get(periodKey)!
      periodRevenue.revenue += amount
      periodRevenue.commission += amount * 0.15
      periodRevenue.transactionCount += 1
    })

    return Array.from(periodMap.values()).sort((a, b) => a.date.localeCompare(b.date))
  } catch (error) {
    logger.error('Error getting revenue by period:', error)
    return []
  }
}

/**
 * Get revenue breakdown by feature
 */
async function getRevenueByFeature(startDate: Date, endDate: Date): Promise<FeatureRevenue[]> {
  try {
    const venueFeatures = await prisma.venueFeature.findMany({
      where: {
        active: true,
        startDate: {
          lte: endDate,
        },
        OR: [{ endDate: null }, { endDate: { gte: startDate } }],
      },
      include: {
        feature: true,
      },
    })

    const featureRevenueMap = new Map<string, FeatureRevenue>()

    venueFeatures.forEach(vf => {
      const feature = vf.feature
      const monthlyPrice = Number(vf.monthlyPrice || feature.monthlyPrice || 0)
      const monthsInPeriod = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 30)))
      const revenue = monthlyPrice * monthsInPeriod

      if (!featureRevenueMap.has(feature.code)) {
        featureRevenueMap.set(feature.code, {
          featureCode: feature.code,
          featureName: feature.name,
          activeVenues: 0,
          monthlyRevenue: monthlyPrice,
          totalRevenue: 0,
        })
      }

      const featureRevenue = featureRevenueMap.get(feature.code)!
      featureRevenue.activeVenues += 1
      featureRevenue.totalRevenue += revenue
    })

    return Array.from(featureRevenueMap.values()).sort((a, b) => b.totalRevenue - a.totalRevenue)
  } catch (error) {
    logger.error('Error getting revenue by feature:', error)
    return []
  }
}

/**
 * Get commission analysis
 */
async function getCommissionAnalysis(startDate: Date, endDate: Date): Promise<CommissionAnalysis> {
  try {
    const venueRevenues = await getRevenueByVenue(startDate, endDate)
    const totalCommission = venueRevenues.reduce((sum, venue) => sum + venue.commission, 0)
    const totalRevenue = venueRevenues.reduce((sum, venue) => sum + venue.revenue, 0)
    const averageCommissionRate = totalRevenue > 0 ? (totalCommission / totalRevenue) * 100 : 0

    const commissionByVenue = venueRevenues.map(venue => ({
      venueId: venue.venueId,
      venueName: venue.venueName,
      commission: venue.commission,
    }))

    // Project monthly commission based on current period
    const daysInPeriod = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)))
    const projectedMonthlyCommission = (totalCommission / daysInPeriod) * 30

    return {
      totalCommission,
      averageCommissionRate,
      commissionByVenue,
      projectedMonthlyCommission,
    }
  } catch (error) {
    logger.error('Error getting commission analysis:', error)
    return {
      totalCommission: 0,
      averageCommissionRate: 0,
      commissionByVenue: [],
      projectedMonthlyCommission: 0,
    }
  }
}

/**
 * Calculate actual platform revenue (what Avoqado earns)
 */
async function calculatePlatformRevenue(
  startDate: Date,
  endDate: Date,
): Promise<{
  totalPlatformRevenue: number
  actualCommissionRevenue: number
  subscriptionRevenue: number
  featureRevenue: number
  invoicedRevenue: number
  settledRevenue: number
}> {
  try {
    // 1. Calculate actual commission revenue from fees collected (exclude demo venues)
    const commissionRevenue = await prisma.payment.aggregate({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
        status: 'COMPLETED',
        order: {
          venue: PRODUCTION_VENUE_FILTER,
        },
      },
      _sum: {
        feeAmount: true,
      },
    })

    // 2. Calculate subscription revenue from venue subscription fees (already filtered)
    const subscriptionRevenue = await calculateSubscriptionRevenue(startDate, endDate)

    // 3. Calculate feature revenue from premium features (already filtered)
    const featureRevenue = await calculateFeatureRevenue(startDate, endDate)

    // 4. Calculate settled revenue (money actually received) - exclude demo venues
    const settledRevenue = await prisma.venueTransaction.aggregate({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
        status: 'SETTLED',
        type: 'PAYMENT',
        venue: PRODUCTION_VENUE_FILTER,
      },
      _sum: {
        feeAmount: true,
      },
    })

    // 5. Calculate invoiced revenue (formal billing)
    const invoicedRevenue = await prisma.invoiceItem.aggregate({
      where: {
        invoice: {
          periodStart: {
            gte: startDate,
          },
          periodEnd: {
            lte: endDate,
          },
          status: {
            in: ['PENDING', 'PAID'],
          },
        },
        type: {
          in: ['TRANSACTION_FEE', 'FEATURE_FEE'],
        },
      },
      _sum: {
        amount: true,
      },
    })

    const actualCommissionRevenue = Number(commissionRevenue._sum.feeAmount || 0)
    const actualFeatureRevenue = Number(featureRevenue)
    const actualSubscriptionRevenue = Number(subscriptionRevenue)
    const actualInvoicedRevenue = Number(invoicedRevenue._sum.amount || 0)
    const actualSettledRevenue = Number(settledRevenue._sum.feeAmount || 0)

    // Total platform revenue = all revenue streams that we actually earn
    const totalPlatformRevenue = actualCommissionRevenue + actualSubscriptionRevenue + actualFeatureRevenue

    return {
      totalPlatformRevenue,
      actualCommissionRevenue,
      subscriptionRevenue: actualSubscriptionRevenue,
      featureRevenue: actualFeatureRevenue,
      invoicedRevenue: actualInvoicedRevenue,
      settledRevenue: actualSettledRevenue,
    }
  } catch (error) {
    logger.error('Error calculating platform revenue:', error)
    return {
      totalPlatformRevenue: 0,
      actualCommissionRevenue: 0,
      subscriptionRevenue: 0,
      featureRevenue: 0,
      invoicedRevenue: 0,
      settledRevenue: 0,
    }
  }
}

/**
 * Get list of all payment providers
 */
export async function getPaymentProvidersList() {
  try {
    logger.info('Getting payment providers list')

    const providers = await prisma.paymentProvider.findMany({
      where: { active: true },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        countryCode: true,
        active: true,
      },
      orderBy: { name: 'asc' },
    })

    return providers
  } catch (error) {
    logger.error('Error getting payment providers list:', error)
    throw new Error('Failed to get payment providers list')
  }
}

/**
 * Get list of merchant accounts, optionally filtered by provider
 */
export async function getMerchantAccountsList(providerId?: string) {
  try {
    logger.info('Getting merchant accounts list', { providerId })

    const whereClause: any = {}
    if (providerId) {
      whereClause.providerId = providerId
    }

    const merchantAccounts = await prisma.merchantAccount.findMany({
      where: whereClause,
      select: {
        id: true,
        externalMerchantId: true,
        alias: true,
        providerId: true,
        provider: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
      },
      orderBy: [{ provider: { name: 'asc' } }, { alias: 'asc' }],
    })

    return merchantAccounts.map(account => ({
      id: account.id,
      externalMerchantId: account.externalMerchantId,
      alias: account.alias,
      providerId: account.providerId,
      providerName: account.provider.name,
      active: true, // Assuming active if not specified
    }))
  } catch (error) {
    logger.error('Error getting merchant accounts list:', error)
    throw new Error('Failed to get merchant accounts list')
  }
}

/**
 * Get simplified venues list for dropdowns (exclude demo venues by default)
 * @param includeDemos - Whether to include demo venues (default: false)
 * @param includeAllStatuses - Whether to include non-operational venues (default: false)
 */
export async function getVenuesListSimple(includeDemos = false, includeAllStatuses = false) {
  try {
    logger.info('Getting venues list (simple)', { includeDemos, includeAllStatuses })

    const venues = await prisma.venue.findMany({
      where: {
        ...(includeAllStatuses ? {} : { status: { in: OPERATIONAL_VENUE_STATUSES } }),
        ...(includeDemos ? {} : PRODUCTION_VENUE_FILTER),
      },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        active: true, // Keep for backwards compatibility
      },
      orderBy: { name: 'asc' },
    })

    return venues
  } catch (error) {
    logger.error('Error getting venues list:', error)
    throw new Error('Failed to get venues list')
  }
}
