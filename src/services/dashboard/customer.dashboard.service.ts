/**
 * Customer Dashboard Service
 *
 * HTTP-agnostic business logic for customer management.
 * Controllers orchestrate HTTP, services contain logic.
 *
 * @see CLAUDE.md - Layered Architecture section
 */

import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'

// ==========================================
// TYPES & INTERFACES
// ==========================================

interface CustomerListItem {
  id: string
  email: string | null
  phone: string | null
  firstName: string | null
  lastName: string | null
  loyaltyPoints: number
  totalVisits: number
  totalSpent: number
  averageOrderValue: number
  lastVisitAt: Date | null
  customerGroup: {
    id: string
    name: string
    color: string | null
  } | null
  tags: string[]
  active: boolean
  createdAt: Date
}

interface PaginatedCustomersResponse {
  data: CustomerListItem[]
  meta: {
    totalCount: number
    pageSize: number
    currentPage: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
  }
}

interface CreateCustomerRequest {
  email?: string
  phone?: string
  firstName?: string
  lastName?: string
  birthDate?: Date
  gender?: string
  customerGroupId?: string
  notes?: string
  tags?: string[]
  marketingConsent?: boolean
}

interface UpdateCustomerRequest {
  email?: string
  phone?: string
  firstName?: string
  lastName?: string
  birthDate?: Date
  gender?: string
  customerGroupId?: string
  notes?: string
  tags?: string[]
  marketingConsent?: boolean
  active?: boolean
}

interface CustomerStatsResponse {
  totalCustomers: number
  activeCustomers: number
  newCustomersThisMonth: number
  vipCustomers: number // Customers with >10 visits or >$1000 spent
  averageLifetimeValue: number
  averageVisitsPerCustomer: number
  topSpenders: Array<{
    id: string
    name: string
    totalSpent: number
    totalVisits: number
  }>
}

// ==========================================
// CUSTOMER CRUD OPERATIONS
// ==========================================

/**
 * Get all customers for a venue with pagination and search
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param page - Page number (1-indexed)
 * @param pageSize - Items per page
 * @param search - Search term (firstName, lastName, email, phone)
 * @param customerGroupId - Filter by customer group
 * @param noGroup - Filter customers without a group
 * @param tags - Filter by tags (comma-separated)
 */
export async function getCustomers(
  venueId: string,
  page: number = 1,
  pageSize: number = 20,
  search?: string,
  customerGroupId?: string,
  noGroup?: boolean,
  tags?: string,
): Promise<PaginatedCustomersResponse> {
  const skip = (page - 1) * pageSize

  // Build search conditions
  const searchConditions = search
    ? {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {}

  // Build tag filter
  const tagFilter = tags
    ? {
        tags: {
          hasSome: tags.split(',').map(t => t.trim()),
        },
      }
    : {}

  // Build group filter (customerGroupId takes precedence over noGroup)
  const groupFilter = customerGroupId ? { customerGroupId } : noGroup ? { customerGroupId: null } : {}

  const whereCondition = {
    venueId, // ✅ CRITICAL: Multi-tenant filter
    ...groupFilter,
    ...tagFilter,
    ...searchConditions,
  }

  const [customers, totalCount] = await prisma.$transaction([
    prisma.customer.findMany({
      where: whereCondition,
      skip,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        loyaltyPoints: true,
        totalVisits: true,
        totalSpent: true,
        averageOrderValue: true,
        lastVisitAt: true,
        customerGroup: {
          select: {
            id: true,
            name: true,
            color: true,
          },
        },
        tags: true,
        active: true,
        createdAt: true,
      },
    }),
    prisma.customer.count({ where: whereCondition }),
  ])

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: customers.map(customer => ({
      ...customer,
      totalSpent: customer.totalSpent.toNumber(),
      averageOrderValue: customer.averageOrderValue.toNumber(),
    })),
    meta: {
      totalCount,
      pageSize,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  }
}

/**
 * Get a single customer by ID
 */
