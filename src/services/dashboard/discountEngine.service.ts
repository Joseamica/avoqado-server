/**
 * Discount Engine Service
 *
 * Core logic for automatic discount application, BOGO, and discount calculation.
 * This service handles the "smart" discount logic that determines which discounts
 * apply to an order and calculates the amounts.
 *
 * @see CLAUDE.md - Layered Architecture section
 * @see docs/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md - Phase 2 specifications
 */

import logger from '@/config/logger'
import { NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { DiscountScope, DiscountType } from '@prisma/client'

// ==========================================
// TYPES & INTERFACES
// ==========================================

interface OrderContext {
  orderId: string
  venueId: string
  customerId?: string
  subtotal: number
  items: OrderItemContext[]
  appliedDiscounts: AppliedDiscountInfo[]
}

interface OrderItemContext {
  id: string
  productId: string
  categoryId: string
  quantity: number
  unitPrice: number
  total: number
  modifiers: Array<{
    id: string
    modifierGroupId: string
    price: number
  }>
}

interface AppliedDiscountInfo {
  discountId: string
  amount: number
  isAutomatic: boolean
}

interface DiscountCandidate {
  discount: {
    id: string
    name: string
    type: DiscountType
    value: number
    scope: DiscountScope
    targetItemIds: string[]
    targetCategoryIds: string[]
    targetModifierIds: string[]
    targetModifierGroupIds: string[]
    customerGroupId: string | null
    isAutomatic: boolean
    priority: number
    minPurchaseAmount: number | null
    maxDiscountAmount: number | null
    minQuantity: number | null
    buyQuantity: number | null
    getQuantity: number | null
    getDiscountPercent: number | null
    buyItemIds: string[]
    getItemIds: string[]
    validFrom: Date | null
    validUntil: Date | null
    daysOfWeek: number[]
    timeFrom: string | null
    timeUntil: string | null
    maxTotalUses: number | null
    maxUsesPerCustomer: number | null
    currentUses: number
    isStackable: boolean
    stackPriority: number
    requiresApproval: boolean
    applyBeforeTax: boolean
  }
  applicableAmount: number
  applicableItems: string[] // Item IDs this discount applies to
  reason: string
}

interface DiscountCalculationResult {
  discountId: string
  name: string
  type: DiscountType
  value: number
  amount: number // Calculated discount amount
  taxReduction: number
  applicableItems: string[]
  isAutomatic: boolean
  requiresApproval: boolean
}

interface ApplyDiscountResult {
  success: boolean
  orderDiscountId?: string
  amount: number
  newOrderTotal: number
  error?: string
}

// ==========================================
// DISCOUNT ELIGIBILITY
// ==========================================

/**
 * Get all discounts that could potentially apply to an order
 * Filters by venue, active status, time validity, and basic eligibility
 *
 * @param venueId - Venue ID
 * @param customerId - Customer ID (optional, for customer-specific discounts)
 * @param orderTotal - Current order subtotal
 */
export async function getEligibleDiscounts(
  venueId: string,
  customerId?: string,
  orderTotal?: number,
): Promise<DiscountCandidate['discount'][]> {
  const now = new Date()
  const currentDay = now.getDay() // 0 = Sunday, 6 = Saturday

  // Get all active discounts for the venue
  const discounts = await prisma.discount.findMany({
    where: {
      venueId,
      active: true,
      // Date validity
      AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
    },
    orderBy: [{ priority: 'desc' }, { stackPriority: 'desc' }],
  })

  // Filter by additional criteria
  const eligibleDiscounts: DiscountCandidate['discount'][] = []

  for (const discount of discounts) {
    // Check day of week
    if (discount.daysOfWeek && discount.daysOfWeek.length > 0) {
      if (!discount.daysOfWeek.includes(currentDay)) {
        continue
      }
    }

    // Check time window
    if (discount.timeFrom && discount.timeUntil) {
      if (!isWithinTimeWindow(discount.timeFrom, discount.timeUntil)) {
        continue
      }
    }

    // Check usage limits
    if (discount.maxTotalUses !== null && discount.currentUses >= discount.maxTotalUses) {
      continue
    }

    // Check minimum purchase amount
    if (discount.minPurchaseAmount !== null && orderTotal !== undefined) {
      if (orderTotal < Number(discount.minPurchaseAmount)) {
        continue
      }
    }

    // Check customer-specific usage limit
    if (discount.maxUsesPerCustomer !== null && customerId) {
      const customerUses = await prisma.orderDiscount.count({
        where: {
          discountId: discount.id,
          order: { customerId },
        },
      })
      if (customerUses >= discount.maxUsesPerCustomer) {
        continue
      }
    }

    // Check customer group eligibility
    if (discount.customerGroupId && customerId) {
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { customerGroupId: true },
      })
      if (!customer || customer.customerGroupId !== discount.customerGroupId) {
        continue
      }
    } else if (discount.customerGroupId && !customerId) {
      // Discount requires customer group but no customer provided
      continue
    }

    eligibleDiscounts.push({
      id: discount.id,
      name: discount.name,
      type: discount.type,
      value: Number(discount.value),
      scope: discount.scope,
      targetItemIds: discount.targetItemIds,
      targetCategoryIds: discount.targetCategoryIds,
      targetModifierIds: discount.targetModifierIds,
      targetModifierGroupIds: discount.targetModifierGroupIds,
      customerGroupId: discount.customerGroupId,
      isAutomatic: discount.isAutomatic,
      priority: discount.priority,
      minPurchaseAmount: discount.minPurchaseAmount ? Number(discount.minPurchaseAmount) : null,
      maxDiscountAmount: discount.maxDiscountAmount ? Number(discount.maxDiscountAmount) : null,
      minQuantity: discount.minQuantity,
      buyQuantity: discount.buyQuantity,
      getQuantity: discount.getQuantity,
      getDiscountPercent: discount.getDiscountPercent ? Number(discount.getDiscountPercent) : null,
      buyItemIds: discount.buyItemIds,
      getItemIds: discount.getItemIds,
      validFrom: discount.validFrom,
      validUntil: discount.validUntil,
      daysOfWeek: discount.daysOfWeek,
      timeFrom: discount.timeFrom,
      timeUntil: discount.timeUntil,
      maxTotalUses: discount.maxTotalUses,
      maxUsesPerCustomer: discount.maxUsesPerCustomer,
      currentUses: discount.currentUses,
      isStackable: discount.isStackable,
      stackPriority: discount.stackPriority,
      requiresApproval: discount.requiresApproval,
      applyBeforeTax: discount.applyBeforeTax,
    })
  }

  return eligibleDiscounts
}

