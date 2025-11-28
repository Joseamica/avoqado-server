/**
 * Coupon Dashboard Service
 *
 * HTTP-agnostic business logic for coupon code management.
 * Controllers orchestrate HTTP, services contain logic.
 *
 * @see CLAUDE.md - Layered Architecture section
 * @see docs/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md - Phase 2 specifications
 */

import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'
import { DiscountType, Prisma } from '@prisma/client'

// ==========================================
// TYPES & INTERFACES
// ==========================================

interface CouponCodeListItem {
  id: string
  code: string
  discountId: string
  discount: {
    id: string
    name: string
    type: DiscountType
    value: number
  }
  maxUses: number | null
  maxUsesPerCustomer: number | null
  currentUses: number
  minPurchaseAmount: number | null
  validFrom: Date | null
  validUntil: Date | null
  active: boolean
  createdAt: Date
  _count: {
    redemptions: number
  }
}

interface PaginatedCouponsResponse {
  data: CouponCodeListItem[]
  meta: {
    totalCount: number
    pageSize: number
    currentPage: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
  }
}

interface CreateCouponCodeRequest {
  discountId: string
  code: string
  maxUses?: number
  maxUsesPerCustomer?: number
  minPurchaseAmount?: number
  validFrom?: Date
  validUntil?: Date
  active?: boolean
}

interface UpdateCouponCodeRequest {
  code?: string
  maxUses?: number | null
  maxUsesPerCustomer?: number | null
  minPurchaseAmount?: number | null
  validFrom?: Date | null
  validUntil?: Date | null
  active?: boolean
}

interface BulkGenerateCouponsRequest {
  discountId: string
  prefix?: string
  quantity: number
  codeLength?: number
  maxUsesPerCode?: number
  maxUsesPerCustomer?: number
  validFrom?: Date
  validUntil?: Date
}

interface CouponValidationResult {
  valid: boolean
  coupon?: {
    id: string
    code: string
    discount: {
      id: string
      name: string
      type: DiscountType
      value: number
      scope: string
      maxDiscountAmount: number | null
    }
  }
  error?: string
  errorCode?: 'NOT_FOUND' | 'INACTIVE' | 'EXPIRED' | 'NOT_STARTED' | 'USAGE_LIMIT' | 'MIN_PURCHASE' | 'CUSTOMER_LIMIT'
}

interface CouponRedemptionItem {
  id: string
  couponCodeId: string
  customerId: string | null
  customer: {
    id: string
    firstName: string | null
    lastName: string | null
    email: string | null
  } | null
  orderId: string
  amountSaved: number
  redeemedAt: Date
}

// ==========================================
// COUPON CRUD OPERATIONS
// ==========================================

/**
 * Get all coupon codes for a venue with pagination
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param page - Page number (1-indexed)
 * @param pageSize - Items per page
 * @param search - Search term (code)
 * @param discountId - Filter by discount
 * @param active - Filter by active status
 */
export async function getCouponCodes(
  venueId: string,
  page: number = 1,
  pageSize: number = 20,
  search?: string,
  discountId?: string,
  active?: boolean,
): Promise<PaginatedCouponsResponse> {
  const skip = (page - 1) * pageSize

  // Build where clause - filter through discount's venueId
  const where: Prisma.CouponCodeWhereInput = {
    discount: { venueId },
    ...(search && {
      code: { contains: search.toUpperCase(), mode: 'insensitive' as const },
    }),
    ...(discountId && { discountId }),
    ...(active !== undefined && { active }),
  }

  // Execute count and fetch in parallel
  const [totalCount, coupons] = await Promise.all([
    prisma.couponCode.count({ where }),
    prisma.couponCode.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: {
        discount: {
          select: {
            id: true,
            name: true,
            type: true,
            value: true,
          },
        },
        _count: {
          select: {
            redemptions: true,
          },
        },
      },
    }),
  ])

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: coupons.map(c => ({
      ...c,
      discount: {
        ...c.discount,
        value: Number(c.discount.value),
      },
      minPurchaseAmount: c.minPurchaseAmount ? Number(c.minPurchaseAmount) : null,
    })) as unknown as CouponCodeListItem[],
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
 * Get a single coupon code by ID
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param couponId - Coupon ID
 * @throws NotFoundError if coupon not found
 */
