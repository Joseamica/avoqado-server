import { PrismaClient } from '@prisma/client'
import type { Request } from 'express'
import type { Staff } from '@prisma/client'

const prisma = new PrismaClient()

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
      prisma.venue.count({ where: { isActive: true } }),
      prisma.staff.count()
    ])

    // Get transaction data for revenue calculations
    const payments = await prisma.payment.findMany({
      where: {
        createdAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
        }
      },
      include: {
        order: {
          include: {
            venue: true
          }
        }
      }
    })

    // Calculate revenue metrics
    const totalRevenue = payments.reduce((sum, payment) => sum + payment.amount, 0)
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
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
        }
      }
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
        systemUptime
      },
      revenueMetrics: {
        totalPlatformRevenue: totalRevenue,
        totalCommissionRevenue,
        subscriptionRevenue,
        featureRevenue,
        transactionCount,
        newVenues,
        churnedVenues: 0 // Would calculate based on cancellations
      },
      recentActivity,
      alerts,
      topVenues
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
            phone: true
          }
        },
        staff: {
          where: {
            role: 'ADMIN'
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true
          },
          take: 1
        },
        orders: {
          where: {
            createdAt: {
              gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
            }
          },
          include: {
            payments: true
          }
        }
      }
    })

    return venues.map(venue => {
      const monthlyOrders = venue.orders
      const monthlyRevenue = monthlyOrders.reduce((sum, order) => 
        sum + order.payments.reduce((paySum, payment) => paySum + payment.amount, 0), 0
      )
      const totalTransactions = monthlyOrders.length
      const averageOrderValue = totalTransactions > 0 ? monthlyRevenue / totalTransactions : 0
      const owner = venue.staff[0] || { id: '', firstName: 'Unknown', lastName: 'Owner', email: 'unknown@email.com' }

      return {
        id: venue.id,
        name: venue.name,
        slug: venue.slug || venue.name.toLowerCase().replace(/\s+/g, '-'),
        status: venue.isActive ? 'ACTIVE' : 'INACTIVE',
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
          phone: venue.organization.phone
        },
        owner: {
          id: owner.id,
          firstName: owner.firstName,
          lastName: owner.lastName,
          email: owner.email,
          phone: owner.phone
        },
        features: [], // Would come from feature assignments
        analytics: {
          monthlyTransactions: totalTransactions,
          monthlyRevenue,
          averageOrderValue,
          activeUsers: venue.staff.length,
          lastActivityAt: new Date().toISOString()
        },
        billing: {
          nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          monthlySubscriptionFee: 299,
          additionalFeaturesCost: 0,
          totalMonthlyBill: 299,
          paymentStatus: 'PAID'
        },
        createdAt: venue.createdAt.toISOString(),
        updatedAt: venue.updatedAt.toISOString()
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
      updatedAt: '2024-01-15T10:00:00Z'
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
      updatedAt: '2024-01-10T10:00:00Z'
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
      updatedAt: '2024-01-01T10:00:00Z'
    }
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
        isActive: true,
        updatedAt: new Date()
      }
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
        isActive: false,
        updatedAt: new Date()
      }
    })
    
    // Would also create a suspension record in a real implementation
    console.log(`Venue ${venueId} suspended. Reason: ${reason}`)
  } catch (error) {
    console.error('Error suspending venue:', error)
    throw new Error('Failed to suspend venue')
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
export function verifySuperadminAccess(user: Staff): boolean {
  return user.role === 'SUPERADMIN'
}

// Helper functions
async function generateRecentActivity() {
  return [
    {
      id: '1',
      type: 'venue_approved',
      description: 'New venue "La Taquería" approved',
      venueName: 'La Taquería',
      timestamp: '2 mins ago'
    },
    {
      id: '2',
      type: 'payment_received',
      description: 'Payment received from Premium Plan',
      amount: 299,
      timestamp: '5 mins ago'
    },
    {
      id: '3',
      type: 'feature_enabled',
      description: 'AI Chatbot enabled for "Bistro Central"',
      venueName: 'Bistro Central',
      timestamp: '12 mins ago'
    }
  ]
}

async function generateSystemAlerts() {
  return [
    {
      id: '1',
      type: 'warning' as const,
      title: 'High Churn Alert',
      message: '5 venues cancelled this week',
      isRead: false
    },
    {
      id: '2',
      type: 'error' as const,
      title: 'Payment Failed',
      message: '3 venues have failed payments',
      isRead: false
    }
  ]
}

async function getTopPerformingVenues() {
  return [
    { name: 'Restaurante El Patrón', revenue: 45000, commission: 6750, growth: 12.5 },
    { name: 'Sushi Zen', revenue: 38500, commission: 5775, growth: 8.3 },
    { name: 'Pizza Corner', revenue: 32000, commission: 4800, growth: -2.1 },
    { name: 'Café Bistro', revenue: 28750, commission: 4312, growth: 15.2 }
  ]
}