export async function getCustomerById(venueId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId, // ✅ CRITICAL: Multi-tenant filter
    },
    include: {
      customerGroup: true,
      orders: {
        take: 10,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          total: true,
          status: true,
          createdAt: true,
        },
      },
      loyaltyTransactions: {
        take: 20,
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  if (!customer) {
    throw new NotFoundError(`Customer with ID ${customerId} not found`)
  }

  return customer
}

/**
 * Create a new customer
 */
export async function createCustomer(venueId: string, data: CreateCustomerRequest) {
  // Validate email or phone is provided
  if (!data.email && !data.phone) {
    throw new BadRequestError('Either email or phone must be provided')
  }

  // Check for duplicate email/phone in this venue
  if (data.email) {
    const existingByEmail = await prisma.customer.findFirst({
      where: {
        venueId,
        email: data.email,
      },
    })

    if (existingByEmail) {
      throw new BadRequestError(`Customer with email ${data.email} already exists in this venue`)
    }
  }

  if (data.phone) {
    const existingByPhone = await prisma.customer.findFirst({
      where: {
        venueId,
        phone: data.phone,
      },
    })

    if (existingByPhone) {
      throw new BadRequestError(`Customer with phone ${data.phone} already exists in this venue`)
    }
  }

  // Validate customerGroupId if provided
  if (data.customerGroupId) {
    const group = await prisma.customerGroup.findFirst({
      where: {
        id: data.customerGroupId,
        venueId, // ✅ Ensure group belongs to this venue
      },
    })

    if (!group) {
      throw new NotFoundError(`Customer group with ID ${data.customerGroupId} not found in this venue`)
    }
  }

  const customer = await prisma.customer.create({
    data: {
      venueId, // ✅ CRITICAL: Multi-tenant assignment
      email: data.email,
      phone: data.phone,
      firstName: data.firstName,
      lastName: data.lastName,
      birthDate: data.birthDate,
      gender: data.gender,
      customerGroupId: data.customerGroupId,
      notes: data.notes,
      tags: data.tags || [],
      marketingConsent: data.marketingConsent ?? false,
    },
    include: {
      customerGroup: true,
    },
  })

  logger.info(`Customer created: ${customer.id} (${customer.email || customer.phone})`, {
    venueId,
    customerId: customer.id,
  })

  return customer
}

/**
 * Update an existing customer
 */
export async function updateCustomer(venueId: string, customerId: string, data: UpdateCustomerRequest) {
  // Check if customer exists and belongs to this venue
  const existingCustomer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId, // ✅ CRITICAL: Multi-tenant filter
    },
  })

  if (!existingCustomer) {
    throw new NotFoundError(`Customer with ID ${customerId} not found`)
  }

  // Check for duplicate email/phone (excluding current customer)
  if (data.email && data.email !== existingCustomer.email) {
    const duplicateEmail = await prisma.customer.findFirst({
      where: {
        venueId,
        email: data.email,
        id: { not: customerId },
      },
    })

    if (duplicateEmail) {
      throw new BadRequestError(`Customer with email ${data.email} already exists`)
    }
  }

  if (data.phone && data.phone !== existingCustomer.phone) {
    const duplicatePhone = await prisma.customer.findFirst({
      where: {
        venueId,
        phone: data.phone,
        id: { not: customerId },
      },
    })

    if (duplicatePhone) {
      throw new BadRequestError(`Customer with phone ${data.phone} already exists`)
    }
  }

  // Validate customerGroupId if provided
  if (data.customerGroupId) {
    const group = await prisma.customerGroup.findFirst({
      where: {
        id: data.customerGroupId,
        venueId,
      },
    })

    if (!group) {
      throw new NotFoundError(`Customer group with ID ${data.customerGroupId} not found`)
    }
  }

  const updatedCustomer = await prisma.customer.update({
    where: { id: customerId },
    data: {
      email: data.email,
      phone: data.phone,
      firstName: data.firstName,
      lastName: data.lastName,
      birthDate: data.birthDate,
      gender: data.gender,
      customerGroupId: data.customerGroupId,
      notes: data.notes,
      tags: data.tags,
      marketingConsent: data.marketingConsent,
      active: data.active,
    },
    include: {
      customerGroup: true,
    },
  })

  logger.info(`Customer updated: ${customerId}`, {
    venueId,
    customerId,
  })

  return updatedCustomer
}