export async function getCouponCodeById(venueId: string, couponId: string) {
  const coupon = await prisma.couponCode.findFirst({
    where: {
      id: couponId,
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
          maxDiscountAmount: true,
          active: true,
        },
      },
      redemptions: {
        include: {
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          order: {
            select: {
              id: true,
              total: true,
              createdAt: true,
            },
          },
        },
        orderBy: { redeemedAt: 'desc' },
        take: 20,
      },
      _count: {
        select: {
          redemptions: true,
        },
      },
    },
  })

  if (!coupon) {
    throw new NotFoundError('Coupon code not found')
  }

  return {
    ...coupon,
    discount: {
      ...coupon.discount,
      value: Number(coupon.discount.value),
      maxDiscountAmount: coupon.discount.maxDiscountAmount ? Number(coupon.discount.maxDiscountAmount) : null,
    },
    minPurchaseAmount: coupon.minPurchaseAmount ? Number(coupon.minPurchaseAmount) : null,
    redemptions: coupon.redemptions.map(r => ({
      ...r,
      amountSaved: Number(r.amountSaved),
      order: r.order
        ? {
            ...r.order,
            total: Number(r.order.total),
          }
        : null,
    })),
  }
}

/**
 * Create a new coupon code
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param data - Coupon data
 */
export async function createCouponCode(venueId: string, data: CreateCouponCodeRequest) {
  // Verify discount exists and belongs to venue
  const discount = await prisma.discount.findFirst({
    where: { id: data.discountId, venueId },
  })
  if (!discount) {
    throw new NotFoundError('Discount not found')
  }

  // Normalize code to uppercase
  const normalizedCode = data.code.toUpperCase().trim()

  // Check if code already exists (globally unique)
  const existingCode = await prisma.couponCode.findUnique({
    where: { code: normalizedCode },
  })
  if (existingCode) {
    throw new BadRequestError(`Coupon code "${normalizedCode}" already exists`)
  }

  // Validate code format
  if (!/^[A-Z0-9-_]+$/.test(normalizedCode)) {
    throw new BadRequestError('Coupon code can only contain letters, numbers, hyphens, and underscores')
  }

  if (normalizedCode.length < 3 || normalizedCode.length > 30) {
    throw new BadRequestError('Coupon code must be between 3 and 30 characters')
  }

  const coupon = await prisma.couponCode.create({
    data: {
      discountId: data.discountId,
      code: normalizedCode,
      maxUses: data.maxUses,
      maxUsesPerCustomer: data.maxUsesPerCustomer,
      minPurchaseAmount: data.minPurchaseAmount,
      validFrom: data.validFrom,
      validUntil: data.validUntil,
      active: data.active ?? true,
    },
    include: {
      discount: {
        select: {
          id: true,
          name: true,
          type: true,
          value: true,
        },
      },
    },
  })

  logger.info(`🎫 Coupon code created: ${normalizedCode} for discount ${discount.name}`)

  return {
    ...coupon,
    discount: {
      ...coupon.discount,
      value: Number(coupon.discount.value),
    },
    minPurchaseAmount: coupon.minPurchaseAmount ? Number(coupon.minPurchaseAmount) : null,
  }
}

/**
 * Update an existing coupon code
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param couponId - Coupon ID
 * @param data - Update data
 * @throws NotFoundError if coupon not found
 */
