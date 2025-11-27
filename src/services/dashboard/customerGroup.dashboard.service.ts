/**
 * Customer Group Service (HTTP-Agnostic Business Logic)
 *
 * WHY: Customer segmentation (VIP, Regular, New) for targeted marketing, loyalty programs, and discounts.
 *
 * PATTERN: Thin Controller + Fat Service Architecture
 * - This service contains ALL business logic
 * - Controllers only orchestrate HTTP (extract params, call service, return response)
 * - Services know NOTHING about Express (req, res, next)
 * - This allows reusing logic in CLI tools, background jobs, tests
 *
 * Example Controller Usage:
 * ```typescript
 * export async function getCustomerGroups(req: Request, res: Response) {
 *   const { venueId } = req.params
 *   const query = req.query
 *   const result = await customerGroupService.getCustomerGroups(venueId, query)
 *   return res.status(200).json(result)
 * }
 * ```
 */

import { BadRequestError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

/**
 * Get all customer groups for a venue with pagination and search
 */
export async function getCustomerGroups(
  venueId: string,
  options: {
    page?: number
    pageSize?: number
    search?: string
  } = {},
) {
  const page = options.page || 1
  const pageSize = options.pageSize || 20
  const skip = (page - 1) * pageSize

  const whereCondition: any = {
    venueId, // ✅ CRITICAL: Multi-tenant filter
  }

  // Search by name or description
  if (options.search) {
    whereCondition.OR = [
      { name: { contains: options.search, mode: 'insensitive' } },
      { description: { contains: options.search, mode: 'insensitive' } },
    ]
  }

  const [groups, totalCount] = await prisma.$transaction([
    prisma.customerGroup.findMany({
      where: whereCondition,
      skip,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        color: true,
        autoAssignRules: true,
        active: true,
        createdAt: true,
        _count: {
          select: {
            customers: true,
          },
        },
      },
    }),
    prisma.customerGroup.count({ where: whereCondition }),
  ])

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: groups.map(group => ({
      ...group,
      customerCount: group._count.customers,
      _count: undefined, // Remove _count from response
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
 * Get a single customer group by ID with detailed stats
 */
export async function getCustomerGroupById(venueId: string, groupId: string) {
  const group = await prisma.customerGroup.findFirst({
    where: {
      id: groupId,
      venueId, // ✅ CRITICAL: Multi-tenant filter
    },
    include: {
      customers: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          totalSpent: true,
          totalVisits: true,
          loyaltyPoints: true,
          createdAt: true,
        },
        orderBy: { totalSpent: 'desc' },
      },
    },
  })

  if (!group) {
    throw new NotFoundError('Customer group not found')
  }

  // Calculate group statistics
  const stats = {
    totalCustomers: group.customers.length,
    totalSpent: group.customers.reduce((sum, c) => sum + c.totalSpent.toNumber(), 0),
    totalVisits: group.customers.reduce((sum, c) => sum + c.totalVisits, 0),
    totalLoyaltyPoints: group.customers.reduce((sum, c) => sum + c.loyaltyPoints, 0),
    avgSpentPerCustomer:
      group.customers.length > 0 ? group.customers.reduce((sum, c) => sum + c.totalSpent.toNumber(), 0) / group.customers.length : 0,
    avgVisitsPerCustomer:
      group.customers.length > 0 ? group.customers.reduce((sum, c) => sum + c.totalVisits, 0) / group.customers.length : 0,
  }

  return {
    ...group,
    customers: group.customers.map(c => ({
      ...c,
      totalSpent: c.totalSpent.toNumber(),
    })),
    stats,
  }
}

/**
 * Create a new customer group
 */
export async function createCustomerGroup(
  venueId: string,
  data: {
    name: string
    description?: string
    color?: string
    autoAssignRules?: any
  },
) {
  // Check for duplicate name in venue
  const existing = await prisma.customerGroup.findFirst({
    where: {
      venueId,
      name: data.name,
    },
  })

  if (existing) {
    throw new BadRequestError(`Customer group "${data.name}" already exists in this venue`)
  }

  const group = await prisma.customerGroup.create({
    data: {
      venueId,
      name: data.name,
      description: data.description,
      color: data.color || '#6B7280', // Default gray
      autoAssignRules: data.autoAssignRules,
    },
    include: {
      _count: {
        select: {
          customers: true,
        },
      },
    },
  })

  return {
    ...group,
    customerCount: group._count.customers,
    _count: undefined,
  }
}

/**
 * Update a customer group
 */
export async function updateCustomerGroup(
  venueId: string,
  groupId: string,
  data: {
    name?: string
    description?: string
    color?: string
    autoAssignRules?: any
    active?: boolean
  },
) {
  // Check if group exists and belongs to venue
  const existing = await prisma.customerGroup.findFirst({
    where: {
      id: groupId,
      venueId,
    },
  })

  if (!existing) {
    throw new NotFoundError('Customer group not found')
  }

  // Check for duplicate name (excluding current group)
  if (data.name) {
    const duplicate = await prisma.customerGroup.findFirst({
      where: {
        venueId,
        name: data.name,
        id: { not: groupId },
      },
    })

    if (duplicate) {
      throw new BadRequestError(`Customer group "${data.name}" already exists in this venue`)
    }
  }

  const group = await prisma.customerGroup.update({
    where: { id: groupId },
    data: {
      name: data.name,
      description: data.description,
      color: data.color,
      autoAssignRules: data.autoAssignRules,
      active: data.active,
    },
    include: {
      _count: {
        select: {
          customers: true,
        },
      },
    },
  })

  return {
    ...group,
    customerCount: group._count.customers,
    _count: undefined,
  }
}

/**
 * Delete a customer group (soft delete)
 */
export async function deleteCustomerGroup(venueId: string, groupId: string) {
  const group = await prisma.customerGroup.findFirst({
    where: {
      id: groupId,
      venueId,
    },
  })

  if (!group) {
    throw new NotFoundError('Customer group not found')
  }

  // Soft delete - set active to false
  await prisma.customerGroup.update({
    where: { id: groupId },
    data: { active: false },
  })

  return { success: true, message: 'Customer group deleted successfully' }
}

/**
 * Assign customers to a group
 */
export async function assignCustomersToGroup(venueId: string, groupId: string, customerIds: string[]) {
  // Verify group exists and belongs to venue
  const group = await prisma.customerGroup.findFirst({
    where: {
      id: groupId,
      venueId,
    },
  })

  if (!group) {
    throw new NotFoundError('Customer group not found')
  }

  // Verify all customers exist and belong to venue
  const customers = await prisma.customer.findMany({
    where: {
      id: { in: customerIds },
      venueId,
    },
  })

  if (customers.length !== customerIds.length) {
    throw new BadRequestError('One or more customers not found or do not belong to this venue')
  }

  // Assign customers to group
  await prisma.customer.updateMany({
    where: {
      id: { in: customerIds },
      venueId,
    },
    data: {
      customerGroupId: groupId,
    },
  })

  return {
    success: true,
    message: `${customerIds.length} customer(s) assigned to group "${group.name}"`,
    assignedCount: customerIds.length,
  }
}

/**
 * Remove customers from a group
 */
export async function removeCustomersFromGroup(venueId: string, groupId: string, customerIds: string[]) {
  // Verify group exists and belongs to venue
  const group = await prisma.customerGroup.findFirst({
    where: {
      id: groupId,
      venueId,
    },
  })

  if (!group) {
    throw new NotFoundError('Customer group not found')
  }

  // Remove customers from group (set customerGroupId to null)
  const result = await prisma.customer.updateMany({
    where: {
      id: { in: customerIds },
      venueId,
      customerGroupId: groupId,
    },
    data: {
      customerGroupId: null,
    },
  })

  return {
    success: true,
    message: `${result.count} customer(s) removed from group "${group.name}"`,
    removedCount: result.count,
  }
}

/**
 * Get customer group statistics
 */
export async function getCustomerGroupStats(venueId: string) {
  const groups = await prisma.customerGroup.findMany({
    where: {
      venueId,
      active: true,
    },
    include: {
      customers: {
        select: {
          totalSpent: true,
          totalVisits: true,
          loyaltyPoints: true,
        },
      },
    },
  })

  const stats = groups.map(group => ({
    id: group.id,
    name: group.name,
    color: group.color,
    customerCount: group.customers.length,
    totalSpent: group.customers.reduce((sum, c) => sum + c.totalSpent.toNumber(), 0),
    totalVisits: group.customers.reduce((sum, c) => sum + c.totalVisits, 0),
    totalLoyaltyPoints: group.customers.reduce((sum, c) => sum + c.loyaltyPoints, 0),
    avgSpentPerCustomer:
      group.customers.length > 0 ? group.customers.reduce((sum, c) => sum + c.totalSpent.toNumber(), 0) / group.customers.length : 0,
  }))

  return {
    totalGroups: groups.length,
    totalCustomersInGroups: groups.reduce((sum, g) => sum + g.customers.length, 0),
    groups: stats,
  }
}