/**
 * Delete a customer (soft delete by setting active=false)
 */
export async function deleteCustomer(venueId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId, // ✅ CRITICAL: Multi-tenant filter
    },
  })

  if (!customer) {
    throw new NotFoundError(`Customer with ID ${customerId} not found`)
  }

  // Soft delete (set active=false)
  await prisma.customer.update({
    where: { id: customerId },
    data: { active: false },
  })

  logger.info(`Customer soft-deleted: ${customerId}`, {
    venueId,
    customerId,
  })

  return { success: true, message: 'Customer deactivated successfully' }
}

// ==========================================
// CUSTOMER STATISTICS & ANALYTICS
// ==========================================

/**
 * Get customer statistics for dashboard
 */
export async function getCustomerStats(venueId: string): Promise<CustomerStatsResponse> {
  const now = new Date()
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const [totalCustomers, activeCustomers, newCustomersThisMonth, vipCustomers, avgStats, topSpenders] = await prisma.$transaction([
    // Total customers
    prisma.customer.count({
      where: { venueId },
    }),

    // Active customers
    prisma.customer.count({
      where: { venueId, active: true },
    }),

    // New customers this month
    prisma.customer.count({
      where: {
        venueId,
        createdAt: { gte: firstDayOfMonth },
      },
    }),

    // VIP customers (>10 visits OR >$1000 spent)
    prisma.customer.count({
      where: {
        venueId,
        OR: [{ totalVisits: { gt: 10 } }, { totalSpent: { gt: 1000 } }],
      },
    }),

    // Average lifetime value and visits
    prisma.customer.aggregate({
      where: { venueId },
      _avg: {
        totalSpent: true,
        totalVisits: true,
      },
    }),

    // Top 5 spenders
    prisma.customer.findMany({
      where: { venueId },
      orderBy: { totalSpent: 'desc' },
      take: 5,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        totalSpent: true,
        totalVisits: true,
      },
    }),
  ])

  return {
    totalCustomers,
    activeCustomers,
    newCustomersThisMonth,
    vipCustomers,
    averageLifetimeValue: avgStats._avg.totalSpent?.toNumber() || 0,
    averageVisitsPerCustomer: avgStats._avg.totalVisits || 0,
    topSpenders: topSpenders.map(c => ({
      id: c.id,
      name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown',
      totalSpent: c.totalSpent.toNumber(),
      totalVisits: c.totalVisits,
    })),
  }
}

/**
 * Update customer metrics when an order is completed
 * (Called from order/payment service)
 */
export async function updateCustomerMetrics(customerId: string, orderTotal: number) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      totalVisits: true,
      totalSpent: true,
      firstVisitAt: true,
    },
  })

  if (!customer) {
    logger.warn(`Customer ${customerId} not found for metrics update`)
    return
  }

  const newTotalVisits = customer.totalVisits + 1
  const newTotalSpent = customer.totalSpent.toNumber() + orderTotal
  const newAverageOrderValue = newTotalSpent / newTotalVisits

  await prisma.customer.update({
    where: { id: customerId },
    data: {
      totalVisits: newTotalVisits,
      totalSpent: newTotalSpent,
      averageOrderValue: newAverageOrderValue,
      lastVisitAt: new Date(),
      firstVisitAt: customer.firstVisitAt || new Date(), // Set only if null
    },
  })

  logger.info(`Customer metrics updated: ${customerId}`, {
    customerId,
    totalVisits: newTotalVisits,
    totalSpent: newTotalSpent,
  })
}
