import { Payment, PaymentMethod, SplitType, OrderSource, PaymentSource } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { generateDigitalReceipt } from './digitalReceipt.tpv.service'
import { publishCommand } from '../../communication/rabbitmq/publisher'
import { trackRecentPaymentCommand } from '../pos-sync/posSyncOrder.service'
import { socketManager } from '../../communication/sockets/managers/socketManager'
import { SocketEventType } from '../../communication/sockets/types'
import { createTransactionCost } from '../payments/transactionCost.service'
import { deductInventoryForProduct, getProductInventoryStatus } from '../dashboard/productInventoryIntegration.service'
import type { OrderModifierForInventory } from '../dashboard/rawMaterial.service'
import { parseDateRange } from '@/utils/datetime'
import { earnPoints } from '../dashboard/loyalty.dashboard.service'
import { updateCustomerMetrics } from '../dashboard/customer.dashboard.service'
import { createCommissionForPayment } from '../dashboard/commission/commission-calculation.service'
import { serializedInventoryService } from '../serialized-inventory/serializedInventory.service'

/**
 * Convert TPV rating strings to numeric values for database storage
 *
 * **Supports:**
 * - Numeric strings: "1", "2", "3", "4", "5" (new Android format - 2025-01-30)
 * - Categorical strings: "EXCELLENT", "GOOD", "POOR" (legacy format - backward compatibility)
 *
 * @param tpvRating The rating string from TPV
 * @returns Numeric rating (1-5) or null if invalid
 */
function mapTpvRatingToNumeric(tpvRating: string): number | null {
  // ✅ NEW: First try to parse as numeric string (Android app sends "1"-"5")
  const numericRating = parseInt(tpvRating, 10)
  if (!isNaN(numericRating) && numericRating >= 1 && numericRating <= 5) {
    return numericRating
  }

  // ⚠️ LEGACY: Fallback to categorical format for backward compatibility
  const ratingMap: Record<string, number> = {
    EXCELLENT: 5,
    GOOD: 3,
    POOR: 1,
  }

  return ratingMap[tpvRating.toUpperCase()] || null
}

/**
 * ✅ WORLD-CLASS PATTERN: Pre-flight validation (Stripe, Shopify, Toast POS)
 * Validate inventory availability BEFORE capturing payment
 * Also validates modifier inventory (Toast/Square pattern)
 *
 * @param venueId Venue ID
 * @param orderItems Order items to validate (including modifiers)
 * @returns Validation result with issues if any
 */
async function validateOrderInventoryAvailability(
  venueId: string,
  orderItems: Array<{
    productId: string
    product: { name: string }
    quantity: number
    modifiers?: Array<{
      quantity: number
      modifier: {
        id: string
        name: string
        rawMaterialId: string | null
        quantityPerUnit: any // Decimal
        unit: string | null
        inventoryMode: string
      }
    }>
  }>,
): Promise<{
  available: boolean
  issues?: Array<{ productId: string; productName: string; requested: number; available: number | string; reason: string }>
}> {
  const issues: Array<{ productId: string; productName: string; requested: number; available: number | string; reason: string }> = []

  // Validate each product
  for (const item of orderItems) {
    try {
      const inventoryStatus = await getProductInventoryStatus(venueId, item.productId)

      // No inventory tracking → always available
      if (!inventoryStatus.inventoryMethod) {
        continue
      }

      // QUANTITY method → check current stock
      if (inventoryStatus.inventoryMethod === 'QUANTITY') {
        const currentStock = inventoryStatus.currentStock || 0

        if (currentStock < item.quantity) {
          issues.push({
            productId: item.productId,
            productName: item.product.name,
            requested: item.quantity,
            available: currentStock,
            reason: 'Insufficient stock for product',
          })
        }
      }

      // RECIPE method → check max portions
      if (inventoryStatus.inventoryMethod === 'RECIPE') {
        const maxPortions = inventoryStatus.maxPortions || 0

        if (maxPortions < item.quantity) {
          // Gather missing ingredient details
          const missingIngredients =
            inventoryStatus.insufficientIngredients
              ?.map(ing => `${ing.name} (need ${ing.required} ${ing.unit}, have ${ing.available} ${ing.unit})`)
              .join(', ') || 'Unknown ingredients'

          issues.push({
            productId: item.productId,
            productName: item.product.name,
            requested: item.quantity,
            available: `${maxPortions} portions (missing: ${missingIngredients})`,
            reason: 'Insufficient ingredients for recipe',
          })
        }
      }
    } catch (error: any) {
      logger.error('⚠️ Failed to validate inventory for product', {
        productId: item.productId,
        productName: item.product.name,
        error: error.message,
      })

      // If validation fails for any reason, mark as unavailable
      issues.push({
        productId: item.productId,
        productName: item.product.name,
        requested: item.quantity,
        available: 'Unknown',
        reason: `Validation error: ${error.message}`,
      })
    }

    // ✅ WORLD-CLASS: Validate modifier inventory (Toast/Square pattern)
    if (item.modifiers?.length) {
      for (const orderModifier of item.modifiers) {
        const modifier = orderModifier.modifier

        // Skip modifiers without inventory tracking
        if (!modifier.rawMaterialId || !modifier.quantityPerUnit) continue

        try {
          // Check raw material stock for this modifier
          const rawMaterial = await prisma.rawMaterial.findUnique({
            where: { id: modifier.rawMaterialId },
            select: {
              id: true,
              name: true,
              currentStock: true,
              unit: true,
            },
          })

          if (!rawMaterial) {
            issues.push({
              productId: item.productId,
              productName: `${item.product.name} + ${modifier.name}`,
              requested: orderModifier.quantity,
              available: 'Unknown',
              reason: `Raw material not found for modifier ${modifier.name}`,
            })
            continue
          }

          // Calculate total quantity needed: quantityPerUnit × orderItem.quantity × modifier.quantity
          const quantityPerUnit = parseFloat(modifier.quantityPerUnit.toString())
          const totalNeeded = quantityPerUnit * item.quantity * orderModifier.quantity
          const currentStock = parseFloat(rawMaterial.currentStock.toString())

          if (currentStock < totalNeeded) {
            issues.push({
              productId: item.productId,
              productName: `${item.product.name} + ${modifier.name}`,
              requested: totalNeeded,
              available: `${currentStock} ${rawMaterial.unit}`,
              reason: `Insufficient ${rawMaterial.name} for modifier`,
            })
          }
        } catch (modifierError: any) {
          logger.error('⚠️ Failed to validate inventory for modifier', {
            productId: item.productId,
            modifierId: modifier.id,
            modifierName: modifier.name,
            error: modifierError.message,
          })
        }
      }
    }
  }

  return {
    available: issues.length === 0,
    issues: issues.length > 0 ? issues : undefined,
  }
}

/**
 * ✅ WORLD-CLASS PATTERN: Pre-flight validation BEFORE payment capture (Stripe, Shopify, Toast POS)
 * Validates inventory availability before creating payment record
 * Prevents charging customers for orders that cannot be fulfilled
 *
 * @param order Order with items and existing payments
 * @param paymentAmount Payment amount being processed (including tip)
 * @throws BadRequestError if inventory validation fails for a full payment
 */
async function validatePreFlightInventory(
  order: {
    id: string
    venueId: string
    total: any
    items: Array<{
      productId: string | null
      product: { name: string } | null
      productName?: string | null
      quantity: number
      paymentAllocations?: any[]
    }>
    payments: Array<{ amount: any; tipAmount: any }>
  },
  paymentAmount: number,
): Promise<void> {
  // Calculate total payments (including this new one)
  const previousPayments = order.payments.reduce(
    (sum, payment) => sum + parseFloat(payment.amount.toString()) + parseFloat(payment.tipAmount.toString()),
    0,
  )
  const totalPaid = previousPayments + paymentAmount
  const originalTotal = parseFloat(order.total.toString())

  // Check if this payment will fully pay the order
  const remainingAmount = Math.max(0, originalTotal - totalPaid)
  const willBeFullyPaid = remainingAmount <= 0.01 // Account for floating point precision

  // Only validate inventory if this payment will complete the order
  if (willBeFullyPaid) {
    // ✅ FIX: Only validate items that haven't been paid yet (no paymentAllocations)
    // Items with paymentAllocations have already been "claimed" by a previous split payment
    // Their inventory will be deducted when the order is completed
    const unpaidItems = order.items.filter(item => !item.paymentAllocations || item.paymentAllocations.length === 0)

    // Filter out items with deleted products (null productId) - they can't be validated for inventory
    const itemsToValidate = unpaidItems.filter(
      (item): item is typeof item & { productId: string; product: { name: string } } => item.productId !== null && item.product !== null,
    )

    logger.info('🔍 PRE-FLIGHT: Checking inventory before creating payment', {
      orderId: order.id,
      venueId: order.venueId,
      paymentAmount,
      totalPaid,
      originalTotal,
      totalItems: order.items.length,
      unpaidItems: unpaidItems.length,
      itemsToValidate: itemsToValidate.length,
      skippedDeletedProducts: unpaidItems.length - itemsToValidate.length,
      paidItems: order.items.length - unpaidItems.length,
    })

    const validation = await validateOrderInventoryAvailability(order.venueId, itemsToValidate)

    if (!validation.available) {
      logger.error('❌ PRE-FLIGHT FAILED: Insufficient inventory - Payment rejected', {
        orderId: order.id,
        venueId: order.venueId,
        issues: validation.issues,
      })

      // Format issues into error message
      const issuesDescription = validation.issues
        ?.map(issue => `${issue.productName}: requested ${issue.requested}, available ${issue.available} (${issue.reason})`)
        .join('; ')

      throw new BadRequestError(
        `Cannot complete order - insufficient inventory. ${issuesDescription || 'Please check stock levels and try again.'}`,
      )
    }

    logger.info('✅ PRE-FLIGHT PASSED: Inventory available, proceeding with payment', {
      orderId: order.id,
      venueId: order.venueId,
    })
  } else {
    logger.info('⏭️ PRE-FLIGHT SKIPPED: Partial payment, inventory validation deferred', {
      orderId: order.id,
      paymentAmount,
      totalPaid,
      originalTotal,
      remainingAfterPayment: remainingAmount,
    })
  }
}

/**
 * Map payment source from Android app format to PaymentSource enum
 * @param source The source string from the app (e.g., "AVOQADO_TPV")
 * @returns Valid PaymentSource enum value
 */
function mapPaymentSource(source?: string): PaymentSource {
  if (!source) return 'OTHER'

  // Map "AVOQADO_TPV" from Android app to "TPV" enum value
  if (source === 'AVOQADO_TPV') return 'TPV'

  // Check if it's a valid PaymentSource enum value
  const validSources: PaymentSource[] = ['TPV', 'DASHBOARD_TEST', 'QR', 'WEB', 'APP', 'PHONE', 'POS', 'OTHER']
  return validSources.includes(source as PaymentSource) ? (source as PaymentSource) : 'OTHER'
}

/**
 * Update order totals directly in backend for standalone mode
 * @param orderId Order ID to update
 * @param paymentAmount Total payment amount (including tip)
 * @param tipAmount Tip amount from this payment (to calculate cumulative order.tipAmount)
 * @param currentPaymentId Current payment ID to exclude from calculation
 * @param staffId Optional staff ID who processed the payment (for loyalty points)
 */