/**
 * Get customer-assigned discounts
 */
export async function getCustomerDiscounts(venueId: string, customerId: string): Promise<DiscountCandidate['discount'][]> {
  const now = new Date()

  const customerDiscounts = await prisma.customerDiscount.findMany({
    where: {
      customerId,
      active: true,
      discount: {
        venueId,
        active: true,
      },
      AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
    },
    include: {
      discount: true,
    },
  })

  return customerDiscounts
    .filter(cd => {
      // Check usage limit for this assignment
      if (cd.maxUses !== null && cd.usageCount >= cd.maxUses) {
        return false
      }
      return true
    })
    .map(cd => ({
      id: cd.discount.id,
      name: cd.discount.name,
      type: cd.discount.type,
      value: Number(cd.discount.value),
      scope: cd.discount.scope,
      targetItemIds: cd.discount.targetItemIds,
      targetCategoryIds: cd.discount.targetCategoryIds,
      targetModifierIds: cd.discount.targetModifierIds,
      targetModifierGroupIds: cd.discount.targetModifierGroupIds,
      customerGroupId: cd.discount.customerGroupId,
      isAutomatic: true, // Customer discounts are auto-applied
      priority: cd.discount.priority + 100, // Customer discounts have higher priority
      minPurchaseAmount: cd.discount.minPurchaseAmount ? Number(cd.discount.minPurchaseAmount) : null,
      maxDiscountAmount: cd.discount.maxDiscountAmount ? Number(cd.discount.maxDiscountAmount) : null,
      minQuantity: cd.discount.minQuantity,
      buyQuantity: cd.discount.buyQuantity,
      getQuantity: cd.discount.getQuantity,
      getDiscountPercent: cd.discount.getDiscountPercent ? Number(cd.discount.getDiscountPercent) : null,
      buyItemIds: cd.discount.buyItemIds,
      getItemIds: cd.discount.getItemIds,
      validFrom: cd.discount.validFrom,
      validUntil: cd.discount.validUntil,
      daysOfWeek: cd.discount.daysOfWeek,
      timeFrom: cd.discount.timeFrom,
      timeUntil: cd.discount.timeUntil,
      maxTotalUses: cd.discount.maxTotalUses,
      maxUsesPerCustomer: cd.discount.maxUsesPerCustomer,
      currentUses: cd.discount.currentUses,
      isStackable: cd.discount.isStackable,
      stackPriority: cd.discount.stackPriority,
      requiresApproval: cd.discount.requiresApproval,
      applyBeforeTax: cd.discount.applyBeforeTax,
    }))
}

