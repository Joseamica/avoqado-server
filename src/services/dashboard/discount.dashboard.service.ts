/**
 * Discount Dashboard Service
 *
 * HTTP-agnostic business logic for discount management.
 * Controllers orchestrate HTTP, services contain logic.
 *
 * @see CLAUDE.md - Layered Architecture section
 * @see docs/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md - Phase 2 specifications
 */

import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'
import { DiscountType, DiscountScope, Prisma } from '@prisma/client'

// ==========================================
// TYPES & INTERFACES
// ==========================================

interface DiscountListItem {
  id: string
  name: string
  description: string | null
  type: DiscountType
  value: number
  scope: DiscountScope
  customerGroupId: string | null
  customerGroup: {
    id: string
    name: string
    color: string | null
  } | null
  isAutomatic: boolean
  priority: number
  validFrom: Date | null
  validUntil: Date | null
  maxTotalUses: number | null
  currentUses: number
  isStackable: boolean
  active: boolean
  createdAt: Date
  // Coupon codes count
  _count: {
    couponCodes: number
    customerDiscounts: number
    orderDiscounts: number
  }
}

interface PaginatedDiscountsResponse {
  data: DiscountListItem[]
  meta: {
    totalCount: number
    pageSize: number
    currentPage: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
  }
}

interface CreateDiscountRequest {
  name: string
  description?: string
  type: DiscountType
  value: number
  scope?: DiscountScope
  // Target IDs
  targetItemIds?: string[]
  targetCategoryIds?: string[]
  targetModifierIds?: string[]
  targetModifierGroupIds?: string[]
  customerGroupId?: string
  // Automatic application
  isAutomatic?: boolean
  priority?: number
  // Rules
  minPurchaseAmount?: number
  maxDiscountAmount?: number
  minQuantity?: number
  // BOGO
  buyQuantity?: number
  getQuantity?: number
  getDiscountPercent?: number
  buyItemIds?: string[]
  getItemIds?: string[]
  // Time-based
  validFrom?: Date
  validUntil?: Date
  daysOfWeek?: number[]
  timeFrom?: string
  timeUntil?: string
  // Usage limits
  maxTotalUses?: number
  maxUsesPerCustomer?: number
  // Comp-specific
  requiresApproval?: boolean
  compReason?: string
  // Tax handling
  applyBeforeTax?: boolean
  modifyTaxBasis?: boolean
  // Stacking
  isStackable?: boolean
  stackPriority?: number
  // Status
  active?: boolean
}

interface UpdateDiscountRequest {
  name?: string
  description?: string | null
  type?: DiscountType
  value?: number
  scope?: DiscountScope
  targetItemIds?: string[]
  targetCategoryIds?: string[]
  targetModifierIds?: string[]
  targetModifierGroupIds?: string[]
  customerGroupId?: string | null
  isAutomatic?: boolean
  priority?: number
  minPurchaseAmount?: number | null
  maxDiscountAmount?: number | null
  minQuantity?: number | null
  buyQuantity?: number | null
  getQuantity?: number | null
  getDiscountPercent?: number | null
  buyItemIds?: string[]
  getItemIds?: string[]
  validFrom?: Date | null
  validUntil?: Date | null
  daysOfWeek?: number[]
  timeFrom?: string | null
  timeUntil?: string | null
  maxTotalUses?: number | null
  maxUsesPerCustomer?: number | null
  requiresApproval?: boolean
  compReason?: string | null
  applyBeforeTax?: boolean
  modifyTaxBasis?: boolean
  isStackable?: boolean
  stackPriority?: number
  active?: boolean
}

interface DiscountStatsResponse {
  totalDiscounts: number
  activeDiscounts: number
  automaticDiscounts: number
  totalRedemptions: number
  totalSaved: number
  topDiscounts: Array<{
    id: string
    name: string
    type: DiscountType
    redemptions: number
    totalSaved: number
  }>
}

// ==========================================
// DISCOUNT CRUD OPERATIONS
// ==========================================