async function updateOrderTotalsForStandalonePayment(
  orderId: string,
  paymentAmount: number,
  tipAmount: number, // ✅ FIX: Pass tip separately to update order.tipAmount
  currentPaymentId?: string,
  staffId?: string,
): Promise<void> {
  // Get current order with payment information
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      payments: {
        where: {
          status: 'COMPLETED',
          // ✅ FIX: Exclude the current payment to avoid double-counting
          ...(currentPaymentId && { id: { not: currentPaymentId } }),
        },
        select: { amount: true, tipAmount: true },
      },
      items: {
        include: {
          product: true,
          // ✅ Include paymentAllocations to filter out paid items in validation
          paymentAllocations: true,
        },
      },
      customer: true, // ⭐ LOYALTY: Need customer for points earning
    },
  })

  if (!order) {
    throw new Error(`Order ${orderId} not found for total update`)
  }

  // Calculate total payments made (including this new one)
  const previousPayments = order.payments.reduce(
    (sum, payment) => sum + parseFloat(payment.amount.toString()) + parseFloat(payment.tipAmount.toString()),
    0,
  )
  const totalPaid = previousPayments + paymentAmount

  // ✅ FIX: Use subtotal as base (doesn't include tips), not order.total (which may already include tips from previous payments)
  const orderSubtotal = parseFloat(order.subtotal.toString())

  // ✅ FIX: Calculate cumulative tip from all completed payments + current tip
  const previousTips = order.payments.reduce((sum, payment) => sum + parseFloat(payment.tipAmount.toString()), 0)
  const totalTip = previousTips + tipAmount

  // ✅ FIX: Calculate new total including tips (consistent with fast payments)
  const newTotal = orderSubtotal + totalTip

  // Calculate remaining amount (based on new total)
  const remainingAmount = Math.max(0, newTotal - totalPaid)
  const isFullyPaid = remainingAmount <= 0.01 // Account for floating point precision

  // ✅ WORLD-CLASS: Pre-flight validation BEFORE capturing payment (Stripe pattern)
  // Validate inventory availability before marking order as complete
  if (isFullyPaid) {
    // ✅ FIX: Only validate items that haven't been paid yet (no paymentAllocations)
    // Items with paymentAllocations have already been "claimed" by a previous split payment
    // Also skip items with deleted products (productId is null - Toast/Square pattern)
    const unpaidItems = order.items.filter(
      (item: any) => item.productId && (!item.paymentAllocations || item.paymentAllocations.length === 0),
    )

    logger.info('🔍 Pre-flight validation: Checking inventory availability before completing order', {
      orderId,
      venueId: order.venueId,
      totalItems: order.items.length,
      unpaidItems: unpaidItems.length,
      paidItems: order.items.length - unpaidItems.length,
    })

    const validation = await validateOrderInventoryAvailability(
      order.venueId,
      unpaidItems as { productId: string; product: { name: string }; quantity: number; modifiers?: any[] }[],
    )

    if (!validation.available) {
      logger.error('❌ Pre-flight validation failed: Insufficient inventory', {
        orderId,
        venueId: order.venueId,
        issues: validation.issues,
      })

      // Format issues into error message
      const issuesDescription = validation.issues
        ?.map(issue => `${issue.productName}: requested ${issue.requested}, available ${issue.available} (${issue.reason})`)
        .join('; ')

      throw new BadRequestError(
        `Cannot complete order - insufficient inventory. ${issuesDescription || 'Please check stock levels and try again.'}`,
      )
    }

    logger.info('✅ Pre-flight validation passed: All inventory available', {
      orderId,
      venueId: order.venueId,
    })
  }

  // Determine new payment status
  let newPaymentStatus = order.paymentStatus
  if (isFullyPaid) {
    newPaymentStatus = 'PAID'
  } else if (totalPaid > 0) {
    newPaymentStatus = 'PARTIAL'
  }

  // Update order totals and status (including partial payment tracking)
  // ⭐ KIOSK MODE FIX: If servedById is null, assign the staff who processed the payment
  const shouldAssignServer = !order.servedById && staffId

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      paymentStatus: newPaymentStatus,
      // ⭐ Partial payment tracking: Persist paidAmount and remainingBalance
      paidAmount: totalPaid,
      remainingBalance: remainingAmount,
      // ✅ FIX: Update order.tipAmount with cumulative tip from all payments
      tipAmount: totalTip,
      // ✅ FIX: Update order.total to include cumulative tips (consistent with fast payments)
      total: newTotal,
      // ⭐ KIOSK MODE: Assign payment processor as server if no server was assigned
      ...(shouldAssignServer && {
        servedById: staffId,
        createdById: order.createdById || staffId, // Also set createdById if null
      }),
      ...(isFullyPaid && {
        status: 'COMPLETED',
        completedAt: new Date(),
      }),
    },
    include: {
      items: {
        include: {
          product: true,
          // ✅ Include modifiers with inventory-related fields for stock deduction
          modifiers: {
            include: {
              modifier: {
                select: {
                  id: true,
                  name: true,
                  groupId: true,
                  rawMaterialId: true,
                  quantityPerUnit: true,
                  unit: true,
                  inventoryMode: true,
                },
              },
            },
          },
        },
      },
    },
  })

  logger.info('Order totals updated for standalone payment', {
    orderId,
    orderSubtotal,
    newTotal, // ✅ Subtotal + cumulative tips
    paymentAmount,
    tipAmount,
    totalTip, // ✅ Cumulative tip from all payments
    totalPaid,
    remainingAmount,
    isFullyPaid,
    newPaymentStatus,
    // ⭐ KIOSK MODE: Log if we assigned the server from payment processor
    kioskModeServerAssigned: shouldAssignServer,
    assignedServerId: shouldAssignServer ? staffId : null,
  })

  // 🔥 INVENTORY DEDUCTION: Automatically deduct stock when order is completed
  // ✅ WORLD-CLASS PATTERN: Fail payment if inventory deduction fails (Shopify, Square, Toast)
  if (isFullyPaid) {
    const deductionErrors: Array<{ productId: string; productName: string; error: string }> = []

    logger.info('🎯 Starting inventory deduction for completed order', {
      orderId,
      venueId: updatedOrder.venueId,
      itemCount: updatedOrder.items.length,
    })

    // Deduct stock for each product in the order
    for (const item of updatedOrder.items) {
      // Skip items where product was deleted (Toast/Square pattern)
      if (!item.productId) {
        // ⚠️ SERIALIZED INVENTORY: Check if this is a serialized item before skipping
        // Serialized items have productId=null but productSku contains the serial number
        if (item.productSku) {
          try {
            logger.info('📦 Marking serialized item as SOLD', {
              orderId,
              orderItemId: item.id,
              serialNumber: item.productSku,
              productName: item.productName,
            })
            await serializedInventoryService.markAsSold(
              updatedOrder.venueId,
              item.productSku, // Serial number stored in productSku
              item.id, // orderItemId
            )
            logger.info('✅ Serialized item marked as SOLD', {
              orderId,
              serialNumber: item.productSku,
            })
          } catch (markAsSoldError: any) {
            logger.error('❌ Failed to mark serialized item as SOLD', {
              orderId,
              orderItemId: item.id,
              serialNumber: item.productSku,
              error: markAsSoldError.message,
            })
            // Don't fail the payment if marking as sold fails
            // Item will remain in AVAILABLE status and can be manually corrected
          }
        } else {
          logger.info('⏭️ Skipping inventory deduction for deleted product', {
            orderId,
            productName: item.productName,
          })
        }
        continue
      }

      try {
        // ✅ Transform order item modifiers to inventory format
        // Skip modifiers where the modifier was deleted (Toast/Square pattern)
        const orderModifiers: OrderModifierForInventory[] =
          item.modifiers
            ?.filter(m => m.modifier)
            .map(m => ({
              quantity: m.quantity,
              modifier: {
                id: m.modifier!.id,
                name: m.modifier!.name,
                groupId: m.modifier!.groupId,
                rawMaterialId: m.modifier!.rawMaterialId,
                quantityPerUnit: m.modifier!.quantityPerUnit,
                unit: m.modifier!.unit,
                inventoryMode: m.modifier!.inventoryMode,
              },
            })) || []

        await deductInventoryForProduct(
          updatedOrder.venueId,
          item.productId,
          item.quantity,
          orderId,
          staffId, // staffId for tracking who processed the order
          orderModifiers,
        )

        logger.info('✅ Stock deducted successfully for product', {
          orderId,
          productId: item.productId,
          productName: item.product?.name || item.productName,
          quantity: item.quantity,
          modifiersCount: orderModifiers.length,
        })
      } catch (deductionError: any) {
        // Collect errors instead of swallowing them
        const errorReason = deductionError.message.includes('does not have a recipe')
          ? 'NO_RECIPE'
          : deductionError.message.includes('Insufficient stock')
            ? 'INSUFFICIENT_STOCK'
            : deductionError.message.includes('could not obtain lock')
              ? 'CONCURRENT_TRANSACTION'
              : 'UNKNOWN'

        logger.error('❌ Failed to deduct stock for product', {
          orderId,
          productId: item.productId,
          productName: item.product?.name || item.productName,
          quantity: item.quantity,
          error: deductionError.message,
          reason: errorReason,
        })

        // Only track critical errors (insufficient stock, concurrent access)
        // Skip NO_RECIPE errors for products without inventory tracking
        if (errorReason === 'INSUFFICIENT_STOCK' || errorReason === 'CONCURRENT_TRANSACTION') {
          deductionErrors.push({
            productId: item.productId!,
            productName: item.product?.name || item.productName || 'Unknown',
            error: deductionError.message,
          })
        }
      }
    }

    // ✅ FIX: Rollback order if ANY critical inventory deduction failed
    if (deductionErrors.length > 0) {
      logger.error('❌ CRITICAL: Inventory deduction failed, rolling back order completion', {
        orderId,
        failedProducts: deductionErrors,
      })

      // Rollback the order to PENDING state
      await prisma.order.update({
        where: { id: orderId },
        data: {
          status: 'PENDING',
          paymentStatus: 'PARTIAL',
          completedAt: null,
        },
      })

      // Build user-friendly error message
      const productNames = deductionErrors.map(e => e.productName).join(', ')
      const errorDetails = deductionErrors.map(e => `${e.productName}: ${e.error}`).join('; ')

      throw new BadRequestError(
        `Payment could not be completed due to insufficient inventory for: ${productNames}. ` +
          `Please reduce quantity or remove items from your order. Details: ${errorDetails}`,
      )
    }

    logger.info('🎯 Inventory deduction completed successfully for order', {
      orderId,
      totalItems: updatedOrder.items.length,
    })

    // 🎟️ COUPON FINALIZATION: Mark coupons as redeemed when order is fully paid
    // ✅ WORLD-CLASS PATTERN: Coupons are "applied" at checkout but only "redeemed" on payment (Toast, Square)
    try {
      await finalizeCouponsForOrder(updatedOrder.venueId, orderId)
    } catch (couponError: any) {
      // ⚠️ Don't fail the payment if coupon finalization fails - just log the error
      logger.error('⚠️ Failed to finalize coupons (payment still succeeded)', {
        orderId,
        error: couponError.message,
      })
      // Continue execution - payment is still successful
    }

    // 🎁 CUSTOMER METRICS & LOYALTY POINTS: Update for ALL customers, points for PRIMARY only
    // ✅ WORLD-CLASS PATTERN: Multiple customers per order (visit tracking + loyalty)
    const orderTotal = parseFloat(updatedOrder.total.toString())

    // 🔧 FIX: LoyaltyTransaction.createdById expects StaffVenue ID (not Staff ID)
    // Look up StaffVenue ID from Staff ID for proper foreign key reference
    let staffVenueId: string | undefined = undefined
    if (staffId) {
      const staffVenue = await prisma.staffVenue.findFirst({
        where: {
          staffId: staffId,
          venueId: updatedOrder.venueId,
        },
        select: { id: true },
      })
      staffVenueId = staffVenue?.id
    }

    // Get ALL customers associated with this order (multi-customer support)
    const orderCustomers = await prisma.orderCustomer.findMany({
      where: { orderId },
      include: {
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { addedAt: 'asc' },
    })

    if (orderCustomers.length > 0) {
      // Update metrics (totalVisits, lastVisitAt, totalSpent) for ALL customers
      for (const oc of orderCustomers) {
        try {
          await updateCustomerMetrics(oc.customerId, orderTotal)
          logger.info('📊 Customer metrics updated', {
            orderId,
            customerId: oc.customerId,
            customerName: `${oc.customer.firstName || ''} ${oc.customer.lastName || ''}`.trim(),
            isPrimary: oc.isPrimary,
          })
        } catch (metricsError: any) {
          logger.error('⚠️ Failed to update customer metrics (continuing)', {
            orderId,
            customerId: oc.customerId,
            error: metricsError.message,
          })
        }

        // Award loyalty points ONLY to PRIMARY customer (first added)
        if (oc.isPrimary) {
          try {
            const loyaltyResult = await earnPoints(updatedOrder.venueId, oc.customerId, orderTotal, orderId, staffVenueId)
            logger.info('🎁 Loyalty points earned (PRIMARY customer)', {
              orderId,
              customerId: oc.customerId,
              customerName: `${oc.customer.firstName || ''} ${oc.customer.lastName || ''}`.trim(),
              orderTotal,
              pointsEarned: loyaltyResult.pointsEarned,
              newBalance: loyaltyResult.newBalance,
            })
          } catch (loyaltyError: any) {
            logger.error('⚠️ Failed to earn loyalty points (payment still succeeded)', {
              orderId,
              customerId: oc.customerId,
              error: loyaltyError.message,
              reason: loyaltyError.message.includes('not enabled') ? 'LOYALTY_DISABLED' : 'LOYALTY_ERROR',
            })
          }
        }
      }
    } else if (order.customerId && order.customer) {
      // Backward compatibility: If no OrderCustomer records, use legacy single customerId
      try {
        await updateCustomerMetrics(order.customerId, orderTotal)
        const loyaltyResult = await earnPoints(updatedOrder.venueId, order.customerId, orderTotal, orderId, staffVenueId)
        logger.info('🎁 Loyalty points earned (legacy single customer)', {
          orderId,
          customerId: order.customerId,
          customerName: `${order.customer.firstName || ''} ${order.customer.lastName || ''}`.trim(),
          orderTotal,
          pointsEarned: loyaltyResult.pointsEarned,
          newBalance: loyaltyResult.newBalance,
        })
      } catch (loyaltyError: any) {
        logger.error('⚠️ Failed to earn loyalty points (payment still succeeded)', {
          orderId,
          customerId: order.customerId,
          error: loyaltyError.message,
          reason: loyaltyError.message.includes('not enabled') ? 'LOYALTY_DISABLED' : 'LOYALTY_ERROR',
        })
      }
    } else {
      logger.info('⏭️ Loyalty points skipped: Order has no customer', {
        orderId,
        hasCustomerId: !!order.customerId,
        orderCustomersCount: orderCustomers.length,
        isGuestOrder: !order.customerId && orderCustomers.length === 0,
      })
    }
  }
}