// ==========================================
// DISCOUNT CALCULATION
// ==========================================

/**
 * Calculate the discount amount for a given discount and order context
 *
 * @param discount - The discount to calculate
 * @param context - Order context (items, subtotal, etc.)
 */
export function calculateDiscountAmount(discount: DiscountCandidate['discount'], context: OrderContext): DiscountCalculationResult {
  let amount = 0
  let applicableItems: string[] = []
  let taxReduction = 0

  // Determine applicable base amount based on scope
  const applicableBase = getApplicableBase(discount, context)
  amount = applicableBase.amount
  applicableItems = applicableBase.itemIds

  // Handle BOGO separately
  if (discount.scope === 'QUANTITY' && discount.buyQuantity && discount.getQuantity) {
    const bogoResult = calculateBOGO(discount, context)
    return {
      discountId: discount.id,
      name: discount.name,
      type: discount.type,
      value: discount.value,
      amount: bogoResult.amount,
      taxReduction: bogoResult.taxReduction,
      applicableItems: bogoResult.applicableItems,
      isAutomatic: discount.isAutomatic,
      requiresApproval: discount.requiresApproval,
    }
  }

  // Calculate discount based on type
  switch (discount.type) {
    case 'PERCENTAGE':
      amount = (applicableBase.amount * discount.value) / 100
      break
    case 'FIXED_AMOUNT':
      amount = Math.min(discount.value, applicableBase.amount) // Can't discount more than the base
      break
    case 'COMP':
      amount = applicableBase.amount // 100% off
      break
  }

  // Apply max discount cap
  if (discount.maxDiscountAmount !== null) {
    amount = Math.min(amount, discount.maxDiscountAmount)
  }

  // Calculate tax reduction if discount is applied before tax
  if (discount.applyBeforeTax) {
    // Estimate average tax rate from applicable items
    const avgTaxRate = estimateAverageTaxRate(applicableItems, context)
    taxReduction = amount * avgTaxRate
  }

  // Round to 2 decimal places
  amount = Math.round(amount * 100) / 100
  taxReduction = Math.round(taxReduction * 100) / 100

  return {
    discountId: discount.id,
    name: discount.name,
    type: discount.type,
    value: discount.value,
    amount,
    taxReduction,
    applicableItems,
    isAutomatic: discount.isAutomatic,
    requiresApproval: discount.requiresApproval,
  }
}

/**
 * Get the base amount that a discount applies to based on scope
 */
