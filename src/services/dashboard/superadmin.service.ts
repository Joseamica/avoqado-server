import prisma from '@/utils/prismaClient'

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
  }
  revenueMetrics: {
    totalPlatformRevenue: number
    totalCommissionRevenue: number
    subscriptionRevenue: number
    featureRevenue: number
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
  status: string
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
    // Get venue statistics
    const [totalVenues, activeVenues, totalUsers] = await Promise.all([
      prisma.venue.count(),
      prisma.venue.count({ where: { active: true } }),
      prisma.staff.count(),
    ])

    // Get transaction data for revenue calculations
    const payments = await prisma.payment.findMany({
      where: {
        createdAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
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
    const averageRevenuePerUser = totalUsers > 0 ? totalRevenue / totalUsers : 0

    // Calculate commission (assuming 15% average commission rate)
    const totalCommissionRevenue = totalRevenue * 0.15
    const subscriptionRevenue = totalRevenue * 0.6 // 60% from subscriptions
    const featureRevenue = totalRevenue * 0.25 // 25% from features

    // Get recent venue registrations for growth metrics
    const recentVenues = await prisma.venue.findMany({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
        },
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

    return {
      kpis: {
        totalRevenue,
        monthlyRecurringRevenue,
        totalVenues,
        activeVenues,
        totalUsers,
        averageRevenuePerUser,
        churnRate,
        growthRate,
        systemUptime,
      },
      revenueMetrics: {
        totalPlatformRevenue: totalRevenue,
        totalCommissionRevenue,
        subscriptionRevenue,
        featureRevenue,
        transactionCount,
        newVenues,
        churnedVenues: 0, // Would calculate based on cancellations
      },
      recentActivity,
      alerts,
      topVenues,
    }
  } catch (error) {
    console.error('Error getting superadmin dashboard data:', error)
    throw new Error('Failed to fetch dashboard data')
  }
}

/**
 * Get all venues with detailed information for superadmin management
 */
export async function getAllVenuesForSuperadmin(): Promise<SuperadminVenue[]> {
  try {
    const venues = await prisma.venue.findMany({
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
        status: venue.active ? 'ACTIVE' : 'INACTIVE',
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
        createdAt: venue.createdAt.toISOString(),
        updatedAt: venue.updatedAt.toISOString(),
      }
    })
  } catch (error) {
    console.error('Error getting venues for superadmin:', error)
    throw new Error('Failed to fetch venues data')
  }
}

/**
 * Get all platform features for management
 */
export async function getAllPlatformFeatures(): Promise<PlatformFeature[]> {
  // For now, return static features since we don't have a features table yet
  // In a real implementation, this would query a features table
  return [
    {
      id: '1',
      code: 'ai_chatbot',
      name: 'AI Chatbot',
      description: 'Intelligent customer support chatbot powered by AI',
      category: 'AI',
      status: 'ACTIVE',
      pricingModel: 'FIXED',
      basePrice: 49.99,
      isCore: false,
      createdAt: '2024-01-15T10:00:00Z',
      updatedAt: '2024-01-15T10:00:00Z',
    },
    {
      id: '2',
      code: 'advanced_analytics',
      name: 'Advanced Analytics',
      description: 'Deep insights and custom reports for business intelligence',
      category: 'ANALYTICS',
      status: 'ACTIVE',
      pricingModel: 'TIERED',
      basePrice: 29.99,
      isCore: false,
      createdAt: '2024-01-10T10:00:00Z',
      updatedAt: '2024-01-10T10:00:00Z',
    },
    {
      id: '3',
      code: 'pos_integration',
      name: 'POS Integration',
      description: 'Core point-of-sale system integration',
      category: 'CORE',
      status: 'ACTIVE',
      pricingModel: 'FREE',
      isCore: true,
      createdAt: '2024-01-01T10:00:00Z',
      updatedAt: '2024-01-01T10:00:00Z',
    },
  ]
}

/**
 * Approve a venue for platform access
 */
export async function approveVenue(venueId: string, approvedBy: string): Promise<void> {
  try {
    await prisma.venue.update({
      where: { id: venueId },
      data: {
        active: true,
        updatedAt: new Date(),
      },
    })

    // Would also create an approval record in a real implementation
    console.log(`Venue ${venueId} approved by ${approvedBy}`)
  } catch (error) {
    console.error('Error approving venue:', error)
    throw new Error('Failed to approve venue')
  }
}

/**
 * Suspend a venue
 */
export async function suspendVenue(venueId: string, reason: string): Promise<void> {
  try {
    await prisma.venue.update({
      where: { id: venueId },
      data: {
        active: false,
        updatedAt: new Date(),
      },
    })

    // Would also create a suspension record in a real implementation
    console.log(`Venue ${venueId} suspended. Reason: ${reason}`)
  } catch (error) {
    console.error('Error suspending venue:', error)
    throw new Error('Failed to suspend venue')
  }
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
    console.error('Error enabling feature for venue:', error)
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
    console.error('Error disabling feature for venue:', error)
    throw new Error('Failed to disable feature for venue')
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
    console.error('Error getting venue details:', error)
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

    // Get all payments in the date range
    const payments = await prisma.payment.findMany({
      where: {
        createdAt: {
          gte: start,
          lte: end,
        },
        status: 'COMPLETED', // Only count completed payments
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
    console.error('Error calculating revenue metrics:', error)
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
    console.error('Error getting revenue breakdown:', error)
    throw new Error('Failed to get revenue breakdown')
  }
}

/**
 * Calculate subscription revenue from venue monthly fees
 */
async function calculateSubscriptionRevenue(startDate: Date, endDate: Date): Promise<number> {
  // This would calculate based on venue subscription fees
  // For now, we'll calculate based on active venues and their plan pricing
  const activeVenues = await prisma.venue.count({
    where: {
      active: true,
      createdAt: {
        lte: endDate,
      },
    },
  })

  // Assuming average monthly subscription of $99 per venue
  const monthlyFeePerVenue = 99
  const monthsInPeriod = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 30)))

  return activeVenues * monthlyFeePerVenue * monthsInPeriod
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
    console.error('Error calculating feature revenue:', error)
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
    console.error('Error calculating growth rate:', error)
    return 0
  }
}

/**
 * Get revenue for a specific period
 */
async function getRevenueForPeriod(startDate: Date, endDate: Date): Promise<number> {
  const payments = await prisma.payment.findMany({
    where: {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
      status: 'COMPLETED',
    },
  })

  return payments.reduce((sum, payment) => sum + Number(payment.amount), 0)
}

/**
 * Get revenue breakdown by venue
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
    console.error('Error getting revenue by venue:', error)
    return []
  }
}

/**
 * Get revenue breakdown by time period (daily/weekly/monthly)
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
    console.error('Error getting revenue by period:', error)
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
    console.error('Error getting revenue by feature:', error)
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
    console.error('Error getting commission analysis:', error)
    return {
      totalCommission: 0,
      averageCommissionRate: 0,
      commissionByVenue: [],
      projectedMonthlyCommission: 0,
    }
  }
}