interface PaymentFilters {
  fromDate?: string
  toDate?: string
  staffId?: string
}

interface PaginationResponse<T> {
  data: T[]
  meta: {
    totalCount: number
    pageSize: number
    currentPage: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
    diagnostics?: any
  }
}

/**
 * Validate staff and venue relationship using staffId
 * @param staffId Staff ID to validate
 * @param venueId Venue ID to validate against
 * @param userId Fallback user ID if staffId is not provided
 * @returns Validated staff ID
 */
export async function validateStaffVenue(staffId: string | undefined, venueId: string, userId?: string): Promise<string | undefined> {
  // Use userId as fallback if no staffId provided
  if (!staffId) {
    return userId
  }

  let actualStaffId = staffId

  // 🔧 [TEMP FIX] Handle numeric staffId from Android app (e.g., "1", "2", "3")
  // Android app sends numeric indices instead of proper CUIDs - map to actual staffIds
  if (/^\d+$/.test(staffId)) {
    logger.warn('🔧 [TEMP FIX] Received numeric staffId from Android app', { staffId, venueId })

    try {
      // Get all staff assigned to this venue, ordered by creation date
      const staffVenues = await prisma.staffVenue.findMany({
        where: {
          venueId,
          active: true,
        },
        include: {
          staff: true,
        },
        orderBy: {
          startDate: 'asc',
        },
      })

      if (staffVenues.length === 0) {
        throw new BadRequestError(`No active staff found for venue ${venueId}`)
      }

      // Map numeric index to actual staffId (1-based index from Android)
      const staffIndex = parseInt(staffId) - 1
      if (staffIndex < 0 || staffIndex >= staffVenues.length) {
        logger.error('🔧 [TEMP FIX] Invalid staff index', { staffId, staffIndex, availableStaff: staffVenues.length })
        throw new BadRequestError(`Invalid staff index ${staffId}. Available staff: 1-${staffVenues.length}`)
      }

      actualStaffId = staffVenues[staffIndex].staffId
      logger.info('🔧 [TEMP FIX] Mapped numeric staffId to actual CUID', {
        originalStaffId: staffId,
        mappedStaffId: actualStaffId,
        staffName: `${staffVenues[staffIndex].staff?.firstName || 'Unknown'} ${staffVenues[staffIndex].staff?.lastName || 'Staff'}`,
      })
    } catch (error) {
      logger.error('🔧 [TEMP FIX] Failed to map numeric staffId', { staffId, venueId, error })
      throw new BadRequestError(`Failed to resolve staff ID ${staffId} for venue ${venueId}`)
    }
  }

  // Validate that staff exists and is assigned to this venue
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId: actualStaffId,
      venueId,
      active: true,
    },
    include: {
      staff: true,
    },
  })

  if (!staffVenue) {
    throw new BadRequestError(`Staff ${actualStaffId} is not assigned to venue ${venueId} or is inactive`)
  }

  return staffVenue.staffId
}

/**
 * Get payments for a venue with pagination and filtering
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param pageSize Number of items per page
 * @param pageNumber Page number
 * @param filters Filter options
 * @returns Paginated payment results
 */