function getApplicableBase(discount: DiscountCandidate['discount'], context: OrderContext): { amount: number; itemIds: string[] } {
  switch (discount.scope) {
    case 'ORDER':
      // Applies to entire order
      return {
        amount: context.subtotal,
        itemIds: context.items.map(i => i.id),
      }

    case 'ITEM':
      // Applies to specific items
      if (discount.targetItemIds.length === 0) {
        return { amount: 0, itemIds: [] }
      }
      const targetItems = context.items.filter(i => discount.targetItemIds.includes(i.productId))
      return {
        amount: targetItems.reduce((sum, i) => sum + i.total, 0),
        itemIds: targetItems.map(i => i.id),
      }

    case 'CATEGORY':
      // Applies to items in specific categories
      if (discount.targetCategoryIds.length === 0) {
        return { amount: 0, itemIds: [] }
      }
      const categoryItems = context.items.filter(i => discount.targetCategoryIds.includes(i.categoryId))
      return {
        amount: categoryItems.reduce((sum, i) => sum + i.total, 0),
        itemIds: categoryItems.map(i => i.id),
      }

    case 'MODIFIER':
      // Applies to specific modifiers
      if (discount.targetModifierIds.length === 0) {
        return { amount: 0, itemIds: [] }
      }
      let modifierTotal = 0
      const modifierItemIds: string[] = []
      for (const item of context.items) {
        const matchingMods = item.modifiers.filter(m => discount.targetModifierIds.includes(m.id))
        if (matchingMods.length > 0) {
          modifierTotal += matchingMods.reduce((sum, m) => sum + m.price, 0)
          modifierItemIds.push(item.id)
        }
      }
      return { amount: modifierTotal, itemIds: modifierItemIds }

    case 'MODIFIER_GROUP':
      // Applies to modifiers in specific groups
      if (discount.targetModifierGroupIds.length === 0) {
        return { amount: 0, itemIds: [] }
      }
      let modGroupTotal = 0
      const modGroupItemIds: string[] = []
      for (const item of context.items) {
        const matchingMods = item.modifiers.filter(m => discount.targetModifierGroupIds.includes(m.modifierGroupId))
        if (matchingMods.length > 0) {
          modGroupTotal += matchingMods.reduce((sum, m) => sum + m.price, 0)
          modGroupItemIds.push(item.id)
        }
      }
      return { amount: modGroupTotal, itemIds: modGroupItemIds }

    case 'CUSTOMER_GROUP':
      // Applies to entire order if customer is in group (already validated in eligibility)
      return {
        amount: context.subtotal,
        itemIds: context.items.map(i => i.id),
      }

    case 'QUANTITY':
      // BOGO - handled separately
      return { amount: 0, itemIds: [] }

    default:
      return { amount: 0, itemIds: [] }
  }
}

/**
 * Calculate BOGO (Buy X Get Y) discount
 */
function calculateBOGO(
  discount: DiscountCandidate['discount'],
  context: OrderContext,
): { amount: number; taxReduction: number; applicableItems: string[] } {
  if (!discount.buyQuantity || !discount.getQuantity) {
    return { amount: 0, taxReduction: 0, applicableItems: [] }
  }

  const buyQty = discount.buyQuantity
  const getQty = discount.getQuantity
  const discountPercent = discount.getDiscountPercent ?? 100 // Default: free item

  // Determine which items qualify for "buy" and "get"
  let buyItems = context.items
  let getItems = context.items

  if (discount.buyItemIds.length > 0) {
    buyItems = context.items.filter(i => discount.buyItemIds.includes(i.productId))
  }
  if (discount.getItemIds.length > 0) {
    getItems = context.items.filter(i => discount.getItemIds.includes(i.productId))
  }

  // Count total "buy" items
  const totalBuyQty = buyItems.reduce((sum, i) => sum + i.quantity, 0)

  // Calculate how many "get" items qualify
  const qualifyingSets = Math.floor(totalBuyQty / buyQty)
  const freeItemCount = qualifyingSets * getQty

  if (freeItemCount === 0) {
    return { amount: 0, taxReduction: 0, applicableItems: [] }
  }

  // Sort "get" items by price (cheapest first for standard BOGO)
  const sortedGetItems = [...getItems].sort((a, b) => a.unitPrice - b.unitPrice)

  // Calculate discount for the cheapest qualifying items
  let remainingFree = freeItemCount
  let totalDiscount = 0
  const applicableItems: string[] = []

  for (const item of sortedGetItems) {
    if (remainingFree <= 0) break

    const itemsToDiscount = Math.min(item.quantity, remainingFree)
    const itemDiscount = (item.unitPrice * itemsToDiscount * discountPercent) / 100

    totalDiscount += itemDiscount
    remainingFree -= itemsToDiscount
    applicableItems.push(item.id)
  }

  // Apply max discount cap
  if (discount.maxDiscountAmount !== null) {
    totalDiscount = Math.min(totalDiscount, discount.maxDiscountAmount)
  }

  // Round
  totalDiscount = Math.round(totalDiscount * 100) / 100

  // Tax reduction (if before tax)
  let taxReduction = 0
  if (discount.applyBeforeTax) {
    const avgTaxRate = estimateAverageTaxRate(applicableItems, context)
    taxReduction = Math.round(totalDiscount * avgTaxRate * 100) / 100
  }

  return {
    amount: totalDiscount,
    taxReduction,
    applicableItems,
  }
}

// ==========================================
// AUTOMATIC DISCOUNT APPLICATION
// ==========================================

/**
 * Evaluate and return all automatic discounts that should be applied to an order
 *
 * @param orderId - Order ID
 * @returns List of discounts to apply, sorted by priority
 */