/**
 * Get all discounts for a venue with pagination and filtering
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param page - Page number (1-indexed)
 * @param pageSize - Items per page
 * @param search - Search term (name, description)
 * @param type - Filter by discount type
 * @param scope - Filter by discount scope
 * @param isAutomatic - Filter by automatic flag
 * @param active - Filter by active status
 */
export async function getDiscounts(
  venueId: string,
  page: number = 1,
  pageSize: number = 20,
  search?: string,
  type?: DiscountType,
  scope?: DiscountScope,
  isAutomatic?: boolean,
  active?: boolean,
): Promise<PaginatedDiscountsResponse> {
  const skip = (page - 1) * pageSize

  // Build where clause
  const where: Prisma.DiscountWhereInput = {
    venueId,
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' as const } },
        { description: { contains: search, mode: 'insensitive' as const } },
      ],
    }),
    ...(type && { type }),
    ...(scope && { scope }),
    ...(isAutomatic !== undefined && { isAutomatic }),
    ...(active !== undefined && { active }),
  }

  // Execute count and fetch in parallel
  const [totalCount, discounts] = await Promise.all([
    prisma.discount.count({ where }),
    prisma.discount.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      include: {
        customerGroup: {
          select: {
            id: true,
            name: true,
            color: true,
          },
        },
        _count: {
          select: {
            couponCodes: true,
            customerDiscounts: true,
            orderDiscounts: true,
          },
        },
      },
    }),
  ])

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: discounts.map(d => ({
      ...d,
      value: Number(d.value),
    })) as unknown as DiscountListItem[],
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
 * Get a single discount by ID
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param discountId - Discount ID
 * @throws NotFoundError if discount not found
 */
export async function getDiscountById(venueId: string, discountId: string) {
  const discount = await prisma.discount.findFirst({
    where: {
      id: discountId,
      venueId,
    },
    include: {
      customerGroup: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
      couponCodes: {
        select: {
          id: true,
          code: true,
          maxUses: true,
          currentUses: true,
          validFrom: true,
          validUntil: true,
          active: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
      customerDiscounts: {
        include: {
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
            },
          },
        },
        take: 10,
      },
      _count: {
        select: {
          couponCodes: true,
          customerDiscounts: true,
          orderDiscounts: true,
        },
      },
    },
  })

  if (!discount) {
    throw new NotFoundError('Discount not found')
  }

  return {
    ...discount,
    value: Number(discount.value),
    minPurchaseAmount: discount.minPurchaseAmount ? Number(discount.minPurchaseAmount) : null,
    maxDiscountAmount: discount.maxDiscountAmount ? Number(discount.maxDiscountAmount) : null,
    getDiscountPercent: discount.getDiscountPercent ? Number(discount.getDiscountPercent) : null,
  }
}

/**
 * Create a new discount
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param data - Discount data
 * @param createdById - Staff ID who created the discount
 */
