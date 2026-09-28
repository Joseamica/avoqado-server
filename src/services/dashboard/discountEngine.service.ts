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
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { DEFAULT_TIMEZONE, isWithinVenueSchedule } from '@/utils/datetime'
import { DiscountScope, DiscountType, Prisma } from '@prisma/client'
import { logAction, type LogActionParams } from './activity-log.service'
import { computeStoredOrderTotal } from '../shared/orderBalance'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '../shared/paymentShiftClaim'
import { baseDeCargos, recalcularCargosPorServicio } from '../shared/serviceCharges'

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
  /** Si viene de una promoción, ningún descuento automático la toca. */
  orderPromotionId?: string | null
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
 * @param db - Previews use the global client; writers pass their locked transaction
 */
export async function getEligibleDiscounts(
  venueId: string,
  customerId?: string,
  orderTotal?: number,
  db: Prisma.TransactionClient = prisma,
): Promise<DiscountCandidate['discount'][]> {
  const now = new Date()
  // La vigencia se evalúa en la hora del NEGOCIO. El server corre en UTC; leer
  // la hora del proceso corría cualquier happy hour 6 horas en México.
  const venue = await db.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const timezone = venue?.timezone || DEFAULT_TIMEZONE

  // Get all active discounts for the venue
  const discounts = await db.discount.findMany({
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
    // Día y ventana horaria, en la zona del venue y respetando la ventana que
    // cruza la medianoche (un "martes 22:00-02:00" sigue vivo a la 1 am).
    if (!isWithinVenueSchedule(discount, now, timezone)) {
      continue
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
      const customerUses = await db.orderDiscount.count({
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
      const customer = await db.customer.findUnique({
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
export async function getCustomerDiscounts(
  venueId: string,
  customerId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<DiscountCandidate['discount'][]> {
  const now = new Date()
  const venue = await db.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const timezone = venue?.timezone || DEFAULT_TIMEZONE

  const customerDiscounts = await db.customerDiscount.findMany({
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
      // 🔴 Esta ruta NO evaluaba día ni hora: un happy hour asignado a un
      // cliente aplicaba 24/7, mientras el mismo descuento por la ruta
      // automática sí respetaba su horario. Dos respuestas distintas para el
      // mismo descuento, según cómo llegara.
      if (!isWithinVenueSchedule(cd.discount, now, timezone)) {
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
  // 🔴 Las líneas nacidas de una promoción quedan FUERA de todo descuento
  // automático: la promo ya trae su precio negociado y nada se le encima solo.
  //
  // No basta con filtrar `items`: el subtotal es la base de los porcentajes de
  // orden, y al agregar artículos se recalcula sobre el subtotal NUEVO — así
  // que un 20% subía de $20 a $39.80 al meter un combo de $99.
  // Sólo se reconstruye el contexto cuando SÍ hay líneas de promoción: una
  // orden sin promos conserva su subtotal tal cual (que no siempre es la suma
  // de las líneas — órdenes legacy y contextos parciales dependen de eso).
  if (context.items.some(i => i.orderPromotionId)) {
    const elegibles = context.items.filter(i => !i.orderPromotionId)
    context = {
      ...context,
      items: elegibles,
      subtotal: elegibles.reduce((sum, i) => sum + i.total, 0),
    }
  }

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

  // 🔴 Las unidades REGALADAS también ocupan lugar en el carrito.
  //
  // La cuenta vieja era `floor(totalBuyQty / buyQty)`, que trataba como
  // "compradas" TODAS las unidades del pool — incluidas las que estaba a punto
  // de regalar. Cuando los conjuntos se traslapan (el caso normal de un 2x1
  // sobre el mismo producto, y también el de dejar ambos filtros vacíos, que
  // hace que los dos pools sean TODO el carrito), eso regalaba la línea entera:
  // con buy=1/get=1 y 4 cervezas daba floor(4/1)=4 sets → las 4 gratis.
  //
  // Con conjuntos DISJUNTOS (compra pizzas, llevas refresco) la cuenta vieja sí
  // era correcta: el refresco nunca estuvo en el pool de compradas.
  const getItemIdSet = new Set(getItems.map(i => i.id))
  const poolsOverlap = buyItems.some(i => getItemIdSet.has(i.id))

  let freeItemCount: number
  if (poolsOverlap) {
    // Cada promoción completa consume buyQty pagadas MÁS getQty regaladas del
    // mismo montón, así que se cuenta sobre la unión de ambos pools.
    const unionById = new Map<string, number>()
    for (const item of [...buyItems, ...getItems]) unionById.set(item.id, item.quantity)
    const totalUnits = [...unionById.values()].reduce((sum, qty) => sum + qty, 0)
    freeItemCount = Math.floor(totalUnits / (buyQty + getQty)) * getQty
  } else {
    const totalBuyQty = buyItems.reduce((sum, i) => sum + i.quantity, 0)
    const totalGetQty = getItems.reduce((sum, i) => sum + i.quantity, 0)
    // Nunca se regalan más unidades de las que el cliente se está llevando.
    freeItemCount = Math.min(Math.floor(totalBuyQty / buyQty) * getQty, totalGetQty)
  }

  if (freeItemCount <= 0) {
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

/** Everything the evaluator reads from an Order: lines with product/category and modifiers, plus applied discounts. */
const ORDER_EVALUATION_INCLUDE = {
  items: {
    include: {
      product: { select: { id: true, categoryId: true, taxRate: true } },
      modifiers: { include: { modifier: { select: { id: true, groupId: true, price: true } } } },
    },
  },
  orderDiscounts: true,
} satisfies Prisma.OrderInclude

type EvaluationOrder = Prisma.OrderGetPayload<{ include: typeof ORDER_EVALUATION_INCLUDE }>

/**
 * Evaluate and return all automatic discounts that should be applied to an order
 *
 * @param orderId - Order ID
 * @param forceDiscountId - Evaluate THIS catalog discount too, even if it is not
 *   `isAutomatic`. Needed because a waiter picking a discount by hand is not an
 *   automatic rule: `applyPredefinedDiscount` used to call this function with no
 *   way to say so, so a hand-picked catalog discount never showed up in the result
 *   and every attempt died with "This discount cannot be applied to this order".
 *   Reproduced on hardware (NEXGO, 2026-08-06) — applying ANY catalog discount
 *   from the TPV picker always failed.
 *
 *   It only lifts the `isAutomatic` filter. Every other rule still applies: the
 *   discount must be active and eligible (dates, weekdays, minimum), it is skipped
 *   if already applied, and stacking rules are unchanged. Passing an id that is
 *   not eligible still yields nothing — the caller's rejection stays correct.
 * @param db - Previews use the global client; writers evaluate inside their locked transaction
 * @returns List of discounts to apply, sorted by priority
 */
export async function evaluateAutomaticDiscounts(
  orderId: string,
  forceDiscountId?: string,
  db: Prisma.TransactionClient = prisma,
): Promise<DiscountCalculationResult[]> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: ORDER_EVALUATION_INCLUDE })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  return evaluateOrderDiscounts(order, forceDiscountId, db)
}

/** The evaluator proper, over an Order already loaded through `db` (under the writer's lock when it writes). */
async function evaluateOrderDiscounts(
  order: EvaluationOrder,
  forceDiscountId: string | undefined,
  db: Prisma.TransactionClient,
): Promise<DiscountCalculationResult[]> {
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
        // Sin esto, el guard anti doble-descuento de calculateDiscountAmount
        // era código muerto: el contexto de producción nunca traía la marca.
        orderPromotionId: item.orderPromotionId ?? null,
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
  const eligibleDiscounts = await getEligibleDiscounts(order.venueId, order.customerId ?? undefined, context.subtotal, db)
  // A hand-picked catalog discount is eligible but not automatic — keep it too when
  // the caller named it (see `forceDiscountId` in this function's doc).
  const automaticDiscounts = eligibleDiscounts.filter(d => d.isAutomatic || d.id === forceDiscountId)

  // Also get customer-specific discounts if customer is identified
  let customerDiscounts: DiscountCandidate['discount'][] = []
  if (order.customerId) {
    customerDiscounts = await getCustomerDiscounts(order.venueId, order.customerId, db)
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
 * Canonical Order lock for every discount writer — the same `SELECT … FOR UPDATE` that payments and fiscal
 * admission take, so a discount never interleaves with a capture that is reading the Order.
 *
 * TPV callers pass the authoritative `venueId`. A legacy caller without it may resolve ONLY this Order's tenant
 * inside the transaction; that pre-lock read is discarded and everything that decides money is reread after the lock.
 * Returns the locked tenant, or null when the Order is missing or belongs to another venue.
 */
async function lockDiscountOrder(tx: Prisma.TransactionClient, orderId: string, venueId?: string): Promise<string | null> {
  const tenant = venueId ?? (await tx.order.findUnique({ where: { id: orderId }, select: { venueId: true } }))?.venueId
  if (!tenant) return null
  return (await lockExistingOrderForPayment(tx, { venueId: tenant, orderId })) ? tenant : null
}

/** TPV callers (authoritative venue) keep their 404; legacy callers keep the result object they always received. */
function orderNotFound(venueId?: string): ApplyDiscountResult {
  if (venueId) throw new NotFoundError('Order not found')
  return { success: false, amount: 0, newOrderTotal: 0, error: 'Order not found' }
}

/**
 * Apply a catalog discount to an order
 *
 * 🔴 The engine owns the transaction and the Order lock. `discount` is only INTENT (which catalog rule): a
 * precomputed calculation was read without this lock and discount writers never bump `Order.version`, so its
 * amount, tax and eligibility are recomputed here from the locked Order, the same transaction and the evaluator.
 *
 * @param orderId - Order ID
 * @param discount - The catalog discount id (TPV picker), or a previously calculated result (legacy callers)
 * @param appliedById - Staff ID applying the discount
 * @param authorizedById - Staff ID authorizing (for comps)
 * @param venueId - Authoritative tenant. With it, a missing Order THROWS instead of returning an error result (TPV contract).
 *   A catalog id (`discount` as a string) that is inactive or ineligible throws on its own, with or without `venueId`.
 */
export async function applyDiscountToOrder(
  orderId: string,
  discount: DiscountCalculationResult | string,
  appliedById?: string,
  authorizedById?: string,
  venueId?: string,
): Promise<ApplyDiscountResult> {
  const audits: LogActionParams[] = []
  const result = await prisma.$transaction(async tx => {
    const tenant = await lockDiscountOrder(tx, orderId, venueId)
    const order = tenant ? await tx.order.findUnique({ where: { id: orderId, venueId: tenant }, include: ORDER_EVALUATION_INCLUDE }) : null
    if (!order) return orderNotFound(venueId)
    if (order.paymentStatus === 'PAID') throw new BadRequestError('Cannot apply discount to a paid order')

    const picked = typeof discount === 'string'
    const discountId = picked ? discount : discount.discountId
    if (picked) {
      const catalog = await tx.discount.findFirst({ where: { id: discountId, venueId: order.venueId, active: true }, select: { id: true } })
      if (!catalog) throw new NotFoundError('Discount not found or inactive')
    } else if (order.orderDiscounts.some(od => od.discountId === discountId)) {
      return { success: false, amount: 0, newOrderTotal: Number(order.total), error: 'Discount already applied to this order' }
    }

    // `forceDiscountId`: a hand-picked rule is not automatic; every other eligibility and stacking rule still runs.
    const fresh = (await evaluateOrderDiscounts(order, discountId, tx)).find(d => d.discountId === discountId)
    if (!fresh) {
      if (picked) throw new BadRequestError('This discount cannot be applied to this order')
      return { success: false, amount: 0, newOrderTotal: Number(order.total), error: 'This discount cannot be applied to this order' }
    }

    return applyEvaluatedDiscount(tx, order, fresh, audits, appliedById, authorizedById)
  }, ORDER_LOCK_WAIT_BUDGET)
  for (const audit of audits) void logAction(audit)
  return result
}

/**
 * Tx-only application of a FRESH evaluation: the caller holds the Order lock and read `order` under it.
 * Audits are collected, never emitted here — the caller flushes them only after its commit.
 */
async function applyEvaluatedDiscount(
  tx: Prisma.TransactionClient,
  order: Prisma.OrderGetPayload<{ include: { orderDiscounts: true } }>,
  discount: DiscountCalculationResult,
  audits: LogActionParams[],
  appliedById?: string,
  authorizedById?: string,
  deferredUses?: string[],
): Promise<ApplyDiscountResult> {
  const orderId = order.id
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

  // 🔴 MONEY: `discount.amount` viene calculado contra el subtotal COMPLETO (calculateDiscountAmount
  // no conoce los descuentos ya aplicados), así que al apilar varios stackables la suma podía
  // pasarse del subtotal y dejar `total` NEGATIVO — enmascarado como cuenta pagada por el
  // Math.max(0,…) de remainingBalance. Recortamos contra lo que queda por descontar.
  // Ver `applyManualDiscount` (misma defensa) y la memoria descuento-manual-acumula-sin-tope.
  const subtotal = Number(order.subtotal)
  const alreadyDiscounted = Number(order.discountAmount)
  const remainingDiscountable = Math.round(Math.max(0, subtotal - alreadyDiscounted) * 100) / 100

  if (remainingDiscountable <= 0) {
    return {
      success: false,
      amount: 0,
      newOrderTotal: Number(order.total),
      error: 'La cuenta ya está completamente descontada; no se puede aplicar otro descuento.',
    }
  }

  const appliedAmount = Math.min(discount.amount, remainingDiscountable)
  // La reducción de impuesto se recorta en la MISMA proporción que el monto, si no un descuento
  // recortado seguiría restando el impuesto completo.
  const appliedTaxReduction =
    discount.amount > 0 ? Math.round(discount.taxReduction * (appliedAmount / discount.amount) * 100) / 100 : discount.taxReduction

  // Create order discount record
  const orderDiscount = await tx.orderDiscount.create({
    data: {
      orderId,
      discountId: discount.discountId,
      type: discount.type,
      name: discount.name,
      value: discount.value,
      amount: appliedAmount,
      taxReduction: appliedTaxReduction,
      isAutomatic: discount.isAutomatic,
      isComp: discount.type === 'COMP',
      appliedById,
      authorizedById,
    },
  })

  // Update order totals
  const newDiscountAmount = alreadyDiscounted + appliedAmount
  const newTaxAmount = Number(order.taxAmount) - appliedTaxReduction
  // 🔴 MONEY: el total sale de `computeStoredOrderTotal` —la ÚNICA definición de la regla—
  // y no de una suma escrita aquí. Escrita aquí OMITÍA `serviceChargeAmount`, que el schema
  // define como ingreso gravable que SUMA al total y entra al corte y al CFDI: descontar
  // borraba el cargo del total guardado hasta que un cobro posterior lo recalculaba.
  // 🔴 MONEY: un cargo por servicio PORCENTUAL se mueve CON la base (subtotal − descuentos),
  // y `order.serviceChargeAmount` es el snapshot CONGELADO. Regla compartida en
  // `shared/serviceCharges.ts`; se persiste abajo porque `computeOrderBalance` —lo que de
  // verdad se cobra— lee el snapshot y no las filas.
  const newServiceChargeAmount = await recalcularCargosPorServicio(tx, orderId, baseDeCargos(subtotal, newDiscountAmount))
  const newTotal = computeStoredOrderTotal({
    subtotal,
    discountAmount: newDiscountAmount,
    taxAmount: newTaxAmount,
    serviceChargeAmount: newServiceChargeAmount,
    tipAmount: order.tipAmount,
  }).toNumber()

  await tx.order.update({
    where: { id: orderId },
    data: {
      discountAmount: newDiscountAmount,
      taxAmount: newTaxAmount,
      serviceChargeAmount: newServiceChargeAmount,
      total: newTotal,
      remainingBalance: Math.max(0, newTotal - Number(order.paidAmount)),
    },
  })

  // Increment discount usage counter — the automatic batch defers it (see `applyAutomaticDiscounts`)
  if (deferredUses) deferredUses.push(discount.discountId)
  else
    await tx.discount.update({
      where: { id: discount.discountId },
      data: { currentUses: { increment: 1 } },
    })

  // Reportar SIEMPRE el monto realmente aplicado (recortado), no el solicitado — si no, la
  // bitácora y el retorno mienten cuando el recorte entra en juego.
  logger.info(`🎟️ Discount applied to order ${orderId}: ${discount.name} (-$${appliedAmount})`)

  audits.push({
    staffId: appliedById ?? authorizedById ?? null,
    venueId: order.venueId,
    action: 'DISCOUNT_APPLIED',
    entity: 'Order',
    entityId: orderId,
    data: {
      discountId: discount.discountId,
      amount: appliedAmount,
      ...(appliedAmount < discount.amount ? { requestedAmount: discount.amount, cappedTo: remainingDiscountable } : {}),
      source: 'catalog',
    },
  })

  return {
    success: true,
    orderDiscountId: orderDiscount.id,
    amount: appliedAmount,
    newOrderTotal: newTotal,
  }
}

/**
 * Remove a discount from an order
 *
 * @param orderId - Order ID
 * @param orderDiscountId - OrderDiscount record ID
 * @param venueId - Authoritative tenant (TPV). With it, a missing Order THROWS instead of returning an error result
 */
export async function removeDiscountFromOrder(
  orderId: string,
  orderDiscountId: string,
  staffId?: string,
  venueId?: string,
): Promise<ApplyDiscountResult> {
  const audits: LogActionParams[] = []
  const result = await prisma.$transaction(async tx => {
    // Lock first: the status, totals and the child row that decide the removal are all read under it.
    const tenant = await lockDiscountOrder(tx, orderId, venueId)
    const order = tenant ? await tx.order.findUnique({ where: { id: orderId, venueId: tenant } }) : null
    if (!order) return orderNotFound(venueId)
    if (order.paymentStatus === 'PAID') throw new BadRequestError('Cannot remove discount from a paid order')

    const orderDiscount = await tx.orderDiscount.findFirst({
      where: { id: orderDiscountId, orderId },
    })

    if (!orderDiscount) {
      return { success: false, amount: 0, newOrderTotal: 0, error: 'Discount not found on this order' }
    }

    // Delete the order discount
    await tx.orderDiscount.delete({
      where: { id: orderDiscountId },
    })

    // Update order totals
    const newDiscountAmount = Math.max(0, Number(order.discountAmount) - Number(orderDiscount.amount))
    const newTaxAmount = Number(order.taxAmount) + Number(orderDiscount.taxReduction)
    // 🔴 MONEY — `serviceChargeAmount` ADDS to the total (taxable business revenue,
    // not a tip and not a discount). It was omitted here, so removing a discount
    // from a check that ALSO carried a service charge DROPPED the charge from the
    // stored total and the customer underpaid.
    //
    // Reproduced on hardware against the real DB (NEXGO, 2026-08-06): should have
    // recalculated $35 -> $55 and landed at $35. `order.mobile.service.ts` already
    // included the charge; only this legacy path kept the old formula (since
    // Nov 2025). The bug was LATENT: nobody could remove a discount from the TPV
    // until that action was added, and that is what surfaced it.
    // Misma función que los caminos de APLICAR: era la última copia a mano de la regla, y
    // conservarla aparte es justo lo que dejó a los otros tres sin el cargo por servicio.
    // Gana además el clamp de la mercancía, que aquí faltaba.
    // 🔴 MONEY: aquí la base SUBE (se quita un descuento), así que un cargo PORCENTUAL sube
    // con ella y el error va en la dirección contraria a los demás caminos: con el snapshot
    // congelado el total sale BAJO y el NEGOCIO cobra de menos. Confirmado por Codex.
    const newServiceChargeAmount = await recalcularCargosPorServicio(tx, orderId, baseDeCargos(order.subtotal, newDiscountAmount))
    const newTotal = computeStoredOrderTotal({
      subtotal: order.subtotal,
      discountAmount: newDiscountAmount,
      taxAmount: newTaxAmount,
      serviceChargeAmount: newServiceChargeAmount,
      tipAmount: order.tipAmount,
    }).toNumber()

    await tx.order.update({
      where: { id: orderId },
      data: {
        discountAmount: newDiscountAmount,
        taxAmount: newTaxAmount,
        serviceChargeAmount: newServiceChargeAmount,
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

    audits.push({
      staffId: staffId ?? null,
      venueId: order.venueId,
      action: 'DISCOUNT_REMOVED',
      entity: 'Order',
      entityId: orderId,
      data: { discountId: orderDiscount.discountId },
    })

    return {
      success: true,
      amount: Number(orderDiscount.amount),
      newOrderTotal: newTotal,
    }
  }, ORDER_LOCK_WAIT_BUDGET)
  for (const audit of audits) void logAction(audit)
  return result
}

/**
 * Apply all eligible automatic discounts to an order
 *
 * ONE transaction and ONE Order lock for the whole batch: the eligible list is evaluated from the locked Order, each
 * application reads the totals the previous one left, and a failure rolls back every child, charge and total.
 *
 * ⚠️ Known limitation (preserved on purpose): `total` adds each rule's evaluated amount even when the stored
 * amount was capped against the remaining base; the persisted discounts are the capped ones.
 *
 * @param orderId - Order ID
 * @param appliedById - Staff ID applying the discounts
 * @param venueId - Authoritative tenant (TPV)
 */
export async function applyAutomaticDiscounts(
  orderId: string,
  appliedById?: string,
  venueId?: string,
): Promise<{ applied: DiscountCalculationResult[]; total: number }> {
  const audits: LogActionParams[] = []
  const result = await prisma.$transaction(async tx => {
    const tenant = await lockDiscountOrder(tx, orderId, venueId)
    const order = tenant ? await tx.order.findUnique({ where: { id: orderId, venueId: tenant }, include: ORDER_EVALUATION_INCLUDE }) : null
    if (!order) throw new NotFoundError('Order not found')
    if (order.paymentStatus === 'PAID') throw new BadRequestError('Cannot apply discounts to a paid order')

    const discounts = await evaluateOrderDiscounts(order, undefined, tx)

    const applied: DiscountCalculationResult[] = []
    const usedDiscountIds: string[] = []
    let totalDiscount = 0

    for (const discount of discounts) {
      // Skip discounts requiring approval in automatic mode
      if (discount.requiresApproval) {
        continue
      }

      const current = await tx.order.findUnique({ where: { id: orderId, venueId: order.venueId }, include: { orderDiscounts: true } })
      if (!current) throw new NotFoundError('Order not found')
      const outcome = await applyEvaluatedDiscount(tx, current, discount, audits, appliedById, undefined, usedDiscountIds)

      if (outcome.success) {
        applied.push(discount)
        totalDiscount += discount.amount
      }
    }

    // Usage counters go LAST and in ascending id order, so two batches never lock the same Discount rows in opposite
    // orders (ABBA deadlock). Only when/in which order the counter rows are written changes — application order,
    // amounts, caps and stacking above are untouched.
    for (const id of usedDiscountIds.sort()) {
      await tx.discount.update({ where: { id }, data: { currentUses: { increment: 1 } } })
    }

    return { applied, total: totalDiscount }
  }, ORDER_LOCK_WAIT_BUDGET)
  for (const audit of audits) void logAction(audit)
  return result
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
 * @param venueId - Authoritative tenant (TPV). With it, a missing Order THROWS instead of returning an error result
 */
export async function applyManualDiscount(
  orderId: string,
  type: DiscountType,
  value: number,
  name: string,
  appliedById: string,
  authorizedById?: string,
  compReason?: string,
  venueId?: string,
): Promise<ApplyDiscountResult> {
  return prisma.$transaction(async tx => {
    // The remaining base below comes from THIS read, under the canonical Order lock.
    const tenant = await lockDiscountOrder(tx, orderId, venueId)
    const order = tenant ? await tx.order.findUnique({ where: { id: orderId, venueId: tenant } }) : null
    if (!order) return orderNotFound(venueId)
    if (order.paymentStatus === 'PAID') throw new BadRequestError('Cannot apply discount to a paid order')

    // 🔴 MONEY: cada descuento se calcula contra lo que QUEDA por descontar, nunca contra el
    // subtotal completo. Aplicar 100% dos veces descontaba 200% del subtotal y dejaba `total`
    // NEGATIVO — con `remainingBalance` en Math.max(0,…) la cuenta se veía PAGADA sin cobrar.
    // (Bug real en prod 2026-07-30: 100% + 100% + $888 fijo sobre una cuenta de $888 → total
    // −$1,776. Misma clase que Odoo #69807 / #20432.) La rama COMP ya lo hacía bien; ahora las
    // tres comparten la misma base.
    const subtotal = Number(order.subtotal)
    const alreadyDiscounted = Number(order.discountAmount)
    const remainingDiscountable = Math.round(Math.max(0, subtotal - alreadyDiscounted) * 100) / 100

    if (remainingDiscountable <= 0) {
      return {
        success: false,
        amount: 0,
        newOrderTotal: Number(order.total),
        error: 'La cuenta ya está completamente descontada; no se puede aplicar otro descuento.',
      }
    }

    let amount = 0
    switch (type) {
      case 'PERCENTAGE':
        if (value < 0 || value > 100) {
          return { success: false, amount: 0, newOrderTotal: Number(order.total), error: 'Percentage must be 0-100' }
        }
        amount = (remainingDiscountable * value) / 100
        break
      case 'FIXED_AMOUNT':
        amount = Math.min(value, remainingDiscountable)
        break
      case 'COMP':
        amount = remainingDiscountable // Full remaining amount
        if (!authorizedById) {
          return { success: false, amount: 0, newOrderTotal: Number(order.total), error: 'Comp requires manager authorization' }
        }
        break
    }

    // Defensa final: el monto nunca puede exceder lo que queda por descontar.
    amount = Math.min(Math.round(amount * 100) / 100, remainingDiscountable)

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

    // Update order totals. `amount <= remainingDiscountable` garantiza que newDiscountAmount
    // nunca supere el subtotal, así que el total no puede quedar negativo; el clamp de la
    // mercancía que hace `computeStoredOrderTotal` es cinturón-y-tirantes por si alguien
    // cambia el cálculo de arriba.
    const newDiscountAmount = alreadyDiscounted + amount
    // 🔴 MONEY: misma regla compartida — sin ella este camino omitía `serviceChargeAmount`.
    // 🔴 MONEY: un cargo por servicio PORCENTUAL se mueve CON la base (subtotal − descuentos),
    // y `order.serviceChargeAmount` es el snapshot CONGELADO. Regla compartida en
    // `shared/serviceCharges.ts`; se persiste abajo porque `computeOrderBalance` —lo que de
    // verdad se cobra— lee el snapshot y no las filas.
    const newServiceChargeAmount = await recalcularCargosPorServicio(tx, orderId, baseDeCargos(subtotal, newDiscountAmount))
    const newTotal = computeStoredOrderTotal({
      subtotal,
      discountAmount: newDiscountAmount,
      taxAmount: order.taxAmount,
      serviceChargeAmount: newServiceChargeAmount,
      tipAmount: order.tipAmount,
    }).toNumber()

    await tx.order.update({
      where: { id: orderId },
      data: {
        discountAmount: newDiscountAmount,
        serviceChargeAmount: newServiceChargeAmount,
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
  }, ORDER_LOCK_WAIT_BUDGET)
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

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