export async function updateCouponCode(venueId: string, couponId: string, data: UpdateCouponCodeRequest) {
  // Check coupon exists and belongs to venue
  const existing = await prisma.couponCode.findFirst({
    where: { id: couponId, discount: { venueId } },
  })
  if (!existing) {
    throw new NotFoundError('Coupon code not found')
  }

  // If updating code, normalize and check uniqueness
  let normalizedCode: string | undefined
  if (data.code !== undefined) {
    normalizedCode = data.code.toUpperCase().trim()

    // Validate code format
    if (!/^[A-Z0-9-_]+$/.test(normalizedCode)) {
      throw new BadRequestError('Coupon code can only contain letters, numbers, hyphens, and underscores')
    }

    if (normalizedCode.length < 3 || normalizedCode.length > 30) {
      throw new BadRequestError('Coupon code must be between 3 and 30 characters')
    }

    // Check uniqueness if code is different
    if (normalizedCode !== existing.code) {
      const existingCode = await prisma.couponCode.findUnique({
        where: { code: normalizedCode },
      })
      if (existingCode) {
        throw new BadRequestError(`Coupon code "${normalizedCode}" already exists`)
      }
    }
  }

  const coupon = await prisma.couponCode.update({
    where: { id: couponId },
    data: {
      ...(normalizedCode !== undefined && { code: normalizedCode }),
      ...(data.maxUses !== undefined && { maxUses: data.maxUses }),
      ...(data.maxUsesPerCustomer !== undefined && { maxUsesPerCustomer: data.maxUsesPerCustomer }),
      ...(data.minPurchaseAmount !== undefined && { minPurchaseAmount: data.minPurchaseAmount }),
      ...(data.validFrom !== undefined && { validFrom: data.validFrom }),
      ...(data.validUntil !== undefined && { validUntil: data.validUntil }),
      ...(data.active !== undefined && { active: data.active }),
    },
    include: {
      discount: {
        select: {
          id: true,
          name: true,
          type: true,
          value: true,
        },
      },
    },
  })

  logger.info(`🎫 Coupon code updated: ${coupon.code}`)

  return {
    ...coupon,
    discount: {
      ...coupon.discount,
      value: Number(coupon.discount.value),
    },
    minPurchaseAmount: coupon.minPurchaseAmount ? Number(coupon.minPurchaseAmount) : null,
  }
}

/**
 * Delete a coupon code
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param couponId - Coupon ID
 * @throws NotFoundError if coupon not found
 */
export async function deleteCouponCode(venueId: string, couponId: string): Promise<void> {
  const existing = await prisma.couponCode.findFirst({
    where: { id: couponId, discount: { venueId } },
  })
  if (!existing) {
    throw new NotFoundError('Coupon code not found')
  }

  await prisma.couponCode.delete({
    where: { id: couponId },
  })

  logger.info(`🗑️ Coupon code deleted: ${existing.code} (${couponId})`)
}

// ==========================================
// BULK OPERATIONS
// ==========================================

/**
 * Generate random alphanumeric code
 */
