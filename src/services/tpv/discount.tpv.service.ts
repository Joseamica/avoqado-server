/**
 * Discount TPV Service
 *
 * Optimized for fast discount operations at checkout.
 * Integrates with discountEngine for automatic discounts, BOGO, and coupons.
 *
 * @see docs/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md - Phase 2 TPV Integration
 */

import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'
import { DiscountType } from '@prisma/client'
import * as discountEngine from '@/services/dashboard/discountEngine.service'
import * as couponService from '@/services/dashboard/coupon.dashboard.service'

// ==========================================
// TYPES & INTERFACES
// ==========================================

export interface AvailableDiscount {
  id: string
  name: string
  type: DiscountType
  value: number
  scope: string
  description: string | null
  isAutomatic: boolean
  requiresApproval: boolean
  estimatedSavings: number
}

export interface ApplyCouponResult {
  success: boolean
  orderDiscountId?: string
  couponId?: string
  discountName: string
  amount: number
  newOrderTotal: number
  error?: string
}

export interface OrderDiscountSummary {
  id: string
  name: string
  type: string
  value: number
  amount: number
  isAutomatic: boolean
  isManual: boolean
  isCoupon: boolean
  couponCode?: string
  appliedBy: string | null
  createdAt: Date
}

// ==========================================
// GET AVAILABLE DISCOUNTS
// ==========================================

/**
 * Get all available discounts for an order
 * Used by TPV to show discount options to cashier
 *
 * @param venueId - Venue ID
 * @param orderId - Order ID
 * @param customerId - Customer ID (optional, for customer-specific discounts)
 */
export async function getAvailableDiscounts(venueId: string, orderId: string, customerId?: string): Promise<AvailableDiscount[]> {
  logger.debug(`🎟️ TPV Getting available discounts`, { venueId, orderId, customerId })

  // Get order for context
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: {
      items: {
        include: {
          product: { select: { id: true, categoryId: true } },
        },
      },
      orderDiscounts: true,
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  const orderTotal = Number(order.subtotal)

  // Get eligible discounts from engine
  const eligibleDiscounts = await discountEngine.getEligibleDiscounts(venueId, customerId || order.customerId || undefined, orderTotal)

  // Get customer-specific discounts if customer is identified
  let customerDiscounts: typeof eligibleDiscounts = []
  if (customerId || order.customerId) {
    customerDiscounts = await discountEngine.getCustomerDiscounts(venueId, customerId || order.customerId!)
  }

  // Combine and deduplicate
  const allDiscounts = [...eligibleDiscounts, ...customerDiscounts]
  const uniqueDiscounts = allDiscounts.filter((d, i, arr) => arr.findIndex(x => x.id === d.id) === i)

  // Filter out already applied discounts
  const appliedDiscountIds = order.orderDiscounts.map(od => od.discountId).filter(Boolean)
  const availableDiscounts = uniqueDiscounts.filter(d => !appliedDiscountIds.includes(d.id))

  // Calculate estimated savings for each discount
  const result: AvailableDiscount[] = availableDiscounts.map(discount => {
    let estimatedSavings = 0

    // Simple estimation based on order total
    if (discount.type === 'PERCENTAGE') {
      estimatedSavings = (orderTotal * discount.value) / 100
    } else if (discount.type === 'FIXED_AMOUNT') {
      estimatedSavings = Math.min(discount.value, orderTotal)
    } else if (discount.type === 'COMP') {
      estimatedSavings = orderTotal
    }

    // Apply max discount cap
    if (discount.maxDiscountAmount !== null) {
      estimatedSavings = Math.min(estimatedSavings, discount.maxDiscountAmount)
    }

    return {
      id: discount.id,
      name: discount.name,
      type: discount.type,
      value: discount.value,
      scope: discount.scope,
      description: null, // Could fetch from database if needed
      isAutomatic: discount.isAutomatic,
      requiresApproval: discount.requiresApproval,
      estimatedSavings: Math.round(estimatedSavings * 100) / 100,
    }
  })

  logger.info(`✅ Found ${result.length} available discounts`, { venueId, orderId })

  return result
}

// ==========================================
// APPLY AUTOMATIC DISCOUNTS
// ==========================================

/**
 * Apply all eligible automatic discounts to an order
 * Called when order is ready for checkout
 *
 * @param venueId - Venue ID
 * @param orderId - Order ID
 * @param staffVenueId - Staff venue ID applying the discounts
 */
export async function applyAutomaticDiscounts(
  venueId: string,
  orderId: string,
  staffVenueId?: string,
): Promise<{ applied: number; totalSavings: number; discounts: OrderDiscountSummary[] }> {
  logger.info(`🎟️ TPV Applying automatic discounts`, { venueId, orderId })

  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot apply discounts to a paid order')
  }

  // Apply automatic discounts via engine
  const result = await discountEngine.applyAutomaticDiscounts(orderId, staffVenueId)

  // Get the updated discount summary
  const discounts = await getOrderDiscounts(venueId, orderId)

  logger.info(`✅ Applied ${result.applied.length} automatic discounts, total savings: $${result.total}`, {
    venueId,
    orderId,
  })

  return {
    applied: result.applied.length,
    totalSavings: result.total,
    discounts,
  }
}