export async function evaluateAutomaticDiscounts(orderId: string): Promise<DiscountCalculationResult[]> {
  // Load order with items
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              categoryId: true,
              taxRate: true,
            },
          },
          modifiers: {
            include: {
              modifier: {
                select: {
                  id: true,
                  groupId: true,
                  price: true,
                },
              },
            },
          },
        },
      },
      orderDiscounts: true,
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Build order context
  // Note: productId and product can be null if the product was deleted (Toast/Square pattern)
  const context: OrderContext = {
    orderId: order.id,
    venueId: order.venueId,
    customerId: order.customerId ?? undefined,
    subtotal: Number(order.subtotal),
    items: order.items
      .filter(item => item.productId && item.product) // Skip items with deleted products
      .map(item => ({
        id: item.id,
        productId: item.productId!,
        categoryId: item.product!.categoryId,
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        total: Number(item.total),
        modifiers: item.modifiers
          .filter(m => m.modifier) // Skip modifiers that were deleted
          .map(m => ({
            id: m.modifier!.id,
            modifierGroupId: m.modifier!.groupId,
            price: Number(m.modifier!.price),
          })),
      })),
    appliedDiscounts: order.orderDiscounts.map(od => ({
      discountId: od.discountId ?? '',
      amount: Number(od.amount),
      isAutomatic: od.isAutomatic,
    })),
  }

  // Get eligible automatic discounts
  const eligibleDiscounts = await getEligibleDiscounts(order.venueId, order.customerId ?? undefined, context.subtotal)
  const automaticDiscounts = eligibleDiscounts.filter(d => d.isAutomatic)

  // Also get customer-specific discounts if customer is identified
  let customerDiscounts: DiscountCandidate['discount'][] = []
  if (order.customerId) {
    customerDiscounts = await getCustomerDiscounts(order.venueId, order.customerId)
  }

  // Combine and deduplicate
  const allDiscounts = [...automaticDiscounts, ...customerDiscounts]
  const uniqueDiscounts = allDiscounts.filter((d, i, arr) => arr.findIndex(x => x.id === d.id) === i)

  // Sort by priority (highest first)
  uniqueDiscounts.sort((a, b) => b.priority - a.priority)

  // Calculate discount amounts
  const results: DiscountCalculationResult[] = []
  let appliedNonStackable = false

  for (const discount of uniqueDiscounts) {
    // Skip if already applied
    if (context.appliedDiscounts.some(ad => ad.discountId === discount.id)) {
      continue
    }

    // Handle stacking rules
    if (!discount.isStackable && appliedNonStackable) {
      continue // Can't stack non-stackable discounts
    }
    if (!discount.isStackable && results.length > 0) {
      continue // Non-stackable discount but we already have discounts
    }

    const calculation = calculateDiscountAmount(discount, context)

    if (calculation.amount > 0) {
      results.push(calculation)

      if (!discount.isStackable) {
        appliedNonStackable = true
      }
    }
  }

  return results
}

/**
 * Apply a calculated discount to an order
 *
 * @param orderId - Order ID
 * @param discount - Calculated discount result
 * @param appliedById - Staff ID applying the discount
 * @param authorizedById - Staff ID authorizing (for comps)
 */
export async function applyDiscountToOrder(
  orderId: string,
  discount: DiscountCalculationResult,
  appliedById?: string,
  authorizedById?: string,
): Promise<ApplyDiscountResult> {
  return prisma.$transaction(async tx => {
    // Get current order
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { orderDiscounts: true },
    })

    if (!order) {
      return { success: false, amount: 0, newOrderTotal: 0, error: 'Order not found' }
    }

    // Check if discount is already applied
    if (order.orderDiscounts.some(od => od.discountId === discount.discountId)) {
      return {
        success: false,
        amount: 0,
        newOrderTotal: Number(order.total),
        error: 'Discount already applied to this order',
      }
    }

    // Check if discount requires approval and we don't have authorization
    if (discount.requiresApproval && !authorizedById) {
      return {
        success: false,
        amount: 0,
        newOrderTotal: Number(order.total),
        error: 'This discount requires manager approval',
      }
    }

    // Create order discount record
    const orderDiscount = await tx.orderDiscount.create({
      data: {
        orderId,
        discountId: discount.discountId,
        type: discount.type,
        name: discount.name,
        value: discount.value,
        amount: discount.amount,
        taxReduction: discount.taxReduction,
        isAutomatic: discount.isAutomatic,
        isComp: discount.type === 'COMP',
        appliedById,
        authorizedById,
      },
    })

    // Update order totals
    const newDiscountAmount = Number(order.discountAmount) + discount.amount
    const newTaxAmount = Number(order.taxAmount) - discount.taxReduction
    const newTotal = Number(order.subtotal) - newDiscountAmount + newTaxAmount + Number(order.tipAmount)

    await tx.order.update({
      where: { id: orderId },
      data: {
        discountAmount: newDiscountAmount,
        taxAmount: newTaxAmount,
        total: newTotal,
        remainingBalance: Math.max(0, newTotal - Number(order.paidAmount)),
      },
    })

    // Increment discount usage counter
    await tx.discount.update({
      where: { id: discount.discountId },
      data: { currentUses: { increment: 1 } },
    })

    logger.info(`🎟️ Discount applied to order ${orderId}: ${discount.name} (-$${discount.amount})`)

    return {
      success: true,
      orderDiscountId: orderDiscount.id,
      amount: discount.amount,
      newOrderTotal: newTotal,
    }
  })
}