function generateRandomCode(length: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // Exclude confusing chars (0, O, 1, I)
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

/**
 * Bulk generate coupon codes
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param data - Bulk generation parameters
 */
export async function bulkGenerateCouponCodes(venueId: string, data: BulkGenerateCouponsRequest) {
  // Verify discount exists and belongs to venue
  const discount = await prisma.discount.findFirst({
    where: { id: data.discountId, venueId },
  })
  if (!discount) {
    throw new NotFoundError('Discount not found')
  }

  if (data.quantity < 1 || data.quantity > 1000) {
    throw new BadRequestError('Quantity must be between 1 and 1000')
  }

  const codeLength = data.codeLength ?? 8
  if (codeLength < 4 || codeLength > 20) {
    throw new BadRequestError('Code length must be between 4 and 20')
  }

  const prefix = data.prefix?.toUpperCase().trim() ?? ''

  // Generate unique codes
  const codes: string[] = []
  const maxAttempts = data.quantity * 10 // Allow retries for collisions

  for (let attempt = 0; attempt < maxAttempts && codes.length < data.quantity; attempt++) {
    const randomPart = generateRandomCode(codeLength)
    const code = prefix ? `${prefix}-${randomPart}` : randomPart

    // Check uniqueness (both locally and in DB)
    if (!codes.includes(code)) {
      const exists = await prisma.couponCode.findUnique({ where: { code } })
      if (!exists) {
        codes.push(code)
      }
    }
  }

  if (codes.length < data.quantity) {
    throw new BadRequestError(`Could only generate ${codes.length} unique codes. Try increasing code length.`)
  }

  // Bulk create
  const coupons = await prisma.couponCode.createMany({
    data: codes.map(code => ({
      discountId: data.discountId,
      code,
      maxUses: data.maxUsesPerCode,
      maxUsesPerCustomer: data.maxUsesPerCustomer,
      validFrom: data.validFrom,
      validUntil: data.validUntil,
      active: true,
    })),
  })

  logger.info(`🎫 Bulk generated ${coupons.count} coupon codes for discount ${discount.name}`)

  return {
    count: coupons.count,
    codes,
    discountId: data.discountId,
  }
}

// ==========================================
// COUPON VALIDATION
// ==========================================

/**
 * Validate a coupon code for use
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param code - Coupon code to validate
 * @param orderTotal - Order total (for min purchase check)
 * @param customerId - Customer ID (for per-customer limit check)
 */
export async function validateCouponCode(
  venueId: string,
  code: string,
  orderTotal?: number,
  customerId?: string,
): Promise<CouponValidationResult> {
  const normalizedCode = code.toUpperCase().trim()

  // Find the coupon
  const coupon = await prisma.couponCode.findFirst({
    where: {
      code: normalizedCode,
      discount: { venueId },
    },
    include: {
      discount: {
        select: {
          id: true,
          name: true,
          type: true,
          value: true,
          scope: true,
          maxDiscountAmount: true,
          active: true,
        },
      },
      _count: {
        select: {
          redemptions: true,
        },
      },
    },
  })

  if (!coupon) {
    return {
      valid: false,
      error: 'Coupon code not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // Check if coupon is active
  if (!coupon.active) {
    return {
      valid: false,
      error: 'Coupon code is inactive',
      errorCode: 'INACTIVE',
    }
  }

  // Check if parent discount is active
  if (!coupon.discount.active) {
    return {
      valid: false,
      error: 'Discount associated with this coupon is inactive',
      errorCode: 'INACTIVE',
    }
  }

  const now = new Date()

  // Check validity period
  if (coupon.validFrom && coupon.validFrom > now) {
    return {
      valid: false,
      error: `Coupon is not valid yet. Valid from ${coupon.validFrom.toISOString()}`,
      errorCode: 'NOT_STARTED',
    }
  }

  if (coupon.validUntil && coupon.validUntil < now) {
    return {
      valid: false,
      error: 'Coupon has expired',
      errorCode: 'EXPIRED',
    }
  }

  // Check usage limit
  if (coupon.maxUses !== null && coupon.currentUses >= coupon.maxUses) {
    return {
      valid: false,
      error: 'Coupon usage limit has been reached',
      errorCode: 'USAGE_LIMIT',
    }
  }

  // Check minimum purchase amount
  if (coupon.minPurchaseAmount !== null && orderTotal !== undefined) {
    if (orderTotal < Number(coupon.minPurchaseAmount)) {
      return {
        valid: false,
        error: `Minimum purchase of ${Number(coupon.minPurchaseAmount)} required`,
        errorCode: 'MIN_PURCHASE',
      }
    }
  }

  // Check per-customer usage limit
  if (coupon.maxUsesPerCustomer !== null && customerId) {
    const customerRedemptions = await prisma.couponRedemption.count({
      where: {
        couponCodeId: coupon.id,
        customerId,
      },
    })

    if (customerRedemptions >= coupon.maxUsesPerCustomer) {
      return {
        valid: false,
        error: `You have already used this coupon ${coupon.maxUsesPerCustomer} time(s)`,
        errorCode: 'CUSTOMER_LIMIT',
      }
    }
  }

  return {
    valid: true,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      discount: {
        id: coupon.discount.id,
        name: coupon.discount.name,
        type: coupon.discount.type,
        value: Number(coupon.discount.value),
        scope: coupon.discount.scope,
        maxDiscountAmount: coupon.discount.maxDiscountAmount ? Number(coupon.discount.maxDiscountAmount) : null,
      },
    },
  }
}

// ==========================================
// COUPON REDEMPTION
// ==========================================

/**
 * Record a coupon redemption
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param couponId - Coupon code ID
 * @param orderId - Order ID
 * @param amountSaved - Amount saved by the coupon
 * @param customerId - Customer ID (optional)
 */
export async function recordCouponRedemption(venueId: string, couponId: string, orderId: string, amountSaved: number, customerId?: string) {
  // Verify coupon exists and belongs to venue
  const coupon = await prisma.couponCode.findFirst({
    where: { id: couponId, discount: { venueId } },
    include: { discount: true },
  })
  if (!coupon) {
    throw new NotFoundError('Coupon code not found')
  }

  // Verify order exists and belongs to venue
  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
  })
  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Check if order already has a coupon redemption
  const existingRedemption = await prisma.couponRedemption.findUnique({
    where: { orderId },
  })
  if (existingRedemption) {
    throw new BadRequestError('This order already has a coupon redemption')
  }

  // Create redemption and increment usage counter in transaction
  const result = await prisma.$transaction(async tx => {
    // Create redemption record
    const redemption = await tx.couponRedemption.create({
      data: {
        couponCodeId: couponId,
        orderId,
        customerId,
        amountSaved,
      },
      include: {
        couponCode: {
          select: {
            id: true,
            code: true,
          },
        },
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    })

    // Increment usage counter
    await tx.couponCode.update({
      where: { id: couponId },
      data: { currentUses: { increment: 1 } },
    })

    // Also increment the parent discount's usage counter
    await tx.discount.update({
      where: { id: coupon.discountId },
      data: { currentUses: { increment: 1 } },
    })

    return redemption
  })

  logger.info(`🎫 Coupon redeemed: ${coupon.code} on order ${orderId}, saved ${amountSaved}`)

  return {
    ...result,
    amountSaved: Number(result.amountSaved),
  }
}

/**
 * Get coupon redemption history for a venue
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param page - Page number
 * @param pageSize - Items per page
 * @param couponId - Filter by specific coupon
 * @param customerId - Filter by customer
 */
export async function getCouponRedemptions(
  venueId: string,
  page: number = 1,
  pageSize: number = 20,
  couponId?: string,
  customerId?: string,
) {
  const skip = (page - 1) * pageSize

  const where: Prisma.CouponRedemptionWhereInput = {
    couponCode: { discount: { venueId } },
    ...(couponId && { couponCodeId: couponId }),
    ...(customerId && { customerId }),
  }

  const [totalCount, redemptions] = await Promise.all([
    prisma.couponRedemption.count({ where }),
    prisma.couponRedemption.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { redeemedAt: 'desc' },
      include: {
        couponCode: {
          select: {
            id: true,
            code: true,
            discount: {
              select: {
                id: true,
                name: true,
                type: true,
              },
            },
          },
        },
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        order: {
          select: {
            id: true,
            total: true,
            createdAt: true,
          },
        },
      },
    }),
  ])

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: redemptions.map(r => ({
      ...r,
      amountSaved: Number(r.amountSaved),
      order: r.order
        ? {
            ...r.order,
            total: Number(r.order.total),
          }
        : null,
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

// ==========================================
// COUPON STATISTICS
// ==========================================

/**
 * Get coupon statistics for a venue
 *
 * @param venueId - Venue ID (multi-tenant filter)
 */
export async function getCouponStats(venueId: string) {
  const [totalCoupons, activeCoupons, redemptions] = await Promise.all([
    prisma.couponCode.count({ where: { discount: { venueId } } }),
    prisma.couponCode.count({ where: { discount: { venueId }, active: true } }),
    prisma.couponRedemption.findMany({
      where: { couponCode: { discount: { venueId } } },
      select: {
        amountSaved: true,
        couponCodeId: true,
      },
    }),
  ])

  const totalRedemptions = redemptions.length
  const totalSaved = redemptions.reduce((sum, r) => sum + Number(r.amountSaved), 0)

  // Count redemptions per coupon
  const couponUsage = new Map<string, number>()
  for (const r of redemptions) {
    couponUsage.set(r.couponCodeId, (couponUsage.get(r.couponCodeId) ?? 0) + 1)
  }

  // Get top performing coupons
  const topCoupons = await prisma.couponCode.findMany({
    where: {
      discount: { venueId },
      id: { in: Array.from(couponUsage.keys()) },
    },
    select: {
      id: true,
      code: true,
      currentUses: true,
      discount: {
        select: {
          name: true,
        },
      },
    },
    orderBy: { currentUses: 'desc' },
    take: 5,
  })

  return {
    totalCoupons,
    activeCoupons,
    totalRedemptions,
    totalSaved,
    averageSavings: totalRedemptions > 0 ? totalSaved / totalRedemptions : 0,
    topCoupons: topCoupons.map(c => ({
      id: c.id,
      code: c.code,
      discountName: c.discount.name,
      redemptions: c.currentUses,
    })),
  }
}