// ==========================================
// APPLY PREDEFINED DISCOUNT
// ==========================================

/**
 * Apply a predefined discount to an order
 * Used when cashier selects a discount from the list
 *
 * @param venueId - Venue ID
 * @param orderId - Order ID
 * @param discountId - Discount ID to apply
 * @param staffVenueId - Staff venue ID applying the discount
 * @param authorizedById - Manager's staff venue ID (required for comps/approval)
 */
export async function applyPredefinedDiscount(
  venueId: string,
  orderId: string,
  discountId: string,
  staffVenueId: string,
  authorizedById?: string,
): Promise<{ success: boolean; amount: number; newOrderTotal: number; error?: string }> {
  logger.info(`🎟️ TPV Applying predefined discount`, { venueId, orderId, discountId })

  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot apply discount to a paid order')
  }

  // Get the discount
  const discount = await prisma.discount.findFirst({
    where: { id: discountId, venueId, active: true },
  })

  if (!discount) {
    throw new NotFoundError('Discount not found or inactive')
  }

  // Evaluate the discount for this order
  const discounts = await discountEngine.evaluateAutomaticDiscounts(orderId)
  const calculatedDiscount = discounts.find(d => d.discountId === discountId)

  if (!calculatedDiscount) {
    // Discount exists but doesn't apply to this order
    throw new BadRequestError('This discount cannot be applied to this order')
  }

  // Apply the discount
  const result = await discountEngine.applyDiscountToOrder(orderId, calculatedDiscount, staffVenueId, authorizedById)

  return result
}

// ==========================================
// APPLY MANUAL DISCOUNT
// ==========================================

/**
 * Apply a manual (on-the-fly) discount to an order
 * Used when cashier needs to apply a custom discount
 *
 * @param venueId - Venue ID
 * @param orderId - Order ID
 * @param type - Discount type (PERCENTAGE, FIXED_AMOUNT, COMP)
 * @param value - Discount value
 * @param reason - Reason for the discount
 * @param staffVenueId - Staff venue ID applying the discount
 * @param authorizedById - Manager's staff venue ID (required for comps)
 */
export async function applyManualDiscount(
  venueId: string,
  orderId: string,
  type: DiscountType,
  value: number,
  reason: string,
  staffVenueId: string,
  authorizedById?: string,
): Promise<{ success: boolean; amount: number; newOrderTotal: number; error?: string }> {
  logger.info(`🎟️ TPV Applying manual discount`, { venueId, orderId, type, value, reason })

  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot apply discount to a paid order')
  }

  // Apply manual discount via engine
  const result = await discountEngine.applyManualDiscount(orderId, type, value, reason, staffVenueId, authorizedById)

  return result
}

// ==========================================
// APPLY COUPON CODE
// ==========================================

/**
 * Validate and apply a coupon code to an order
 * Used when customer provides a coupon code at checkout
 *
 * @param venueId - Venue ID
 * @param orderId - Order ID
 * @param couponCode - Coupon code to apply
 * @param staffVenueId - Staff venue ID applying the coupon
 */
export async function applyCouponCode(
  venueId: string,
  orderId: string,
  couponCode: string,
  staffVenueId: string,
): Promise<ApplyCouponResult> {
  logger.info(`🎟️ TPV Applying coupon code`, { venueId, orderId, couponCode })

  // Get order with customer info
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: { orderDiscounts: true },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  if (order.paymentStatus === 'PAID') {
    return {
      success: false,
      discountName: '',
      amount: 0,
      newOrderTotal: Number(order.total),
      error: 'Cannot apply coupon to a paid order',
    }
  }

  // Validate coupon
  const validation = await couponService.validateCouponCode(
    venueId,
    couponCode.toUpperCase(),
    Number(order.subtotal),
    order.customerId ?? undefined,
  )

  if (!validation.valid || !validation.coupon) {
    return {
      success: false,
      discountName: '',
      amount: 0,
      newOrderTotal: Number(order.total),
      error: validation.error || 'Invalid coupon',
    }
  }

  const { coupon } = validation
  const { discount } = coupon

  // Check if this coupon's discount is already applied
  const existingCouponDiscount = order.orderDiscounts.find(od => od.couponCodeId === coupon.id)
  if (existingCouponDiscount) {
    return {
      success: false,
      discountName: discount.name,
      amount: 0,
      newOrderTotal: Number(order.total),
      error: 'This coupon has already been applied to this order',
    }
  }

  // Calculate discount amount
  const subtotal = Number(order.subtotal)
  let discountAmount = 0

  if (discount.type === 'PERCENTAGE') {
    discountAmount = (subtotal * Number(discount.value)) / 100
  } else if (discount.type === 'FIXED_AMOUNT') {
    discountAmount = Math.min(Number(discount.value), subtotal)
  } else if (discount.type === 'COMP') {
    discountAmount = subtotal - Number(order.discountAmount)
  }

  // Apply max discount cap
  if (discount.maxDiscountAmount) {
    discountAmount = Math.min(discountAmount, Number(discount.maxDiscountAmount))
  }

  discountAmount = Math.round(discountAmount * 100) / 100

  // Apply the coupon in a transaction
  const result = await prisma.$transaction(async tx => {
    // Create order discount record
    const orderDiscount = await tx.orderDiscount.create({
      data: {
        orderId,
        discountId: discount.id,
        couponCodeId: coupon.id,
        type: discount.type,
        name: `${discount.name} (${couponCode.toUpperCase()})`,
        value: Number(discount.value),
        amount: discountAmount,
        taxReduction: 0,
        isAutomatic: false,
        isManual: false,
        appliedById: staffVenueId,
      },
    })

    // Update order totals
    const newDiscountAmount = Number(order.discountAmount) + discountAmount
    const newTotal = subtotal - newDiscountAmount + Number(order.taxAmount) + Number(order.tipAmount)

    await tx.order.update({
      where: { id: orderId },
      data: {
        discountAmount: newDiscountAmount,
        total: newTotal,
        remainingBalance: Math.max(0, newTotal - Number(order.paidAmount)),
      },
    })

    // NOTE: Coupon redemption and usage counter increment moved to payment completion
    // See finalizeCouponsForOrder() in payment.tpv.service.ts
    // This follows Toast/Square best practice: coupons are "applied" at checkout
    // but only "redeemed" (counted against limits) when payment succeeds.

    return {
      orderDiscountId: orderDiscount.id,
      newTotal,
    }
  })

  logger.info(`✅ Coupon applied: ${couponCode} (-$${discountAmount})`, { venueId, orderId })

  return {
    success: true,
    orderDiscountId: result.orderDiscountId,
    couponId: coupon.id,
    discountName: discount.name,
    amount: discountAmount,
    newOrderTotal: result.newTotal,
  }
}

