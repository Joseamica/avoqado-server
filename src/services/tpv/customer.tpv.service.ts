/**
 * Customer TPV Service
 *
 * Optimized for fast customer lookup at checkout.
 * Returns minimal data needed for POS display.
 *
 * @see docs/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md - Phase 1 TPV Customer Lookup
 */

import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'

// ==========================================
// TYPES & INTERFACES
// ==========================================

export interface CustomerSearchResult {
  id: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  loyaltyPoints: number
  totalVisits: number
  totalSpent: number
  customerGroup: {
    id: string
    name: string
    color: string | null
  } | null
}

interface QuickCreateCustomerData {
  firstName?: string
  lastName?: string
  phone?: string
  email?: string
}

// ==========================================
// CUSTOMER SEARCH OPERATIONS
// ==========================================

/**
 * Search customers by phone number
 * Most common lookup at checkout - optimized for speed
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param phone - Phone number (partial match supported)
 * @param limit - Max results (default 5 for quick display)
 */
export async function findCustomerByPhone(venueId: string, phone: string, limit: number = 5): Promise<CustomerSearchResult[]> {
  logger.debug(`🔍 TPV Customer search by phone: ${phone}`, { venueId })

  // Normalize phone: remove spaces, dashes, parentheses
  const normalizedPhone = phone.replace(/[\s\-()]/g, '')

  const customers = await prisma.customer.findMany({
    where: {
      venueId,
      active: true,
      phone: {
        contains: normalizedPhone,
        mode: 'insensitive',
      },
    },
    take: limit,
    orderBy: [{ totalVisits: 'desc' }, { lastVisitAt: 'desc' }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      loyaltyPoints: true,
      totalVisits: true,
      totalSpent: true,
      customerGroup: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
  })

  logger.info(`✅ Found ${customers.length} customers by phone`, {
    venueId,
    phone: normalizedPhone,
    count: customers.length,
  })

  return customers.map(c => ({
    ...c,
    totalSpent: c.totalSpent.toNumber(),
  }))
}

/**
 * Search customers by email address
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param email - Email address (partial match supported)
 * @param limit - Max results (default 5)
 */
export async function findCustomerByEmail(venueId: string, email: string, limit: number = 5): Promise<CustomerSearchResult[]> {
  logger.debug(`🔍 TPV Customer search by email: ${email}`, { venueId })

  const customers = await prisma.customer.findMany({
    where: {
      venueId,
      active: true,
      email: {
        contains: email,
        mode: 'insensitive',
      },
    },
    take: limit,
    orderBy: [{ totalVisits: 'desc' }, { lastVisitAt: 'desc' }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      loyaltyPoints: true,
      totalVisits: true,
      totalSpent: true,
      customerGroup: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
  })

  logger.info(`✅ Found ${customers.length} customers by email`, {
    venueId,
    email,
    count: customers.length,
  })

  return customers.map(c => ({
    ...c,
    totalSpent: c.totalSpent.toNumber(),
  }))
}

/**
 * General customer search (name, email, or phone)
 * For search box in TPV that accepts any input
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param query - Search query (searches firstName, lastName, email, phone)
 * @param limit - Max results (default 10)
 */
export async function searchCustomers(venueId: string, query: string, limit: number = 10): Promise<CustomerSearchResult[]> {
  logger.debug(`🔍 TPV Customer general search: ${query}`, { venueId })

  if (!query || query.trim().length < 2) {
    return []
  }

  const searchTerm = query.trim()

  const customers = await prisma.customer.findMany({
    where: {
      venueId,
      active: true,
      OR: [
        { firstName: { contains: searchTerm, mode: 'insensitive' } },
        { lastName: { contains: searchTerm, mode: 'insensitive' } },
        { email: { contains: searchTerm, mode: 'insensitive' } },
        { phone: { contains: searchTerm.replace(/[\s\-()]/g, ''), mode: 'insensitive' } },
      ],
    },
    take: limit,
    orderBy: [{ totalVisits: 'desc' }, { lastVisitAt: 'desc' }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      loyaltyPoints: true,
      totalVisits: true,
      totalSpent: true,
      customerGroup: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
  })

  logger.info(`✅ Found ${customers.length} customers by search`, {
    venueId,
    query: searchTerm,
    count: customers.length,
  })

  return customers.map(c => ({
    ...c,
    totalSpent: c.totalSpent.toNumber(),
  }))
}

/**
 * Get customer by ID (for checkout confirmation)
 * Returns customer data needed for order association
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param customerId - Customer ID
 */
export async function getCustomerForCheckout(venueId: string, customerId: string): Promise<CustomerSearchResult> {
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId,
      active: true,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      loyaltyPoints: true,
      totalVisits: true,
      totalSpent: true,
      customerGroup: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
  })

  if (!customer) {
    throw new NotFoundError(`Customer ${customerId} not found`)
  }

  return {
    ...customer,
    totalSpent: customer.totalSpent.toNumber(),
  }
}

// ==========================================
// QUICK CREATE OPERATIONS
// ==========================================

/**
 * Quick create a customer during checkout
 * Minimal required data - can be completed later in dashboard
 *
 * @param venueId - Venue ID (multi-tenant assignment)
 * @param data - Customer data (at least phone or email required)
 */
export async function quickCreateCustomer(venueId: string, data: QuickCreateCustomerData): Promise<CustomerSearchResult> {
  logger.info(`🆕 TPV Quick create customer`, { venueId, data })

  // Validate at least phone or email provided
  if (!data.phone && !data.email) {
    throw new BadRequestError('At least phone or email is required')
  }

  // Check for duplicate phone
  if (data.phone) {
    const normalizedPhone = data.phone.replace(/[\s\-()]/g, '')
    const existingByPhone = await prisma.customer.findFirst({
      where: {
        venueId,
        phone: {
          contains: normalizedPhone,
          mode: 'insensitive',
        },
      },
    })

    if (existingByPhone) {
      logger.info(`📋 Customer already exists by phone, returning existing`, {
        venueId,
        customerId: existingByPhone.id,
      })

      // Return existing customer instead of error (better UX for cashiers)
      return {
        id: existingByPhone.id,
        firstName: existingByPhone.firstName,
        lastName: existingByPhone.lastName,
        email: existingByPhone.email,
        phone: existingByPhone.phone,
        loyaltyPoints: existingByPhone.loyaltyPoints,
        totalVisits: existingByPhone.totalVisits,
        totalSpent: existingByPhone.totalSpent.toNumber(),
        customerGroup: null,
      }
    }
  }

  // Check for duplicate email
  if (data.email) {
    const existingByEmail = await prisma.customer.findFirst({
      where: {
        venueId,
        email: {
          equals: data.email,
          mode: 'insensitive',
        },
      },
    })

    if (existingByEmail) {
      logger.info(`📋 Customer already exists by email, returning existing`, {
        venueId,
        customerId: existingByEmail.id,
      })

      return {
        id: existingByEmail.id,
        firstName: existingByEmail.firstName,
        lastName: existingByEmail.lastName,
        email: existingByEmail.email,
        phone: existingByEmail.phone,
        loyaltyPoints: existingByEmail.loyaltyPoints,
        totalVisits: existingByEmail.totalVisits,
        totalSpent: existingByEmail.totalSpent.toNumber(),
        customerGroup: null,
      }
    }
  }

  // Create new customer
  const customer = await prisma.customer.create({
    data: {
      venueId,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone?.replace(/[\s\-()]/g, ''),
      email: data.email?.toLowerCase(),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      loyaltyPoints: true,
      totalVisits: true,
      totalSpent: true,
      customerGroup: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
  })

  logger.info(`✅ Customer created from TPV`, {
    venueId,
    customerId: customer.id,
  })

  return {
    ...customer,
    totalSpent: customer.totalSpent.toNumber(),
  }
}

// ==========================================
// RECENT CUSTOMERS (for quick selection)
// ==========================================

/**
 * Get recent customers for quick selection in TPV
 * Returns customers who visited recently or frequently
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param limit - Max results (default 10)
 */
export async function getRecentCustomers(venueId: string, limit: number = 10): Promise<CustomerSearchResult[]> {
  const customers = await prisma.customer.findMany({
    where: {
      venueId,
      active: true,
      lastVisitAt: { not: null },
    },
    take: limit,
    orderBy: { lastVisitAt: 'desc' },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      loyaltyPoints: true,
      totalVisits: true,
      totalSpent: true,
      customerGroup: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
  })

  return customers.map(c => ({
    ...c,
    totalSpent: c.totalSpent.toNumber(),
  }))
}