export async function getPayments(
  venueId: string,
  pageSize: number,
  pageNumber: number,
  filters: PaymentFilters = {},
  _orgId?: string,
): Promise<PaginationResponse<Payment>> {
  const { fromDate, toDate, staffId } = filters

  // Build the query filters
  const whereClause: any = {
    venueId: venueId,
  }

  // Add date range filters if provided using standardized datetime utility
  if (fromDate || toDate) {
    try {
      // Use parseDateRange with no default (throws error if dates are invalid)
      const dateRange = parseDateRange(fromDate, toDate, 0)
      whereClause.createdAt = {
        gte: dateRange.from,
        lte: dateRange.to,
      }
    } catch (error) {
      throw new BadRequestError(`Invalid date range: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Handle staff filter (staffId maps to processedById in new schema)
  if (staffId) {
    // Check if the staff member exists in the venue
    const staffMember = await prisma.staff.findFirst({
      where: {
        id: staffId,
        venues: {
          some: {
            venueId: venueId,
          },
        },
      },
    })

    if (!staffMember) {
      logger.warn(`Staff member with ID ${staffId} not found for venue ${venueId}`)
      throw new NotFoundError(`Staff member with ID ${staffId} not found for this venue`)
    }

    whereClause.processedById = staffId
  }

  // Calculate pagination values
  const skip = (pageNumber - 1) * pageSize

  // Check total payments for venue for diagnostics
  const totalVenuePayments = await prisma.payment.count({
    where: { venueId },
  })

  // Execute the query with pagination
  const [payments, totalCount] = await prisma.$transaction([
    prisma.payment.findMany({
      where: whereClause,
      include: {
        processedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            total: true,
            table: true,
          },
        },
        // Include allocations for tip information
        allocations: {
          select: {
            id: true,
            amount: true,
            orderItem: {
              select: {
                id: true,
                product: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: pageSize,
    }),
    prisma.payment.count({
      where: whereClause,
    }),
  ])

  // Calculate pagination metadata
  const totalPages = Math.ceil(totalCount / pageSize)

  const response: PaginationResponse<Payment> = {
    data: payments,
    meta: {
      totalCount,
      pageSize,
      currentPage: pageNumber,
      totalPages,
      hasNextPage: pageNumber < totalPages,
      hasPrevPage: pageNumber > 1,
    },
  }

  // Add diagnostic information if no results
  if (totalCount === 0) {
    const diagnosticInfo: any = {
      venueExists: (await prisma.venue.findUnique({ where: { id: venueId } })) !== null,
      totalVenuePayments,
      filters: {
        dateRange: fromDate || toDate ? true : false,
        staffId: staffId ? true : false,
      },
    }

    // Try to get the most recent payment for this venue
    const latestPayment = await prisma.payment.findFirst({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, processedById: true },
    })

    if (latestPayment) {
      diagnosticInfo.latestPaymentDate = latestPayment.createdAt
    }

    response.meta.diagnostics = diagnosticInfo
  }

  return response
}

/**
 * Interface for payment creation data
 */
interface PaymentCreationData {
  venueId: string
  amount: number // Amount in cents
  tip: number // Tip in cents
  status: 'COMPLETED' | 'PENDING' | 'FAILED' | 'PROCESSING' | 'REFUNDED'
  method: 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'DIGITAL_WALLET'
  source: string
  splitType: 'PERPRODUCT' | 'EQUALPARTS' | 'CUSTOMAMOUNT' | 'FULLPAYMENT'
  tpvId: string
  staffId: string
  paidProductsId: string[]

  // Card payment fields
  cardBrand?: string
  last4?: string
  typeOfCard?: 'CREDIT' | 'DEBIT'
  currency: string
  bank?: string

  // Menta integration fields
  mentaAuthorizationReference?: string
  mentaOperationId?: string
  mentaTicketId?: string
  token?: string
  isInternational: boolean

  // Additional fields
  reviewRating?: string

  // Enhanced payment tracking fields (from new database migration)
  authorizationNumber?: string
  referenceNumber?: string
  maskedPan?: string
  entryMode?: string

  // ⭐ Provider-agnostic merchant account tracking (2025-01-10)
  merchantAccountId?: string // Primary: Structured merchant account ID
  blumonSerialNumber?: string // Legacy: Blumon-specific serial number (deprecated)

  // Split payment specific fields
  equalPartsPartySize?: number
  equalPartsPayedFor?: number

  // 🔧 PRE-payment verification fields (generated ONCE when entering verification screen)
  // orderReference ensures photos match order number (FAST-{timestamp} or ORD-{number})
  orderReference?: string

  // Firebase Storage URLs of verification photos (uploaded before payment)
  verificationPhotos?: string[]

  // Scanned barcodes from verification screen
  verificationBarcodes?: string[]

  // 💸 Blumon Operation Number (2025-12-16)
  // Small integer from SDK response (response.operation) needed for CancelIcc refunds
  // This allows refunds to work WITHOUT waiting for Blumon webhook
  // Example: 12945658 (fits in number, unlike the 12-digit referenceNumber string)
  blumonOperationNumber?: number

  // ⭐ Device Serial Number for Terminal attribution (2026-01-08)
  // Links payment to the Terminal that processed it (for device-based reporting)
  // This is the Terminal.serialNumber (e.g., "AVQD-2841548417"), NOT blumonSerialNumber
  deviceSerialNumber?: string
}

/**
 * ⭐ Helper: Resolve Blumon serial number to merchant account ID
 *
 * **Purpose:** Backward compatibility for old Android clients that send only `blumonSerialNumber`
 *
 * **Logic:**
 * 1. Find MerchantAccount where blumonSerialNumber matches
 * 2. Verify it's configured for the given venue
 * 3. Return merchant account ID or undefined
 *
 * **Example:**
 * ```typescript
 * const merchantId = await resolveBlumonSerialToMerchantId('venue_123', '2841548417')
 * // Returns: 'cuid_abc123' (MerchantAccount.id)
 * ```
 *
 * @param venueId Venue ID to scope the search
 * @param blumonSerialNumber Blumon serial number (e.g., "2841548417")
 * @returns MerchantAccount ID or undefined if not found
 */
async function resolveBlumonSerialToMerchantId(venueId: string, blumonSerialNumber: string): Promise<string | undefined> {
  try {
    // Find merchant account with matching blumonSerialNumber
    // that is configured for the given venue
    const merchant = await prisma.merchantAccount.findFirst({
      where: {
        blumonSerialNumber,
        OR: [
          { venueConfigsPrimary: { some: { venueId } } },
          { venueConfigsSecondary: { some: { venueId } } },
          { venueConfigsTertiary: { some: { venueId } } },
        ],
      },
    })

    if (merchant) {
      logger.info(`✅ Resolved blumonSerialNumber ${blumonSerialNumber} → merchantAccountId ${merchant.id}`)
      return merchant.id
    }

    logger.warn(`⚠️ Could not resolve blumonSerialNumber ${blumonSerialNumber} for venue ${venueId}`)
    return undefined
  } catch (error) {
    logger.error(`❌ Error resolving blumonSerialNumber ${blumonSerialNumber}:`, error)
    return undefined
  }
}

/**
 * ⭐ Helper: Resolve Terminal ID from device serial number
 *
 * **Purpose:** Auto-link payments/orders to the Terminal that processed them
 * using the device's unique serial number (e.g., "AVQD-2841548417")
 *
 * **Logic:**
 * 1. Find Terminal by serialNumber (unique field)
 * 2. Verify it belongs to the venue (security)
 * 3. Return terminal.id for foreign key assignment
 *
 * **Example:**
 * ```typescript
 * const terminalId = await resolveTerminalIdFromSerial('venue_123', 'AVQD-2841548417')
 * // Returns: 'cmhtgsr3100gi9k1we6pyr777' (Terminal.id)
 * ```
 *
 * @param venueId Venue ID to validate ownership
 * @param deviceSerialNumber Terminal serial number (e.g., "AVQD-2841548417")
 * @returns Terminal ID or null if not found
 */
async function resolveTerminalIdFromSerial(venueId: string, deviceSerialNumber: string): Promise<string | null> {
  try {
    const terminal = await prisma.terminal.findFirst({
      where: {
        serialNumber: deviceSerialNumber,
        venueId, // Security: ensure terminal belongs to this venue
      },
      select: { id: true },
    })

    if (terminal) {
      logger.debug(`✅ Resolved deviceSerialNumber ${deviceSerialNumber} → terminalId ${terminal.id}`)
      return terminal.id
    }

    logger.warn(`⚠️ Could not resolve deviceSerialNumber ${deviceSerialNumber} for venue ${venueId}`)
    return null
  } catch (error) {
    logger.error(`❌ Error resolving deviceSerialNumber ${deviceSerialNumber}:`, error)
    return null
  }
}

/**
 * Record a payment for a specific order
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param paymentData Payment creation data
 * @param userId User ID who processed the payment
 * @param orgId Organization ID
 * @returns Created payment with order information
 */
export async function recordOrderPayment(
  venueId: string,
  orderId: string,
  paymentData: PaymentCreationData,
  userId?: string,
  _orgId?: string,
) {
  logger.info('Recording order payment', { venueId, orderId, splitType: paymentData.splitType })

  // ⭐ IDEMPOTENCY CHECK: Prevent duplicate payments using Blumon referenceNumber
  // This allows safe retries from offline queue without creating duplicate payments
  if (paymentData.referenceNumber) {
    const existingPayment = await prisma.payment.findFirst({
      where: {
        venueId,
        referenceNumber: paymentData.referenceNumber,
      },
      include: {
        receipts: true, // Include receipt data for idempotent response
      },
    })

    if (existingPayment) {
      logger.warn('🔄 Duplicate payment attempt detected (idempotency check)', {
        venueId,
        orderId,
        referenceNumber: paymentData.referenceNumber,
        existingPaymentId: existingPayment.id,
        message: 'Returning existing payment (safe retry from offline queue)',
      })

      // Return existing payment with receipt (safe retry - client gets same response)
      return {
        ...existingPayment,
        digitalReceipt: existingPayment.receipts[0] || null,
      }
    }
  }

  // Find the order directly by ID (include payments for pre-flight validation)
  const activeOrder = await prisma.order.findUnique({
    where: {
      id: orderId,
      venueId,
    },
    include: {
      items: {
        include: {
          product: true, // Need product.name for validation errors
          // ✅ Include paymentAllocations to filter out paid items in PRE-FLIGHT
          paymentAllocations: true,
          // ✅ Include modifiers with inventory fields for pre-flight validation
          modifiers: {
            include: {
              modifier: {
                select: {
                  id: true,
                  name: true,
                  groupId: true,
                  rawMaterialId: true,
                  quantityPerUnit: true,
                  unit: true,
                  inventoryMode: true,
                },
              },
            },
          },
        },
      },
      venue: true,
      payments: {
        where: { status: 'COMPLETED' }, // Only count completed payments
        select: { amount: true, tipAmount: true },
      },
    },
  })

  if (!activeOrder) {
    throw new NotFoundError(`Order ${orderId} not found in venue ${venueId}`)
  }

  // Validate splitType business logic
  if (activeOrder.splitType && activeOrder.splitType !== paymentData.splitType) {
    // Define allowed transitions based on business rules
    const allowedTransitions = {
      PERPRODUCT: ['PERPRODUCT', 'FULLPAYMENT'], // Can only continue with same method or pay full
      EQUALPARTS: ['EQUALPARTS', 'FULLPAYMENT'], // Can only continue with same method or pay full
      CUSTOMAMOUNT: ['PERPRODUCT', 'EQUALPARTS', 'CUSTOMAMOUNT', 'FULLPAYMENT'], // Can use any method
      FULLPAYMENT: ['FULLPAYMENT'], // Only full payment allowed (order should be completed)
    }

    const allowedMethods = allowedTransitions[activeOrder.splitType] || []

    if (!allowedMethods.includes(paymentData.splitType)) {
      throw new BadRequestError(
        `Order has splitType ${activeOrder.splitType}. Cannot use ${paymentData.splitType}. Allowed methods: ${allowedMethods.join(', ')}`,
      )
    }
  }

  // Convert amounts from cents to decimal (Prisma expects Decimal)
  const totalAmount = paymentData.amount / 100
  const tipAmount = paymentData.tip / 100

  // ✅ WORLD-CLASS PATTERN: Pre-flight validation BEFORE creating payment record (Stripe, Shopify, Toast POS)
  // Validate inventory availability to prevent charging customers for orders we can't fulfill
  await validatePreFlightInventory(activeOrder, totalAmount + tipAmount)

  // ✅ CORRECTED: Use validateStaffVenue helper for proper staffId validation
  const validatedStaffId = await validateStaffVenue(paymentData.staffId, venueId, userId)

  // ✅ CORRECTED: Find current open shift for THIS STAFF MEMBER (not just any shift)
  // CRITICAL: If multiple staff members have open shifts simultaneously,
  // we must match the payment to the correct staff's shift
  const currentShift = await prisma.shift.findFirst({
    where: {
      venueId,
      staffId: validatedStaffId, // ← FIX: Filter by staff member who made the payment
      status: 'OPEN',
      endTime: null,
    },
    orderBy: {
      startTime: 'desc',
    },
  })

  // ⭐ PROVIDER-AGNOSTIC MERCHANT TRACKING: Resolve merchantAccountId
  // Priority 1: Use merchantAccountId if provided by modern Android client
  // Priority 2: Resolve blumonSerialNumber → merchantAccountId for backward compatibility
  // Priority 3: Leave undefined (legacy payments before this feature)
  let merchantAccountId = paymentData.merchantAccountId

  if (!merchantAccountId && paymentData.blumonSerialNumber) {
    logger.info(`🔄 Resolving legacy blumonSerialNumber: ${paymentData.blumonSerialNumber}`)
    merchantAccountId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
  }

  if (merchantAccountId) {
    logger.info(`✅ Payment will be attributed to merchantAccountId: ${merchantAccountId}`)
  } else {
    logger.warn(`⚠️ No merchantAccountId - payment will have null merchant (legacy mode)`)
  }

  // ⭐ 3-TIER MERCHANT RESOLUTION (Stripe-inspired pattern)
  // TIER 1: Direct Attribution - Use provided merchantAccountId if valid + active
  // TIER 2: Inference Recovery - Infer from blumonSerialNumber (SOURCE OF TRUTH from processor)
  // TIER 3: Reconciliation Flag - Null with full context for manual resolution
  if (merchantAccountId) {
    const merchantExists = await prisma.merchantAccount.findUnique({
      where: { id: merchantAccountId },
      select: { id: true, active: true },
    })

    if (!merchantExists) {
      logger.error(`❌ MerchantAccount not found: ${merchantAccountId}`, {
        venueId,
        orderId,
        paymentMethod: paymentData.method,
        providedId: merchantAccountId,
        blumonSerialNumber: paymentData.blumonSerialNumber,
        hint: 'Android may have stale config. Attempting TIER 2 recovery from blumonSerialNumber.',
      })

      // TIER 2: Attempt recovery from blumonSerialNumber (the actual serial Blumon used)
      if (paymentData.blumonSerialNumber) {
        const recoveredMerchantId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
        if (recoveredMerchantId) {
          logger.info(`✅ TIER 2 Recovery SUCCESS: Inferred merchant from blumonSerialNumber`, {
            providedMerchantId: merchantAccountId,
            blumonSerialNumber: paymentData.blumonSerialNumber,
            recoveredMerchantId,
          })
          merchantAccountId = recoveredMerchantId
        } else {
          // TIER 3: Cannot resolve - flag for reconciliation
          logger.error(`❌ TIER 3: Cannot resolve merchant - reconciliation required`, {
            providedMerchantId: merchantAccountId,
            blumonSerialNumber: paymentData.blumonSerialNumber,
            authorizationNumber: paymentData.authorizationNumber,
            referenceNumber: paymentData.referenceNumber,
            venueId,
            orderId,
          })
          merchantAccountId = undefined
        }
      } else {
        // No blumonSerialNumber for recovery - fall back to null
        logger.warn(`⚠️ No blumonSerialNumber for TIER 2 recovery - falling back to null`)
        merchantAccountId = undefined
      }
    } else if (!merchantExists.active) {
      logger.warn(`⚠️ MerchantAccount ${merchantAccountId} is inactive`, {
        venueId,
        orderId,
        paymentMethod: paymentData.method,
        blumonSerialNumber: paymentData.blumonSerialNumber,
      })

      // TIER 2: Attempt recovery for inactive merchant (find another active one with same serial)
      if (paymentData.blumonSerialNumber) {
        const recoveredMerchantId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
        if (recoveredMerchantId && recoveredMerchantId !== merchantAccountId) {
          logger.info(`✅ TIER 2 Recovery: Found active merchant with same serial`, {
            inactiveMerchantId: merchantAccountId,
            blumonSerialNumber: paymentData.blumonSerialNumber,
            recoveredMerchantId,
          })
          merchantAccountId = recoveredMerchantId
        } else {
          merchantAccountId = undefined
        }
      } else {
        merchantAccountId = undefined
      }
    }
  }

  // ⭐ TERMINAL ATTRIBUTION: Resolve terminalId from device serial number
  // Links payment to the Terminal that processed it (for device-based reporting)
  let terminalId: string | null = null
  if (paymentData.deviceSerialNumber) {
    terminalId = await resolveTerminalIdFromSerial(venueId, paymentData.deviceSerialNumber)
  }

  // ⭐ ATOMICITY: Wrap critical payment creation in transaction (all or nothing)
  // This prevents orphaned records if any operation fails
  const payment = await prisma.$transaction(async tx => {
    // Create the payment record
    const newPayment = await tx.payment.create({
      data: {
        venueId,
        orderId: activeOrder.id,
        amount: totalAmount,
        tipAmount,
        method: paymentData.method as PaymentMethod, // Cast to PaymentMethod enum
        status: paymentData.status as any, // Direct enum mapping since frontend sends correct values
        splitType: paymentData.splitType as SplitType, // Cast to SplitType enum
        source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
        processor: 'TBD',
        processorId: paymentData.mentaOperationId,
        processorData: {
          cardBrand: paymentData.cardBrand,
          last4: paymentData.last4,
          typeOfCard: paymentData.typeOfCard,
          bank: paymentData.bank,
          currency: paymentData.currency,
          mentaAuthorizationReference: paymentData.mentaAuthorizationReference,
          mentaTicketId: paymentData.mentaTicketId,
          isInternational: paymentData.isInternational,
          // ⭐ Blumon serial for reconciliation (matches dashboard de Blumon)
          blumonSerialNumber: paymentData.blumonSerialNumber || null,
          // 💸 Blumon Operation Number (2025-12-16) - For CancelIcc refunds without webhook
          blumonOperationNumber: paymentData.blumonOperationNumber || null,
        },
        // New enhanced fields in the Payment table
        authorizationNumber: paymentData.authorizationNumber,
        referenceNumber: paymentData.referenceNumber,
        maskedPan: paymentData.maskedPan,
        cardBrand: paymentData.cardBrand ? (paymentData.cardBrand.toUpperCase().replace(' ', '_') as any) : null,
        entryMode: paymentData.entryMode ? (paymentData.entryMode.toUpperCase() as any) : null,
        // ⭐ Provider-agnostic merchant account tracking
        merchantAccountId,
        // ⭐ Terminal that processed this payment (resolved from deviceSerialNumber)
        terminalId,
        processedById: validatedStaffId, // ✅ CORRECTED: Use validated staff ID
        shiftId: currentShift?.id,
        feePercentage: 0, // TODO: Calculate based on payment processor
        feeAmount: 0, // TODO: Calculate based on amount and percentage
        netAmount: totalAmount + tipAmount, // For now, net amount = total
        posRawData: {
          splitType: paymentData.splitType,
          staffId: paymentData.staffId, // ✅ CORRECTED: Use staffId field name consistently
          source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
          paidProductsId: paymentData.paidProductsId || [],
          ...(paymentData.equalPartsPartySize && { equalPartsPartySize: paymentData.equalPartsPartySize }),
          ...(paymentData.equalPartsPayedFor && { equalPartsPayedFor: paymentData.equalPartsPayedFor }),
          ...(paymentData.reviewRating && { reviewRating: paymentData.reviewRating }),
        },
      },
      include: {
        order: {
          include: {
            items: true,
            venue: true,
          },
        },
        processedBy: true,
      },
    })

    // Create VenueTransaction for financial tracking and settlement
    await tx.venueTransaction.create({
      data: {
        venueId,
        paymentId: newPayment.id,
        type: 'PAYMENT',
        grossAmount: totalAmount + tipAmount,
        feeAmount: newPayment.feeAmount,
        netAmount: newPayment.netAmount,
        status: 'PENDING', // Will be updated to SETTLED by settlement process
      },
    })

    // Update Order.splitType if this is the first payment
    if (!activeOrder.splitType) {
      await tx.order.update({
        where: { id: activeOrder.id },
        data: { splitType: paymentData.splitType as any },
      })
    }

    // Handle split payment allocations based on splitType
    if (paymentData.splitType === 'PERPRODUCT' && paymentData.paidProductsId.length > 0) {
      // Create allocations for specific products
      const orderItems = activeOrder.items.filter((item: any) => paymentData.paidProductsId.includes(item.id))

      for (const item of orderItems) {
        await tx.paymentAllocation.create({
          data: {
            paymentId: newPayment.id,
            orderItemId: item.id,
            orderId: activeOrder.id,
            amount: item.total, // Allocate the full item amount
          },
        })
      }
    } else {
      // For other split types, create a general allocation to the order
      await tx.paymentAllocation.create({
        data: {
          paymentId: newPayment.id,
          orderId: activeOrder.id,
          amount: totalAmount,
        },
      })
    }

    // ✅ UPDATE SHIFT TOTALS: Increment shift sales and tips when payment is recorded
    if (currentShift) {
      await tx.shift.update({
        where: { id: currentShift.id },
        data: {
          totalSales: {
            increment: totalAmount,
          },
          totalTips: {
            increment: tipAmount,
          },
          totalOrders: {
            increment: 1,
          },
        },
      })
      logger.info('✅ Shift totals updated', {
        shiftId: currentShift.id,
        incrementedSales: totalAmount,
        incrementedTips: tipAmount,
      })
    }

    return newPayment
  })

  logger.info('VenueTransaction created for payment', {
    paymentId: payment.id,
    grossAmount: totalAmount + tipAmount,
    feeAmount: payment.feeAmount,
    netAmount: payment.netAmount,
  })

  // Create TransactionCost for financial tracking (only for Avoqado-processed non-cash payments)
  try {
    const costResult = await createTransactionCost(payment.id)

    // Update Payment and VenueTransaction with calculated fee values
    if (costResult && costResult.feeAmount > 0) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          feeAmount: costResult.feeAmount,
          netAmount: costResult.netAmount,
        },
      })

      await prisma.venueTransaction.update({
        where: { paymentId: payment.id },
        data: {
          feeAmount: costResult.feeAmount,
          netAmount: costResult.netAmount,
          netSettlementAmount: costResult.netAmount,
        },
      })

      logger.info('Payment and VenueTransaction updated with fee values', {
        paymentId: payment.id,
        feeAmount: costResult.feeAmount,
        netAmount: costResult.netAmount,
      })
    }
  } catch (transactionCostError) {
    logger.error('Failed to create TransactionCost', {
      paymentId: payment.id,
      error: transactionCostError,
    })
    // Don't fail the payment if TransactionCost creation fails
  }

  // Create Review record if reviewRating is provided
  if (paymentData.reviewRating) {
    try {
      const rating = mapTpvRatingToNumeric(paymentData.reviewRating)
      if (rating !== null) {
        await prisma.review.create({
          data: {
            venueId: activeOrder.venueId,
            paymentId: payment.id,
            overallRating: rating,
            source: 'TPV',
            servedById: paymentData.staffId, // Link to the staff who served
          },
        })
        logger.info('Review created successfully', { paymentId: payment.id, rating, originalRating: paymentData.reviewRating })
      } else {
        logger.warn('Invalid review rating provided', { paymentId: payment.id, rating: paymentData.reviewRating })
      }
    } catch (error) {
      logger.error('Failed to create review', { paymentId: payment.id, error })
      // Don't fail the payment if review creation fails
    }
  }

  // Generate digital receipt for TPV payments (AVOQADO origin)
  let digitalReceipt = null
  try {
    digitalReceipt = await generateDigitalReceipt(payment.id)
    logger.info('Digital receipt generated for payment', {
      paymentId: payment.id,
      receiptId: digitalReceipt.id,
      accessKey: digitalReceipt.accessKey,
    })
  } catch (error) {
    logger.error('Failed to generate digital receipt', { paymentId: payment.id, error })
    // Don't fail the payment if receipt generation fails
  }

  // 🔌 REAL-TIME: Emit socket events based on payment status
  try {
    const paymentPayload = {
      paymentId: payment.id,
      orderId: activeOrder.id,
      orderNumber: activeOrder.orderNumber,
      venueId: activeOrder.venueId,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      method: payment.method,
      status: payment.status.toLowerCase(), // Convert to lowercase for Android compatibility
      timestamp: new Date().toISOString(),
      tableId: activeOrder.tableId,
      metadata: {
        cardBrand: paymentData.cardBrand,
        last4: paymentData.last4,
      },
    }

    // Emit appropriate event based on payment status
    if (payment.status === 'COMPLETED') {
      socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.PAYMENT_COMPLETED, paymentPayload)
      logger.info('🔌 PAYMENT_COMPLETED event emitted', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        amount: payment.amount,
      })

      // Create commission calculation for this payment (non-blocking)
      if (payment.type !== 'TEST') {
        createCommissionForPayment(payment.id).catch(err => {
          logger.error('Failed to create commission for payment', {
            paymentId: payment.id,
            orderId: activeOrder.id,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    } else if (payment.status === 'PROCESSING') {
      socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.PAYMENT_PROCESSING, paymentPayload)
      logger.info('🔌 PAYMENT_PROCESSING event emitted', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        amount: payment.amount,
      })
    } else if (payment.status === 'FAILED') {
      socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.PAYMENT_FAILED, {
        ...paymentPayload,
        errorMessage: 'Payment failed during processing',
      })
      logger.warn('🔌 PAYMENT_FAILED event emitted', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        amount: payment.amount,
      })
    }

    // Emit order updated event to venue room
    socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.ORDER_UPDATED, {
      orderId: activeOrder.id,
      orderNumber: activeOrder.orderNumber,
      venueId: activeOrder.venueId,
      status: activeOrder.status,
      paymentStatus: activeOrder.paymentStatus,
      timestamp: new Date().toISOString(),
    })

    logger.info('Socket events emitted successfully', {
      paymentId: payment.id,
      orderId: activeOrder.id,
      orderNumber: activeOrder.orderNumber,
      venueId: activeOrder.venueId,
      paymentStatus: payment.status,
    })
  } catch (error) {
    logger.error('Failed to emit socket events', {
      paymentId: payment.id,
      orderId: activeOrder.id,
      error,
    })
    // Don't fail the payment if socket emission fails
  }

  // ✅ NUEVO: Detectar modo de operación y manejar pago según el contexto
  const isIntegratedMode = activeOrder.source === OrderSource.POS && activeOrder.externalId && activeOrder.externalId.trim() !== ''

  logger.info('Payment processing mode detected', {
    paymentId: payment.id,
    orderId: activeOrder.id,
    isIntegratedMode,
    orderSource: activeOrder.source,
    hasExternalId: !!activeOrder.externalId,
  })

  if (isIntegratedMode) {
    // MODO INTEGRADO: Enviar comando a POS, POS maneja los totales
    try {
      const isPartialPayment = totalAmount + tipAmount < parseFloat(activeOrder.total.toString())

      await publishCommand(`command.softrestaurant.${venueId}`, {
        entity: 'Payment',
        action: 'APPLY',
        payload: {
          orderExternalId: activeOrder.externalId,
          paymentData: {
            amount: totalAmount,
            tip: tipAmount,
            posPaymentMethodId: mapPaymentMethodToPOS(paymentData.method),
            reference: paymentData.mentaOperationId || paymentData.authorizationNumber || '',
            isPartial: isPartialPayment,
          },
        },
      })

      // Track this payment command to prevent double deduction when POS sends back order.updated
      if (activeOrder.externalId) {
        trackRecentPaymentCommand(activeOrder.externalId, totalAmount + tipAmount)
      }

      logger.info('Payment command sent to POS (Integrated Mode)', {
        paymentId: payment.id,
        orderExternalId: activeOrder.externalId,
        isPartial: isPartialPayment,
      })
    } catch (rabbitMQError) {
      logger.error('Failed to send payment command to POS', {
        paymentId: payment.id,
        error: rabbitMQError,
      })
      // No fallar el pago si RabbitMQ falla
    }
  } else {
    // MODO AUTÓNOMO: Backend maneja los totales directamente
    try {
      // ✅ FIX: Pass payment ID to exclude it from previousPayments calculation
      // ⭐ LOYALTY: Pass staffId for loyalty points attribution
      // ✅ FIX: Pass tipAmount separately to update order.tipAmount
      await updateOrderTotalsForStandalonePayment(activeOrder.id, totalAmount + tipAmount, tipAmount, payment.id, validatedStaffId)

      logger.info('Order totals updated directly in backend (Standalone Mode)', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        paymentAmount: totalAmount + tipAmount,
      })
    } catch (updateError: any) {
      // ✅ WORLD-CLASS PATTERN: Re-throw business validation errors (Stripe/Shopify/Toast pattern)
      // Validation errors (insufficient inventory, etc.) should FAIL the payment
      // Infrastructure errors (network, DB) can be logged but don't fail the payment
      if (updateError instanceof BadRequestError || updateError instanceof NotFoundError) {
        logger.error('❌ Payment rejected: Business validation failed', {
          paymentId: payment.id,
          orderId: activeOrder.id,
          error: updateError.message,
          reason: 'VALIDATION_ERROR',
        })
        throw updateError // Re-throw to fail the payment
      }

      logger.error('Failed to update order totals in standalone mode', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        error: updateError,
      })
      // Continue execution - payment is still recorded even if total update fails (infrastructure error only)
    }
  }

  logger.info('Payment recorded successfully', { paymentId: payment.id, amount: totalAmount })

  // Add digital receipt info to payment response
  return {
    ...payment,
    digitalReceipt: digitalReceipt
      ? {
          id: digitalReceipt.id,
          accessKey: digitalReceipt.accessKey,
          receiptUrl: `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/receipts/public/${digitalReceipt.accessKey}`,
        }
      : null,
  }
}

/**
 * Record a fast payment (without specific table association)
 * @param venueId Venue ID
 * @param paymentData Payment creation data
 * @param userId User ID who processed the payment
 * @param orgId Organization ID
 * @returns Created payment
 */
export async function recordFastPayment(venueId: string, paymentData: PaymentCreationData, userId?: string, _orgId?: string) {
  logger.info('Recording fast payment', { venueId, amount: paymentData.amount, paymentData })

  // ⭐ IDEMPOTENCY CHECK: Prevent duplicate payments using Blumon referenceNumber
  // This allows safe retries from offline queue without creating duplicate payments
  if (paymentData.referenceNumber) {
    const existingPayment = await prisma.payment.findFirst({
      where: {
        venueId,
        referenceNumber: paymentData.referenceNumber,
      },
      include: {
        receipts: true, // Include receipt data for idempotent response
      },
    })

    if (existingPayment) {
      logger.warn('🔄 Duplicate payment attempt detected (idempotency check)', {
        venueId,
        referenceNumber: paymentData.referenceNumber,
        existingPaymentId: existingPayment.id,
        message: 'Returning existing payment (safe retry from offline queue)',
      })

      // Return existing payment with receipt (safe retry - client gets same response)
      return {
        ...existingPayment,
        digitalReceipt: existingPayment.receipts[0] || null,
      }
    }
  }

  // Convert amounts from cents to decimal (Prisma expects Decimal)
  const totalAmount = paymentData.amount / 100
  const tipAmount = paymentData.tip / 100

  // ✅ CORRECTED: Use validateStaffVenue helper for proper staffId validation
  const validatedStaffId = await validateStaffVenue(paymentData.staffId, venueId, userId)

  // ✅ CORRECTED: Find current open shift for THIS STAFF MEMBER (not just any shift)
  // CRITICAL: If multiple staff members have open shifts simultaneously,
  // we must match the payment to the correct staff's shift
  const currentShift = await prisma.shift.findFirst({
    where: {
      venueId,
      staffId: validatedStaffId, // ← FIX: Filter by staff member who made the payment
      status: 'OPEN',
      endTime: null,
    },
    orderBy: {
      startTime: 'desc',
    },
  })

  // Map source from Android app format to PaymentSource enum
  const mapPaymentSource = (source?: string): PaymentSource => {
    if (!source) return 'OTHER'
    // Map "AVOQADO_TPV" from Android app to "TPV" enum value
    if (source === 'AVOQADO_TPV') return 'TPV'
    // Check if it's a valid PaymentSource enum value
    const validSources = ['TPV', 'DASHBOARD_TEST', 'QR', 'WEB', 'APP', 'PHONE', 'POS', 'OTHER']
    return validSources.includes(source) ? (source as PaymentSource) : 'OTHER'
  }

  // ⭐ PROVIDER-AGNOSTIC MERCHANT TRACKING: Resolve merchantAccountId
  // Priority 1: Use merchantAccountId if provided by modern Android client
  // Priority 2: Resolve blumonSerialNumber → merchantAccountId for backward compatibility
  // Priority 3: Leave undefined (legacy payments before this feature)
  let merchantAccountId = paymentData.merchantAccountId

  if (!merchantAccountId && paymentData.blumonSerialNumber) {
    logger.info(`🔄 Resolving legacy blumonSerialNumber: ${paymentData.blumonSerialNumber}`)
    merchantAccountId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
  }

  if (merchantAccountId) {
    logger.info(`✅ Payment will be attributed to merchantAccountId: ${merchantAccountId}`)
  } else {
    logger.warn(`⚠️ No merchantAccountId - payment will have null merchant (legacy mode)`)
  }

  // ⭐ 3-TIER MERCHANT RESOLUTION (Stripe-inspired pattern) - Fast Payments
  // TIER 1: Direct Attribution - Use provided merchantAccountId if valid + active
  // TIER 2: Inference Recovery - Infer from blumonSerialNumber (SOURCE OF TRUTH from processor)
  // TIER 3: Reconciliation Flag - Null with full context for manual resolution
  if (merchantAccountId) {
    const merchantExists = await prisma.merchantAccount.findUnique({
      where: { id: merchantAccountId },
      select: { id: true, active: true },
    })

    if (!merchantExists) {
      logger.error(`❌ [FastPayment] MerchantAccount not found: ${merchantAccountId}`, {
        venueId,
        paymentMethod: paymentData.method,
        providedId: merchantAccountId,
        blumonSerialNumber: paymentData.blumonSerialNumber,
        hint: 'Android may have stale config. Attempting TIER 2 recovery from blumonSerialNumber.',
      })

      // TIER 2: Attempt recovery from blumonSerialNumber
      if (paymentData.blumonSerialNumber) {
        const recoveredMerchantId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
        if (recoveredMerchantId) {
          logger.info(`✅ [FastPayment] TIER 2 Recovery SUCCESS: Inferred merchant from blumonSerialNumber`, {
            providedMerchantId: merchantAccountId,
            blumonSerialNumber: paymentData.blumonSerialNumber,
            recoveredMerchantId,
          })
          merchantAccountId = recoveredMerchantId
        } else {
          logger.error(`❌ [FastPayment] TIER 3: Cannot resolve merchant - reconciliation required`, {
            providedMerchantId: merchantAccountId,
            blumonSerialNumber: paymentData.blumonSerialNumber,
            authorizationNumber: paymentData.authorizationNumber,
            referenceNumber: paymentData.referenceNumber,
            venueId,
          })
          merchantAccountId = undefined
        }
      } else {
        logger.warn(`⚠️ [FastPayment] No blumonSerialNumber for TIER 2 recovery - falling back to null`)
        merchantAccountId = undefined
      }
    } else if (!merchantExists.active) {
      logger.warn(`⚠️ [FastPayment] MerchantAccount ${merchantAccountId} is inactive`, {
        venueId,
        paymentMethod: paymentData.method,
        blumonSerialNumber: paymentData.blumonSerialNumber,
      })

      // TIER 2: Attempt recovery for inactive merchant
      if (paymentData.blumonSerialNumber) {
        const recoveredMerchantId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
        if (recoveredMerchantId && recoveredMerchantId !== merchantAccountId) {
          logger.info(`✅ [FastPayment] TIER 2 Recovery: Found active merchant with same serial`, {
            inactiveMerchantId: merchantAccountId,
            blumonSerialNumber: paymentData.blumonSerialNumber,
            recoveredMerchantId,
          })
          merchantAccountId = recoveredMerchantId
        } else {
          merchantAccountId = undefined
        }
      } else {
        merchantAccountId = undefined
      }
    }
  }

  // ⭐ TERMINAL ATTRIBUTION: Resolve terminalId from device serial number
  // Links order and payment to the Terminal that processed them (for device-based reporting)
  let terminalId: string | null = null
  if (paymentData.deviceSerialNumber) {
    terminalId = await resolveTerminalIdFromSerial(venueId, paymentData.deviceSerialNumber)
  }

  // ⭐ ATOMICITY: Wrap critical fast payment creation in transaction (all or nothing)
  // This prevents orphaned records if any operation fails
  const { payment, fastOrder } = await prisma.$transaction(async tx => {
    // 🔧 FIX: Use orderReference from Android if provided (ensures photos match order number)
    // Android generates "FAST-{timestamp}" ONCE when entering VerifyingPrePayment state
    // Photos are uploaded to Firebase with this same reference
    // This ensures photos at "venues/X/verifications/2024-01-01/FAST-123456_1.jpg" match the order
    const orderNumber = paymentData.orderReference || `FAST-${Date.now()}`

    // Create fast order
    const order = await tx.order.create({
      data: {
        venueId,
        orderNumber,
        type: 'TAKEOUT', // Fast payments are typically quick sales (para llevar)
        source: 'TPV',
        // ⭐ Terminal that created this order (resolved from deviceSerialNumber)
        terminalId,
        status: 'COMPLETED', // Fast payments are instantly paid, so order is completed
        completedAt: new Date(),
        subtotal: totalAmount, // Base amount (without tip)
        taxAmount: 0, // No tax for fast payments
        total: totalAmount + tipAmount, // ✅ FIX: Total = subtotal + tax + tip
        // ✅ FIX: Include tip and paid amounts for fast orders
        tipAmount, // Tip amount from this payment
        paidAmount: totalAmount + tipAmount, // Total paid (base + tip)
        remainingBalance: 0, // Fast payments are always fully paid
        paymentStatus: 'PAID',
        splitType: paymentData.splitType as any, // Set splitType for fast orders
        createdById: validatedStaffId, // Track which staff created the fast order
        servedById: validatedStaffId, // ⭐ KIOSK MODE FIX: Also set server to payment processor
      },
    })

    // Create the fast payment record
    const newPayment = await tx.payment.create({
      data: {
        venueId,
        orderId: order.id, // Fast payment - no order association
        amount: totalAmount,
        tipAmount,
        method: paymentData.method as PaymentMethod, // Cast to PaymentMethod enum
        status: paymentData.status as any, // Direct enum mapping since frontend sends correct values
        splitType: 'FULLPAYMENT' as SplitType, // Fast payments are always full payments
        source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
        processor: 'TBD',
        type: 'FAST',
        processorId: paymentData.mentaOperationId,
        processorData: {
          cardBrand: paymentData.cardBrand,
          last4: paymentData.last4,
          typeOfCard: paymentData.typeOfCard,
          bank: paymentData.bank,
          currency: paymentData.currency,
          authorizationNumber: paymentData.authorizationNumber,
          referenceNumber: paymentData.referenceNumber,
          isInternational: paymentData.isInternational,
          // ⭐ Blumon serial for reconciliation (matches dashboard de Blumon)
          blumonSerialNumber: paymentData.blumonSerialNumber || null,
          // 💸 Blumon Operation Number (2025-12-16) - For CancelIcc refunds without webhook
          blumonOperationNumber: paymentData.blumonOperationNumber || null,
        },
        // New enhanced fields in the Payment table
        authorizationNumber: paymentData.authorizationNumber,
        referenceNumber: paymentData.referenceNumber,
        maskedPan: paymentData.maskedPan,
        cardBrand: paymentData.cardBrand ? (paymentData.cardBrand.toUpperCase().replace(' ', '_') as any) : null,
        entryMode: paymentData.entryMode ? (paymentData.entryMode.toUpperCase() as any) : null,
        // ⭐ Provider-agnostic merchant account tracking
        merchantAccountId,
        // ⭐ Terminal that processed this payment (resolved from deviceSerialNumber)
        terminalId,
        processedById: validatedStaffId, // ✅ CORRECTED: Use validated staff ID
        shiftId: currentShift?.id,
        feePercentage: 0, // TODO: Calculate based on payment processor
        feeAmount: 0, // TODO: Calculate based on amount and percentage
        netAmount: totalAmount + tipAmount, // For now, net amount = total
        posRawData: {
          splitType: 'FULLPAYMENT',
          staffId: paymentData.staffId, // ✅ CORRECTED: Use staffId field name consistently
          source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
          paymentType: 'FAST',
          ...(paymentData.reviewRating && { reviewRating: paymentData.reviewRating }),
        },
      },
      include: {
        processedBy: true,
      },
    })

    // Create VenueTransaction for financial tracking and settlement
    await tx.venueTransaction.create({
      data: {
        venueId,
        paymentId: newPayment.id,
        type: 'PAYMENT',
        grossAmount: totalAmount + tipAmount,
        feeAmount: newPayment.feeAmount,
        netAmount: newPayment.netAmount,
        status: 'PENDING', // Will be updated to SETTLED by settlement process
      },
    })

    // Create a general allocation for the fast payment
    await tx.paymentAllocation.create({
      data: {
        paymentId: newPayment.id,
        orderId: order.id,
        amount: totalAmount,
      },
    })

    // ✅ UPDATE SHIFT TOTALS: Increment shift sales and tips when fast payment is recorded
    if (currentShift) {
      await tx.shift.update({
        where: { id: currentShift.id },
        data: {
          totalSales: {
            increment: totalAmount,
          },
          totalTips: {
            increment: tipAmount,
          },
          totalOrders: {
            increment: 1,
          },
        },
      })
      logger.info('✅ Shift totals updated (fast payment)', {
        shiftId: currentShift.id,
        incrementedSales: totalAmount,
        incrementedTips: tipAmount,
      })
    }

    // 📸 Create SaleVerification if verification photos or barcodes were provided
    // This links the pre-uploaded Firebase photos to the payment record
    if (
      validatedStaffId &&
      ((paymentData.verificationPhotos && paymentData.verificationPhotos.length > 0) ||
        (paymentData.verificationBarcodes && paymentData.verificationBarcodes.length > 0))
    ) {
      await tx.saleVerification.create({
        data: {
          venueId,
          paymentId: newPayment.id,
          staffId: validatedStaffId,
          photos: paymentData.verificationPhotos || [],
          scannedProducts: paymentData.verificationBarcodes
            ? paymentData.verificationBarcodes.map((barcode: string) => ({
                barcode,
                format: 'UNKNOWN',
                inventoryDeducted: false,
              }))
            : [],
          status: 'PENDING', // Will be processed for inventory deduction later
        },
      })
      logger.info('📸 SaleVerification created for fast payment', {
        paymentId: newPayment.id,
        photosCount: paymentData.verificationPhotos?.length || 0,
        barcodesCount: paymentData.verificationBarcodes?.length || 0,
      })
    }

    return { payment: newPayment, fastOrder: order }
  })

  logger.info('VenueTransaction created for fast payment', {
    paymentId: payment.id,
    grossAmount: totalAmount + tipAmount,
    feeAmount: payment.feeAmount,
    netAmount: payment.netAmount,
  })

  // Create TransactionCost for financial tracking (only for Avoqado-processed non-cash payments)
  try {
    await createTransactionCost(payment.id)
  } catch (transactionCostError) {
    logger.error('Failed to create TransactionCost for fast payment', {
      paymentId: payment.id,
      error: transactionCostError,
    })
    // Don't fail the payment if TransactionCost creation fails
  }

  // Create Review record if reviewRating is provided
  if (paymentData.reviewRating) {
    try {
      const rating = mapTpvRatingToNumeric(paymentData.reviewRating)
      if (rating !== null) {
        await prisma.review.create({
          data: {
            venueId: venueId,
            paymentId: payment.id,
            overallRating: rating,
            source: 'TPV',
            servedById: paymentData.staffId, // Link to the staff who served
          },
        })
        logger.info('Review created successfully for fast payment', {
          paymentId: payment.id,
          rating,
          originalRating: paymentData.reviewRating,
        })
      } else {
        logger.warn('Invalid review rating provided for fast payment', { paymentId: payment.id, rating: paymentData.reviewRating })
      }
    } catch (error) {
      logger.error('Failed to create review for fast payment', { paymentId: payment.id, error })
      // Don't fail the payment if review creation fails
    }
  }

  // Generate digital receipt for fast TPV payments (AVOQADO origin)
  let digitalReceipt = null
  try {
    digitalReceipt = await generateDigitalReceipt(payment.id)
    logger.info('Digital receipt generated for fast payment', {
      paymentId: payment.id,
      receiptId: digitalReceipt.id,
      accessKey: digitalReceipt.accessKey,
    })
  } catch (error) {
    logger.error('Failed to generate digital receipt for fast payment', { paymentId: payment.id, error })
    // Don't fail the payment if receipt generation fails
  }

  // 🔌 REAL-TIME: Emit socket events based on payment status (fast payment)
  try {
    const paymentPayload = {
      paymentId: payment.id,
      orderId: fastOrder.id,
      orderNumber: fastOrder.orderNumber,
      venueId: venueId,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      method: payment.method,
      status: payment.status.toLowerCase(), // Convert to lowercase for Android compatibility
      type: 'FAST',
      timestamp: new Date().toISOString(),
      metadata: {
        cardBrand: paymentData.cardBrand,
        last4: paymentData.last4,
      },
    }

    // Emit appropriate event based on payment status
    if (payment.status === 'COMPLETED') {
      socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_COMPLETED, paymentPayload)
      logger.info('🔌 PAYMENT_COMPLETED event emitted (fast payment)', {
        paymentId: payment.id,
        orderId: fastOrder.id,
        amount: payment.amount,
      })

      // Create commission calculation for this fast payment (non-blocking)
      if (payment.type !== 'TEST') {
        createCommissionForPayment(payment.id).catch(err => {
          logger.error('Failed to create commission for fast payment', {
            paymentId: payment.id,
            orderId: fastOrder.id,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    } else if (payment.status === 'PROCESSING') {
      socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_PROCESSING, paymentPayload)
      logger.info('🔌 PAYMENT_PROCESSING event emitted (fast payment)', {
        paymentId: payment.id,
        orderId: fastOrder.id,
        amount: payment.amount,
      })
    } else if (payment.status === 'FAILED') {
      socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_FAILED, {
        ...paymentPayload,
        errorMessage: 'Fast payment failed during processing',
      })
      logger.warn('🔌 PAYMENT_FAILED event emitted (fast payment)', {
        paymentId: payment.id,
        orderId: fastOrder.id,
        amount: payment.amount,
      })
    }

    // Emit order updated event to venue room for the fast order
    socketManager.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: fastOrder.id,
      orderNumber: fastOrder.orderNumber,
      venueId: venueId,
      status: fastOrder.status,
      paymentStatus: fastOrder.paymentStatus,
      type: 'FAST',
      timestamp: new Date().toISOString(),
    })

    logger.info('Socket events emitted successfully for fast payment', {
      paymentId: payment.id,
      orderId: fastOrder.id,
      orderNumber: fastOrder.orderNumber,
      venueId: venueId,
      paymentStatus: payment.status,
    })
  } catch (error) {
    logger.error('Failed to emit socket events for fast payment', {
      paymentId: payment.id,
      orderId: fastOrder.id,
      error,
    })
    // Don't fail the payment if socket emission fails
  }

  logger.info('Fast payment recorded successfully', { paymentId: payment.id, amount: totalAmount })

  // Add digital receipt info to payment response
  return {
    ...payment,
    digitalReceipt: digitalReceipt
      ? {
          id: digitalReceipt.id,
          accessKey: digitalReceipt.accessKey,
          receiptUrl: `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/receipts/public/${digitalReceipt.accessKey}`,
        }
      : null,
  }
}

/**
 * Get available merchant accounts for a venue
 * Returns active merchant accounts configured for the venue with display information
 * @param venueId Venue ID to get merchant accounts for
 * @param orgId Organization ID for authorization
 * @returns Array of available merchant accounts with display info
 */
export async function getVenueMerchantAccounts(venueId: string, _orgId?: string): Promise<any[]> {
  // First validate that the venue exists and belongs to the organization
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
    },
    include: {
      paymentConfig: {
        include: {
          primaryAccount: {
            include: {
              provider: true,
            },
          },
          secondaryAccount: {
            include: {
              provider: true,
            },
          },
          tertiaryAccount: {
            include: {
              provider: true,
            },
          },
        },
      },
    },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found or not accessible')
  }

  if (!venue.paymentConfig) {
    logger.warn('No payment configuration found for venue', { venueId })
    return []
  }

  const accounts = []
  const { paymentConfig } = venue

  // Helper function to create account response object
  const createAccountResponse = (account: any, accountType: string) => {
    if (!account || !account.active) return null

    // Check if account has required credentials
    const credentials = account.credentialsEncrypted
    const hasValidCredentials = !!(credentials && credentials.merchantId && credentials.apiKey)

    return {
      id: account.id,
      accountType,
      displayName: account.displayName || `${account.provider.name} ${accountType}`,
      providerName: account.provider.name,
      providerCode: account.provider.code,
      active: account.active,
      hasValidCredentials,
      displayOrder: account.displayOrder,
      ecommerceMerchantId: account.ecommerceMerchantId,
      // 🚀 OPTIMIZATION: Include decrypted credentials for POS terminals
      // This eliminates the need for getMentaRoute API calls during payment
      credentials: hasValidCredentials
        ? {
            apiKey: credentials.apiKey,
            merchantId: credentials.merchantId,
            customerId: credentials.customerId || null,
          }
        : null,
    }
  }

  // Add primary account if exists and active
  if (paymentConfig.primaryAccount) {
    const primaryAccount = createAccountResponse(paymentConfig.primaryAccount, 'PRIMARY')
    if (primaryAccount) accounts.push(primaryAccount)
  }

  // Add secondary account if exists and active
  if (paymentConfig.secondaryAccount) {
    const secondaryAccount = createAccountResponse(paymentConfig.secondaryAccount, 'SECONDARY')
    if (secondaryAccount) accounts.push(secondaryAccount)
  }

  // Add tertiary account if exists and active
  if (paymentConfig.tertiaryAccount) {
    const tertiaryAccount = createAccountResponse(paymentConfig.tertiaryAccount, 'TERTIARY')
    if (tertiaryAccount) accounts.push(tertiaryAccount)
  }

  // Filter only accounts with valid credentials and sort by display order
  const validAccounts = accounts.filter(account => account.hasValidCredentials).sort((a, b) => a.displayOrder - b.displayOrder)

  logger.info('Retrieved merchant accounts for venue', {
    venueId,
    totalAccounts: accounts.length,
    validAccounts: validAccounts.length,
  })

  return validAccounts
}

/**
 * Interface for payment routing request data
 */
interface PaymentRoutingData {
  amount: number // Amount in cents
  merchantAccountId: string // Selected merchant account ID (user has already chosen primary/secondary/tertiary)
  terminalSerial: string // Terminal identifier
  bin?: string // Optional BIN for card routing
}

/**
 * Get payment routing configuration for the selected merchant account
 * This method retrieves the credentials and routing info for the merchant account selected by the user in TPV
 * @param venueId Venue ID
 * @param routingData Routing parameters from the request (includes user-selected merchant account)
 * @param orgId Organization ID for authorization
 * @returns Payment routing configuration with credentials and routing info for the selected account
 */
export async function getPaymentRouting(venueId: string, routingData: PaymentRoutingData, _orgId?: string): Promise<any> {
  logger.info('Getting payment routing configuration for user-selected merchant account', {
    venueId,
    merchantAccountId: routingData.merchantAccountId,
    amount: routingData.amount,
  })

  // First validate that the venue exists and get its payment configuration
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
    },
    include: {
      paymentConfig: {
        include: {
          primaryAccount: {
            include: {
              provider: true,
            },
          },
          secondaryAccount: {
            include: {
              provider: true,
            },
          },
          tertiaryAccount: {
            include: {
              provider: true,
            },
          },
        },
      },
    },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found or not accessible')
  }

  if (!venue.paymentConfig) {
    throw new BadRequestError('Venue payment configuration not found')
  }

  // Find the specific merchant account by ID from the venue's configured accounts
  // The user has already selected which account they want to use (primary/secondary/tertiary)
  let selectedAccount: any = null
  let accountType: string = 'UNKNOWN'

  const { paymentConfig } = venue

  if (paymentConfig.primaryAccount?.id === routingData.merchantAccountId) {
    selectedAccount = paymentConfig.primaryAccount
    accountType = 'PRIMARY'
  } else if (paymentConfig.secondaryAccount?.id === routingData.merchantAccountId) {
    selectedAccount = paymentConfig.secondaryAccount
    accountType = 'SECONDARY'
  } else if (paymentConfig.tertiaryAccount?.id === routingData.merchantAccountId) {
    selectedAccount = paymentConfig.tertiaryAccount
    accountType = 'TERTIARY'
  }

  if (!selectedAccount || !selectedAccount.active) {
    throw new NotFoundError('Selected merchant account not found or not active for this venue')
  }

  // Check if account has valid credentials
  const credentials = selectedAccount.credentialsEncrypted as any
  if (!credentials || !credentials.merchantId || !credentials.apiKey || !credentials.customerId) {
    throw new BadRequestError('Selected merchant account does not have valid payment processor credentials')
  }

  // Simple routing based on account type - the user has already made the routing decision by selecting the account
  const route = accountType.toLowerCase() // 'primary', 'secondary', or 'tertiary'
  const acquirer = selectedAccount.provider.code.toUpperCase() // 'MENTA', etc.

  // 🚨 CRITICAL FIX: Get proper terminal UUID instead of hardware serial
  // Fetch terminal record by serial number to get the proper UUID
  const terminal = await prisma.terminal.findFirst({
    where: {
      serialNumber: routingData.terminalSerial,
      venueId: venueId,
    },
  })

  if (!terminal) {
    throw new NotFoundError(`Terminal with serial ${routingData.terminalSerial} not found for venue ${venueId}`)
  }

  // Use Menta terminal UUID if available, otherwise use terminal's own UUID
  const terminalUuid = terminal.mentaTerminalId
  logger.info(`🎯 Using terminal UUID for payments: ${terminalUuid} (serial: ${routingData.terminalSerial})`)

  // The routing response contains the credentials for the user-selected merchant account
  const routingResponse = {
    route,
    acquirer,
    merchantId: credentials.merchantId,
    apiKeyMerchant: credentials.apiKey,
    customerId: credentials.customerId,
    terminalSerial: terminalUuid, // 🎯 CRITICAL: Return UUID instead of serial number
    amount: routingData.amount,
    // Additional routing metadata
    routingMetadata: {
      accountType,
      providerCode: selectedAccount.provider.code,
      ecommerceMerchantId: selectedAccount.ecommerceMerchantId,
      userSelected: true, // This routing was based on user selection, not automatic rules
      timestamp: new Date().toISOString(),
    },
  }

  logger.info('Payment routing configuration generated for user-selected account', {
    venueId,
    merchantAccountId: routingData.merchantAccountId,
    accountType,
    route,
    acquirer,
    userSelected: true,
    merchantId: credentials.merchantId.substring(0, 8) + '...',
  })

  return routingResponse
}

/**
 * ✅ NUEVO: Mapea métodos de pago del backend a códigos de POS
 * Convierte los métodos de pago de Avoqado a los códigos que entiende SoftRestaurant
 */
function mapPaymentMethodToPOS(method: PaymentMethod): string {
  logger.info('Mapping payment method to POS', { method })
  const paymentMethodMap: Record<PaymentMethod, string> = {
    CASH: 'ACARD', // ✅ CHANGED: Use DEB instead of AEF (tipo=2 CARD) to prevent $0.00 archiving issue
    CREDIT_CARD: 'CRE', // TAR. CREDITO
    DEBIT_CARD: 'DEB', // TAR. DEBITO
    DIGITAL_WALLET: 'MPY', // MARC PAYMENTS (como genérico para wallets)
    BANK_TRANSFER: 'DEB', // ✅ CHANGED: Use DEB instead of AEF to prevent $0.00 archiving
    CRYPTOCURRENCY: 'ACARD', // 🪙 B4Bit crypto payments - map to generic card type
    OTHER: 'ACARD', // ✅ CHANGED: Default to DEB instead of AEF
  }

  return paymentMethodMap[method] || 'ACARD' // ✅ CHANGED: Default fallback to DEB
}

// ==========================================
// COUPON FINALIZATION
// ==========================================

/**
 * Finalize coupon redemptions when order payment completes.
 * Called ONLY when order is fully paid - not on partial payments.
 *
 * This follows Toast/Square best practice: coupons are "applied" at checkout
 * but only "redeemed" (counted against limits) when payment succeeds.
 *
 * @param venueId Venue ID for logging
 * @param orderId Order ID to finalize coupons for
 */
async function finalizeCouponsForOrder(venueId: string, orderId: string): Promise<void> {
  // Find all coupon-based discounts on this order
  const couponDiscounts = await prisma.orderDiscount.findMany({
    where: {
      orderId,
      couponCodeId: { not: null },
    },
    include: {
      couponCode: {
        include: { discount: true },
      },
    },
  })

  if (couponDiscounts.length === 0) {
    logger.debug('🎟️ No coupons to finalize for order', { orderId })
    return
  }

  // Get order for customerId
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { customerId: true },
  })

  for (const orderDiscount of couponDiscounts) {
    if (!orderDiscount.couponCodeId || !orderDiscount.couponCode) continue

    // Check if already redeemed (idempotency - prevents double counting on retries)
    const existingRedemption = await prisma.couponRedemption.findUnique({
      where: { orderId },
    })
    if (existingRedemption) {
      logger.debug('🎟️ Coupon already redeemed for order, skipping', {
        orderId,
        couponCodeId: orderDiscount.couponCodeId,
      })
      continue
    }

    // Create redemption record
    await prisma.couponRedemption.create({
      data: {
        couponCodeId: orderDiscount.couponCodeId,
        orderId,
        customerId: order?.customerId,
        amountSaved: orderDiscount.amount,
      },
    })

    // Increment CouponCode.currentUses
    await prisma.couponCode.update({
      where: { id: orderDiscount.couponCodeId },
      data: { currentUses: { increment: 1 } },
    })

    // Increment Discount.currentUses
    if (orderDiscount.couponCode.discountId) {
      await prisma.discount.update({
        where: { id: orderDiscount.couponCode.discountId },
        data: { currentUses: { increment: 1 } },
      })
    }

    logger.info('✅ Coupon finalized on payment completion', {
      orderId,
      venueId,
      couponCode: orderDiscount.couponCode.code,
      couponCodeId: orderDiscount.couponCodeId,
      amountSaved: orderDiscount.amount.toString(),
    })
  }
}