// ==========================================
// REMOVE DISCOUNT
// ==========================================

/**
 * Remove a discount from an order
 *
 * @param venueId - Venue ID
 * @param orderId - Order ID
 * @param orderDiscountId - OrderDiscount record ID to remove
 */
export async function removeDiscount(
  venueId: string,
  orderId: string,
  orderDiscountId: string,
): Promise<{ success: boolean; amount: number; newOrderTotal: number; error?: string }> {
  logger.info(`🗑️ TPV Removing discount`, { venueId, orderId, orderDiscountId })

  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot remove discount from a paid order')
  }

  // Remove discount via engine
  const result = await discountEngine.removeDiscountFromOrder(orderId, orderDiscountId)

  return result
}

// ==========================================
// GET ORDER DISCOUNTS
// ==========================================

/**
 * Get all discounts applied to an order
 *
 * @param venueId - Venue ID
 * @param orderId - Order ID
 */
export async function getOrderDiscounts(venueId: string, orderId: string): Promise<OrderDiscountSummary[]> {
  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  const summary = await discountEngine.getOrderDiscountsSummary(orderId)

  return summary.map(d => ({
    id: d.id,
    name: d.name,
    type: d.type,
    value: d.value,
    amount: d.amount,
    isAutomatic: d.isAutomatic,
    isManual: d.isManual,
    isCoupon: !!d.couponCode,
    couponCode: d.couponCode?.code,
    appliedBy: d.appliedBy,
    createdAt: d.createdAt,
  }))
}

// ==========================================
// VALIDATE COUPON (without applying)
// ==========================================

/**
 * Validate a coupon code without applying it
 * Used to show preview to cashier before applying
 *
 * @param venueId - Venue ID
 * @param couponCode - Coupon code to validate
 * @param orderTotal - Current order total
 * @param customerId - Customer ID (optional)
 */
export async function validateCoupon(
  venueId: string,
  couponCode: string,
  orderTotal: number,
  customerId?: string,
): Promise<{
  valid: boolean
  message: string
  discountName?: string
  discountType?: string
  discountValue?: number
  estimatedSavings?: number
}> {
  const validation = await couponService.validateCouponCode(venueId, couponCode.toUpperCase(), orderTotal, customerId)

  if (!validation.valid || !validation.coupon) {
    return {
      valid: false,
      message: validation.error || 'Invalid coupon',
    }
  }

  const { discount } = validation.coupon

  // Calculate estimated savings
  let estimatedSavings = 0
  if (discount.type === 'PERCENTAGE') {
    estimatedSavings = (orderTotal * Number(discount.value)) / 100
  } else if (discount.type === 'FIXED_AMOUNT') {
    estimatedSavings = Math.min(Number(discount.value), orderTotal)
  } else if (discount.type === 'COMP') {
    estimatedSavings = orderTotal
  }

  if (discount.maxDiscountAmount) {
    estimatedSavings = Math.min(estimatedSavings, Number(discount.maxDiscountAmount))
  }

  return {
    valid: true,
    message: 'Coupon is valid',
    discountName: discount.name,
    discountType: discount.type,
    discountValue: Number(discount.value),
    estimatedSavings: Math.round(estimatedSavings * 100) / 100,
  }
}