export async function createDiscount(venueId: string, data: CreateDiscountRequest, createdById?: string) {
  // Validate customer group if provided
  if (data.customerGroupId) {
    const group = await prisma.customerGroup.findFirst({
      where: { id: data.customerGroupId, venueId },
    })
    if (!group) {
      throw new BadRequestError('Customer group not found')
    }
  }

  // Validate BOGO configuration
  if (data.scope === 'QUANTITY' || data.buyQuantity || data.getQuantity) {
    if (!data.buyQuantity || !data.getQuantity) {
      throw new BadRequestError('BOGO discounts require both buyQuantity and getQuantity')
    }
    if (data.getDiscountPercent === undefined) {
      data.getDiscountPercent = 100 // Default: free item
    }
  }

  // Validate time-based configuration
  if (data.timeFrom && !data.timeUntil) {
    throw new BadRequestError('timeUntil is required when timeFrom is set')
  }
  if (data.timeUntil && !data.timeFrom) {
    throw new BadRequestError('timeFrom is required when timeUntil is set')
  }

  // Validate value based on type
  if (data.type === 'PERCENTAGE') {
    if (data.value < 0 || data.value > 100) {
      throw new BadRequestError('Percentage discount value must be between 0 and 100')
    }
  } else if (data.type === 'FIXED_AMOUNT') {
    if (data.value < 0) {
      throw new BadRequestError('Fixed amount discount value must be positive')
    }
  } else if (data.type === 'COMP') {
    data.value = 100 // Comp is always 100%
  }

  const discount = await prisma.discount.create({
    data: {
      venueId,
      name: data.name,
      description: data.description,
      type: data.type,
      value: data.value,
      scope: data.scope || 'ORDER',
      targetItemIds: data.targetItemIds || [],
      targetCategoryIds: data.targetCategoryIds || [],
      targetModifierIds: data.targetModifierIds || [],
      targetModifierGroupIds: data.targetModifierGroupIds || [],
      customerGroupId: data.customerGroupId,
      isAutomatic: data.isAutomatic ?? false,
      priority: data.priority ?? 0,
      minPurchaseAmount: data.minPurchaseAmount,
      maxDiscountAmount: data.maxDiscountAmount,
      minQuantity: data.minQuantity,
      buyQuantity: data.buyQuantity,
      getQuantity: data.getQuantity,
      getDiscountPercent: data.getDiscountPercent,
      buyItemIds: data.buyItemIds || [],
      getItemIds: data.getItemIds || [],
      validFrom: data.validFrom,
      validUntil: data.validUntil,
      daysOfWeek: data.daysOfWeek || [],
      timeFrom: data.timeFrom,
      timeUntil: data.timeUntil,
      maxTotalUses: data.maxTotalUses,
      maxUsesPerCustomer: data.maxUsesPerCustomer,
      requiresApproval: data.requiresApproval ?? false,
      compReason: data.compReason,
      applyBeforeTax: data.applyBeforeTax ?? true,
      modifyTaxBasis: data.modifyTaxBasis ?? true,
      isStackable: data.isStackable ?? false,
      stackPriority: data.stackPriority ?? 0,
      active: data.active ?? true,
      createdById,
    },
    include: {
      customerGroup: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
  })

  logger.info(`🎟️ Discount created: ${discount.name} (${discount.id}) for venue ${venueId}`)

  return {
    ...discount,
    value: Number(discount.value),
  }
}

/**
 * Update an existing discount
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param discountId - Discount ID
 * @param data - Update data
 * @throws NotFoundError if discount not found
 */
export async function updateDiscount(venueId: string, discountId: string, data: UpdateDiscountRequest) {
  // Check discount exists
  const existing = await prisma.discount.findFirst({
    where: { id: discountId, venueId },
  })
  if (!existing) {
    throw new NotFoundError('Discount not found')
  }

  // Validate customer group if provided
  if (data.customerGroupId) {
    const group = await prisma.customerGroup.findFirst({
      where: { id: data.customerGroupId, venueId },
    })
    if (!group) {
      throw new BadRequestError('Customer group not found')
    }
  }

  // Validate value based on type
  const type = data.type ?? existing.type
  const value = data.value ?? Number(existing.value)

  if (type === 'PERCENTAGE') {
    if (value < 0 || value > 100) {
      throw new BadRequestError('Percentage discount value must be between 0 and 100')
    }
  } else if (type === 'FIXED_AMOUNT') {
    if (value < 0) {
      throw new BadRequestError('Fixed amount discount value must be positive')
    }
  }

  const discount = await prisma.discount.update({
    where: { id: discountId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.type !== undefined && { type: data.type }),
      ...(data.value !== undefined && { value: data.value }),
      ...(data.scope !== undefined && { scope: data.scope }),
      ...(data.targetItemIds !== undefined && { targetItemIds: data.targetItemIds }),
      ...(data.targetCategoryIds !== undefined && { targetCategoryIds: data.targetCategoryIds }),
      ...(data.targetModifierIds !== undefined && { targetModifierIds: data.targetModifierIds }),
      ...(data.targetModifierGroupIds !== undefined && { targetModifierGroupIds: data.targetModifierGroupIds }),
      ...(data.customerGroupId !== undefined && { customerGroupId: data.customerGroupId }),
      ...(data.isAutomatic !== undefined && { isAutomatic: data.isAutomatic }),
      ...(data.priority !== undefined && { priority: data.priority }),
      ...(data.minPurchaseAmount !== undefined && { minPurchaseAmount: data.minPurchaseAmount }),
      ...(data.maxDiscountAmount !== undefined && { maxDiscountAmount: data.maxDiscountAmount }),
      ...(data.minQuantity !== undefined && { minQuantity: data.minQuantity }),
      ...(data.buyQuantity !== undefined && { buyQuantity: data.buyQuantity }),
      ...(data.getQuantity !== undefined && { getQuantity: data.getQuantity }),
      ...(data.getDiscountPercent !== undefined && { getDiscountPercent: data.getDiscountPercent }),
      ...(data.buyItemIds !== undefined && { buyItemIds: data.buyItemIds }),
      ...(data.getItemIds !== undefined && { getItemIds: data.getItemIds }),
      ...(data.validFrom !== undefined && { validFrom: data.validFrom }),
      ...(data.validUntil !== undefined && { validUntil: data.validUntil }),
      ...(data.daysOfWeek !== undefined && { daysOfWeek: data.daysOfWeek }),
      ...(data.timeFrom !== undefined && { timeFrom: data.timeFrom }),
      ...(data.timeUntil !== undefined && { timeUntil: data.timeUntil }),
      ...(data.maxTotalUses !== undefined && { maxTotalUses: data.maxTotalUses }),
      ...(data.maxUsesPerCustomer !== undefined && { maxUsesPerCustomer: data.maxUsesPerCustomer }),
      ...(data.requiresApproval !== undefined && { requiresApproval: data.requiresApproval }),
      ...(data.compReason !== undefined && { compReason: data.compReason }),
      ...(data.applyBeforeTax !== undefined && { applyBeforeTax: data.applyBeforeTax }),
      ...(data.modifyTaxBasis !== undefined && { modifyTaxBasis: data.modifyTaxBasis }),
      ...(data.isStackable !== undefined && { isStackable: data.isStackable }),
      ...(data.stackPriority !== undefined && { stackPriority: data.stackPriority }),
      ...(data.active !== undefined && { active: data.active }),
    },
    include: {
      customerGroup: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
  })

  logger.info(`🎟️ Discount updated: ${discount.name} (${discount.id})`)

  return {
    ...discount,
    value: Number(discount.value),
  }
}

/**
 * Delete a discount
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param discountId - Discount ID
 * @throws NotFoundError if discount not found
 */
export async function deleteDiscount(venueId: string, discountId: string): Promise<void> {
  const existing = await prisma.discount.findFirst({
    where: { id: discountId, venueId },
  })
  if (!existing) {
    throw new NotFoundError('Discount not found')
  }

  await prisma.discount.delete({
    where: { id: discountId },
  })

  logger.info(`🗑️ Discount deleted: ${existing.name} (${discountId})`)
}

/**
 * Clone a discount (create a copy)
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param discountId - Discount ID to clone
 * @param createdById - Staff ID who created the clone
 */
export async function cloneDiscount(venueId: string, discountId: string, createdById?: string) {
  const original = await prisma.discount.findFirst({
    where: { id: discountId, venueId },
  })
  if (!original) {
    throw new NotFoundError('Discount not found')
  }

  const clone = await prisma.discount.create({
    data: {
      venueId,
      name: `${original.name} (Copy)`,
      description: original.description,
      type: original.type,
      value: original.value,
      scope: original.scope,
      targetItemIds: original.targetItemIds,
      targetCategoryIds: original.targetCategoryIds,
      targetModifierIds: original.targetModifierIds,
      targetModifierGroupIds: original.targetModifierGroupIds,
      customerGroupId: original.customerGroupId,
      isAutomatic: original.isAutomatic,
      priority: original.priority,
      minPurchaseAmount: original.minPurchaseAmount,
      maxDiscountAmount: original.maxDiscountAmount,
      minQuantity: original.minQuantity,
      buyQuantity: original.buyQuantity,
      getQuantity: original.getQuantity,
      getDiscountPercent: original.getDiscountPercent,
      buyItemIds: original.buyItemIds,
      getItemIds: original.getItemIds,
      validFrom: original.validFrom,
      validUntil: original.validUntil,
      daysOfWeek: original.daysOfWeek,
      timeFrom: original.timeFrom,
      timeUntil: original.timeUntil,
      maxTotalUses: original.maxTotalUses,
      maxUsesPerCustomer: original.maxUsesPerCustomer,
      requiresApproval: original.requiresApproval,
      compReason: original.compReason,
      applyBeforeTax: original.applyBeforeTax,
      modifyTaxBasis: original.modifyTaxBasis,
      isStackable: original.isStackable,
      stackPriority: original.stackPriority,
      active: false, // Clone starts inactive
      currentUses: 0, // Reset usage counter
      createdById,
    },
    include: {
      customerGroup: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
  })

  logger.info(`🎟️ Discount cloned: ${original.name} -> ${clone.name} (${clone.id})`)

  return {
    ...clone,
    value: Number(clone.value),
  }
}

// ==========================================
// DISCOUNT STATISTICS
// ==========================================

/**
 * Get discount statistics for a venue
 *
 * @param venueId - Venue ID (multi-tenant filter)
 */
export async function getDiscountStats(venueId: string): Promise<DiscountStatsResponse> {
  // Get aggregate stats
  const [totalDiscounts, activeDiscounts, automaticDiscounts, orderDiscounts] = await Promise.all([
    prisma.discount.count({ where: { venueId } }),
    prisma.discount.count({ where: { venueId, active: true } }),
    prisma.discount.count({ where: { venueId, isAutomatic: true, active: true } }),
    prisma.orderDiscount.findMany({
      where: {
        order: { venueId },
      },
      select: {
        discountId: true,
        amount: true,
        discount: {
          select: {
            id: true,
            name: true,
            type: true,
          },
        },
      },
    }),
  ])

  // Calculate totals from order discounts
  const totalRedemptions = orderDiscounts.length
  const totalSaved = orderDiscounts.reduce((sum, od) => sum + Number(od.amount), 0)

  // Group by discount for top discounts
  const discountStats = new Map<
    string,
    {
      id: string
      name: string
      type: DiscountType
      redemptions: number
      totalSaved: number
    }
  >()

  for (const od of orderDiscounts) {
    if (od.discount) {
      const existing = discountStats.get(od.discount.id)
      if (existing) {
        existing.redemptions += 1
        existing.totalSaved += Number(od.amount)
      } else {
        discountStats.set(od.discount.id, {
          id: od.discount.id,
          name: od.discount.name,
          type: od.discount.type,
          redemptions: 1,
          totalSaved: Number(od.amount),
        })
      }
    }
  }

  // Sort by redemptions and get top 5
  const topDiscounts = Array.from(discountStats.values())
    .sort((a, b) => b.redemptions - a.redemptions)
    .slice(0, 5)

  return {
    totalDiscounts,
    activeDiscounts,
    automaticDiscounts,
    totalRedemptions,
    totalSaved,
    topDiscounts,
  }
}

// ==========================================
// CUSTOMER DISCOUNT ASSIGNMENT
// ==========================================

/**
 * Assign a discount to a customer
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param discountId - Discount ID
 * @param customerId - Customer ID
 * @param assignedById - Staff ID who assigned the discount
 * @param options - Optional validity overrides
 */
export async function assignDiscountToCustomer(
  venueId: string,
  discountId: string,
  customerId: string,
  assignedById?: string,
  options?: {
    validFrom?: Date
    validUntil?: Date
    maxUses?: number
  },
) {
  // Verify discount exists and belongs to venue
  const discount = await prisma.discount.findFirst({
    where: { id: discountId, venueId },
  })
  if (!discount) {
    throw new NotFoundError('Discount not found')
  }

  // Verify customer exists and belongs to venue
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, venueId },
  })
  if (!customer) {
    throw new NotFoundError('Customer not found')
  }

  // Check if already assigned
  const existing = await prisma.customerDiscount.findUnique({
    where: {
      customerId_discountId: { customerId, discountId },
    },
  })

  if (existing) {
    // Update existing assignment
    const updated = await prisma.customerDiscount.update({
      where: { id: existing.id },
      data: {
        active: true,
        validFrom: options?.validFrom ?? existing.validFrom,
        validUntil: options?.validUntil ?? existing.validUntil,
        maxUses: options?.maxUses ?? existing.maxUses,
        assignedById,
      },
      include: {
        discount: { select: { id: true, name: true, type: true, value: true } },
        customer: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    })
    logger.info(`🎟️ Customer discount updated: ${discount.name} for customer ${customerId}`)
    return updated
  }

  // Create new assignment
  const assignment = await prisma.customerDiscount.create({
    data: {
      customerId,
      discountId,
      assignedById,
      validFrom: options?.validFrom,
      validUntil: options?.validUntil,
      maxUses: options?.maxUses,
    },
    include: {
      discount: { select: { id: true, name: true, type: true, value: true } },
      customer: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  })

  logger.info(`🎟️ Discount assigned to customer: ${discount.name} -> ${customerId}`)

  return assignment
}

/**
 * Remove a discount from a customer
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param discountId - Discount ID
 * @param customerId - Customer ID
 */
export async function removeDiscountFromCustomer(venueId: string, discountId: string, customerId: string): Promise<void> {
  // Verify discount exists and belongs to venue
  const discount = await prisma.discount.findFirst({
    where: { id: discountId, venueId },
  })
  if (!discount) {
    throw new NotFoundError('Discount not found')
  }

  const assignment = await prisma.customerDiscount.findUnique({
    where: {
      customerId_discountId: { customerId, discountId },
    },
  })

  if (!assignment) {
    throw new NotFoundError('Customer discount assignment not found')
  }

  await prisma.customerDiscount.delete({
    where: { id: assignment.id },
  })

  logger.info(`🗑️ Discount removed from customer: ${discount.name} from ${customerId}`)
}

/**
 * Get all discounts assigned to a customer
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param customerId - Customer ID
 */
export async function getCustomerDiscounts(venueId: string, customerId: string) {
  // Verify customer exists and belongs to venue
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, venueId },
  })
  if (!customer) {
    throw new NotFoundError('Customer not found')
  }

  const assignments = await prisma.customerDiscount.findMany({
    where: {
      customerId,
      discount: { venueId },
    },
    include: {
      discount: {
        select: {
          id: true,
          name: true,
          description: true,
          type: true,
          value: true,
          scope: true,
          validFrom: true,
          validUntil: true,
          active: true,
        },
      },
    },
    orderBy: { assignedAt: 'desc' },
  })

  return assignments.map(a => ({
    ...a,
    discount: {
      ...a.discount,
      value: Number(a.discount.value),
    },
  }))
}

// ==========================================
// AUTOMATIC DISCOUNTS
// ==========================================

/**
 * Get all automatic discounts for a venue that are currently valid
 *
 * @param venueId - Venue ID (multi-tenant filter)
 */
export async function getActiveAutomaticDiscounts(venueId: string) {
  const now = new Date()

  const discounts = await prisma.discount.findMany({
    where: {
      venueId,
      active: true,
      isAutomatic: true,
      AND: [
        // Valid from check
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        // Valid until check
        { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
        // Usage limits check (can't use lt: field reference in Prisma, need raw query or skip)
        // For now, we'll filter in application code if needed
      ],
    },
    include: {
      customerGroup: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  })

  return discounts.map(d => ({
    ...d,
    value: Number(d.value),
    minPurchaseAmount: d.minPurchaseAmount ? Number(d.minPurchaseAmount) : null,
    maxDiscountAmount: d.maxDiscountAmount ? Number(d.maxDiscountAmount) : null,
    getDiscountPercent: d.getDiscountPercent ? Number(d.getDiscountPercent) : null,
  }))
}