/**
 * Remove a discount from an order
 *
 * @param orderId - Order ID
 * @param orderDiscountId - OrderDiscount record ID
 */
export async function removeDiscountFromOrder(orderId: string, orderDiscountId: string): Promise<ApplyDiscountResult> {
  return prisma.$transaction(async tx => {
    const orderDiscount = await tx.orderDiscount.findFirst({
      where: { id: orderDiscountId, orderId },
    })

    if (!orderDiscount) {
      return { success: false, amount: 0, newOrderTotal: 0, error: 'Discount not found on this order' }
    }

    const order = await tx.order.findUnique({
      where: { id: orderId },
    })

    if (!order) {
      return { success: false, amount: 0, newOrderTotal: 0, error: 'Order not found' }
    }

    // Delete the order discount
    await tx.orderDiscount.delete({
      where: { id: orderDiscountId },
    })

    // Update order totals
    const newDiscountAmount = Math.max(0, Number(order.discountAmount) - Number(orderDiscount.amount))
    const newTaxAmount = Number(order.taxAmount) + Number(orderDiscount.taxReduction)
    const newTotal = Number(order.subtotal) - newDiscountAmount + newTaxAmount + Number(order.tipAmount)

    await tx.order.update({
      where: { id: orderId },
      data: {
        discountAmount: newDiscountAmount,
        taxAmount: newTaxAmount,
        total: newTotal,
        remainingBalance: Math.max(0, newTotal - Number(order.paidAmount)),
      },
    })

    // Decrement discount usage counter (if it was a tracked discount)
    if (orderDiscount.discountId) {
      await tx.discount.update({
        where: { id: orderDiscount.discountId },
        data: { currentUses: { decrement: 1 } },
      })
    }

    logger.info(`🗑️ Discount removed from order ${orderId}: ${orderDiscount.name} (+$${orderDiscount.amount})`)

    return {
      success: true,
      amount: Number(orderDiscount.amount),
      newOrderTotal: newTotal,
    }
  })
}

/**
 * Apply all eligible automatic discounts to an order
 *
 * @param orderId - Order ID
 * @param appliedById - Staff ID applying the discounts
 */
export async function applyAutomaticDiscounts(
  orderId: string,
  appliedById?: string,
): Promise<{ applied: DiscountCalculationResult[]; total: number }> {
  const discounts = await evaluateAutomaticDiscounts(orderId)

  const applied: DiscountCalculationResult[] = []
  let totalDiscount = 0

  for (const discount of discounts) {
    // Skip discounts requiring approval in automatic mode
    if (discount.requiresApproval) {
      continue
    }

    const result = await applyDiscountToOrder(orderId, discount, appliedById)

    if (result.success) {
      applied.push(discount)
      totalDiscount += discount.amount
    }
  }

  return { applied, total: totalDiscount }
}

// ==========================================
// MANUAL DISCOUNT APPLICATION
// ==========================================

/**
 * Apply a manual (on-the-fly) discount to an order
 * This creates a transient discount that's not saved to the Discount table
 *
 * @param orderId - Order ID
 * @param type - Discount type (PERCENTAGE, FIXED_AMOUNT, COMP)
 * @param value - Discount value
 * @param name - Discount name/reason
 * @param appliedById - Staff ID applying
 * @param authorizedById - Manager ID if comp
 * @param compReason - Reason for comp
 */
export async function applyManualDiscount(
  orderId: string,
  type: DiscountType,
  value: number,
  name: string,
  appliedById: string,
  authorizedById?: string,
  compReason?: string,
): Promise<ApplyDiscountResult> {
  return prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
    })

    if (!order) {
      return { success: false, amount: 0, newOrderTotal: 0, error: 'Order not found' }
    }

    // Calculate discount amount
    let amount = 0
    const subtotal = Number(order.subtotal)

    switch (type) {
      case 'PERCENTAGE':
        if (value < 0 || value > 100) {
          return { success: false, amount: 0, newOrderTotal: Number(order.total), error: 'Percentage must be 0-100' }
        }
        amount = (subtotal * value) / 100
        break
      case 'FIXED_AMOUNT':
        amount = Math.min(value, subtotal)
        break
      case 'COMP':
        amount = subtotal - Number(order.discountAmount) // Full remaining amount
        if (!authorizedById) {
          return { success: false, amount: 0, newOrderTotal: Number(order.total), error: 'Comp requires manager authorization' }
        }
        break
    }

    amount = Math.round(amount * 100) / 100

    // Create order discount record (no discountId since it's manual)
    const orderDiscount = await tx.orderDiscount.create({
      data: {
        orderId,
        type,
        name,
        value,
        amount,
        taxReduction: 0, // Manual discounts don't adjust tax by default
        isAutomatic: false,
        isManual: true,
        isComp: type === 'COMP',
        compReason,
        appliedById,
        authorizedById,
      },
    })

    // Update order totals
    const newDiscountAmount = Number(order.discountAmount) + amount
    const newTotal = subtotal - newDiscountAmount + Number(order.taxAmount) + Number(order.tipAmount)

    await tx.order.update({
      where: { id: orderId },
      data: {
        discountAmount: newDiscountAmount,
        total: newTotal,
        remainingBalance: Math.max(0, newTotal - Number(order.paidAmount)),
      },
    })

    logger.info(`🎟️ Manual discount applied to order ${orderId}: ${name} (-$${amount})`)

    return {
      success: true,
      orderDiscountId: orderDiscount.id,
      amount,
      newOrderTotal: newTotal,
    }
  })
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Check if current time is within a time window
 */
function isWithinTimeWindow(timeFrom: string, timeUntil: string): boolean {
  const now = new Date()
  const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`

  // Handle overnight windows (e.g., 22:00 - 02:00)
  if (timeFrom > timeUntil) {
    return currentTime >= timeFrom || currentTime <= timeUntil
  }

  return currentTime >= timeFrom && currentTime <= timeUntil
}

/**
 * Estimate average tax rate for applicable items
 */
function estimateAverageTaxRate(itemIds: string[], _context: OrderContext): number {
  if (itemIds.length === 0) return 0.16 // Default Mexican tax rate

  // We don't have tax rates in the context, use default
  // In production, this would look up actual product tax rates
  return 0.16
}

/**
 * Get order discounts summary
 */
export async function getOrderDiscountsSummary(orderId: string) {
  const orderDiscounts = await prisma.orderDiscount.findMany({
    where: { orderId },
    include: {
      discount: {
        select: {
          id: true,
          name: true,
          type: true,
          scope: true,
        },
      },
      couponCode: {
        select: {
          id: true,
          code: true,
        },
      },
      appliedBy: {
        select: {
          staff: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
        },
      },
      authorizedBy: {
        select: {
          staff: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return orderDiscounts.map(od => ({
    id: od.id,
    name: od.name,
    type: od.type,
    value: Number(od.value),
    amount: Number(od.amount),
    taxReduction: Number(od.taxReduction),
    isAutomatic: od.isAutomatic,
    isManual: od.isManual,
    isComp: od.isComp,
    compReason: od.compReason,
    discount: od.discount,
    couponCode: od.couponCode,
    appliedBy: od.appliedBy?.staff ? `${od.appliedBy.staff.firstName} ${od.appliedBy.staff.lastName}` : null,
    authorizedBy: od.authorizedBy?.staff ? `${od.authorizedBy.staff.firstName} ${od.authorizedBy.staff.lastName}` : null,
    createdAt: od.createdAt,
  }))
}
