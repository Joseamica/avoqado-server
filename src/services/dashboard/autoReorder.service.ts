import prisma from '../../utils/prismaClient'
import { Decimal } from '@prisma/client/runtime/library'
import { Unit, RawMaterialCategory } from '@prisma/client'
import AppError from '../../errors/AppError'
import { getSupplierRecommendations } from './supplier.service'

/**
 * Auto-Reorder Suggestion System
 * Analyzes inventory levels and usage patterns to suggest purchase orders
 */

/**
 * Generate unique order number
 */
async function generateOrderNumber(venueId: string): Promise<string> {
  const today = new Date()
  const datePrefix = `PO${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

  const lastOrder = await prisma.purchaseOrder.findFirst({
    where: {
      venueId,
      orderNumber: {
        startsWith: datePrefix,
      },
    },
    orderBy: {
      orderNumber: 'desc',
    },
  })

  if (!lastOrder) {
    return `${datePrefix}-001`
  }

  const lastSequence = parseInt(lastOrder.orderNumber.split('-')[1])
  const nextSequence = String(lastSequence + 1).padStart(3, '0')
  return `${datePrefix}-${nextSequence}`
}

/**
 * Get suggested quantity based on historical usage
 * Uses exponential moving average for demand forecasting
 */
async function calculateSuggestedQuantity(venueId: string, rawMaterialId: string, daysToForecast: number = 30): Promise<number> {
  const endDate = new Date()
  const startDate = new Date(endDate)
  startDate.setDate(startDate.getDate() - 90) // Last 90 days of data

  // Get usage movements
  const movements = await prisma.rawMaterialMovement.findMany({
    where: {
      venueId,
      rawMaterialId,
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
      type: 'USAGE',
    },
    orderBy: {
      createdAt: 'asc',
    },
  })

  if (movements.length === 0) {
    return 0 // No historical data, cannot forecast
  }

  // Calculate daily average usage
  const totalUsage = movements.reduce((sum, m) => sum.add(m.quantity.abs()), new Decimal(0))
  const daysWithData = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
  const avgDailyUsage = totalUsage.div(daysWithData)

  // Forecast for specified days + safety stock (25%)
  const forecastedUsage = avgDailyUsage.mul(daysToForecast)
  const safetyStock = forecastedUsage.mul(0.25)
  const suggestedQuantity = forecastedUsage.add(safetyStock)

  return Math.ceil(suggestedQuantity.toNumber())
}

/**
 * Get all raw materials that need reordering
 */
export async function getReorderSuggestions(
  venueId: string,
  options?: {
    category?: string
    includeNearReorder?: boolean // Include items within 10% of reorder point
    limit?: number
    offset?: number
  },
) {
  // Find raw materials at or below reorder point
  const rawMaterials = await prisma.rawMaterial.findMany({
    where: {
      venueId,
      active: true,
      deletedAt: null,
      ...(options?.category && { category: options.category as RawMaterialCategory }),
    },
    include: {
      supplierPricing: {
        where: {
          active: true,
        },
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              active: true,
              rating: true,
              leadTimeDays: true,
            },
          },
        },
      },
    },
    ...(options?.limit && { take: options.limit }),
    ...(options?.offset && { skip: options.offset }),
  })

  // Filter materials that need reordering
  const materialsNeedingReorder = rawMaterials.filter(rm => {
    if (options?.includeNearReorder) {
      const nearReorderThreshold = rm.reorderPoint.mul(1.1) // Within 10% of reorder point
      return rm.currentStock.lessThanOrEqualTo(nearReorderThreshold)
    }
    return rm.currentStock.lessThanOrEqualTo(rm.reorderPoint)
  })

  // Generate suggestions for each material
  const suggestions = await Promise.all(
    materialsNeedingReorder.map(async rm => {
      // Calculate suggested order quantity
      const suggestedQuantity = await calculateSuggestedQuantity(venueId, rm.id, 30)

      // Get supplier recommendations
      const suppliers = await getSupplierRecommendations(venueId, rm.id, suggestedQuantity)

      // Get best supplier (highest score)
      const bestSupplier = suppliers.length > 0 ? suppliers[0] : null

      // Calculate urgency level
      let urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
      const stockLevel = rm.currentStock.div(rm.reorderPoint.equals(0) ? new Decimal(1) : rm.reorderPoint)
      if (stockLevel.lessThanOrEqualTo(0)) {
        urgency = 'CRITICAL' // Out of stock
      } else if (stockLevel.lessThan(0.5)) {
        urgency = 'HIGH' // Below 50% of reorder point
      } else if (stockLevel.lessThan(0.8)) {
        urgency = 'MEDIUM' // Below 80% of reorder point
      } else {
        urgency = 'LOW' // Near reorder point
      }

      // Calculate estimated cost
      const estimatedCost = bestSupplier ? bestSupplier.analysis.totalCost : null

      // Calculate days until stockout based on usage rate
      const avgDailyUsage = await calculateAverageDailyUsage(venueId, rm.id)
      const daysUntilStockout = avgDailyUsage > 0 ? Math.floor(rm.currentStock.toNumber() / avgDailyUsage) : null

      return {
        rawMaterial: {
          id: rm.id,
          name: rm.name,
          sku: rm.sku,
          category: rm.category,
          unit: rm.unit,
          currentStock: rm.currentStock.toNumber(),
          reorderPoint: rm.reorderPoint.toNumber(),
          stockLevel: stockLevel.toNumber(),
        },
        suggestion: {
          urgency,
          suggestedQuantity,
          estimatedCost,
          daysUntilStockout,
          recommendedSupplier: bestSupplier
            ? {
                id: bestSupplier.supplier.id,
                name: bestSupplier.supplier.name,
                leadTimeDays: bestSupplier.supplier.leadTimeDays,
                pricePerUnit: bestSupplier.pricing.pricePerUnit,
                totalCost: bestSupplier.analysis.totalCost,
                estimatedDeliveryDate: new Date(Date.now() + bestSupplier.supplier.leadTimeDays * 24 * 60 * 60 * 1000),
                meetsMinimumOrder: bestSupplier.analysis.meetsMinimumOrder,
              }
            : null,
          alternativeSuppliers: suppliers.slice(1, 4).map(s => ({
            id: s.supplier.id,
            name: s.supplier.name,
            pricePerUnit: s.pricing.pricePerUnit,
            totalCost: s.analysis.totalCost,
            leadTimeDays: s.supplier.leadTimeDays,
            score: s.analysis.scores.totalScore,
          })),
        },
        analysis: {
          hasSuppliers: suppliers.length > 0,
          supplierCount: suppliers.length,
          avgDailyUsage,
          forecastPeriodDays: 30,
          includesSafetyStock: true,
          safetyStockPercentage: 25,
        },
      }
    }),
  )

  // Sort by urgency (CRITICAL first, then by days until stockout)
  const urgencyOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
  suggestions.sort((a, b) => {
    if (urgencyOrder[a.suggestion.urgency] !== urgencyOrder[b.suggestion.urgency]) {
      return urgencyOrder[a.suggestion.urgency] - urgencyOrder[b.suggestion.urgency]
    }
    // If same urgency, sort by days until stockout (ascending, nulls last)
    if (a.suggestion.daysUntilStockout === null) return 1
    if (b.suggestion.daysUntilStockout === null) return -1
    return a.suggestion.daysUntilStockout - b.suggestion.daysUntilStockout
  })

  return {
    totalSuggestions: suggestions.length,
    criticalCount: suggestions.filter(s => s.suggestion.urgency === 'CRITICAL').length,
    highCount: suggestions.filter(s => s.suggestion.urgency === 'HIGH').length,
    mediumCount: suggestions.filter(s => s.suggestion.urgency === 'MEDIUM').length,
    lowCount: suggestions.filter(s => s.suggestion.urgency === 'LOW').length,
    suggestions,
    pagination: {
      limit: options?.limit,
      offset: options?.offset,
      hasMore: options?.limit ? suggestions.length === options.limit : false,
    },
  }
}

/**
 * Calculate average daily usage for a raw material
 */
async function calculateAverageDailyUsage(venueId: string, rawMaterialId: string): Promise<number> {
  const endDate = new Date()
  const startDate = new Date(endDate)
  startDate.setDate(startDate.getDate() - 30) // Last 30 days

  const usageData = await prisma.rawMaterialMovement.findMany({
    where: {
      venueId,
      rawMaterialId,
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
      type: 'USAGE',
    },
  })

  if (usageData.length === 0) return 0

  const totalUsage = usageData.reduce((sum, m) => sum.add(m.quantity.abs()), new Decimal(0))
  const days = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)))

  return totalUsage.div(days).toNumber()
}

/**
 * Create purchase orders from reorder suggestions
 * Automatically generates POs for materials with supplier recommendations
 */
export async function createPurchaseOrdersFromSuggestions(
  venueId: string,
  rawMaterialIds: string[],
  options?: {
    staffId?: string
    autoApprove?: boolean
  },
) {
  if (rawMaterialIds.length === 0) {
    throw new AppError('No raw materials specified', 400)
  }

  const suggestions = await getReorderSuggestions(venueId)
  const relevantSuggestions = suggestions.suggestions.filter(s => rawMaterialIds.includes(s.rawMaterial.id))

  if (relevantSuggestions.length === 0) {
    throw new AppError('No valid suggestions found for the specified materials', 404)
  }

  // Group suggestions by supplier
  const supplierGroups = new Map<
    string,
    Array<{
      rawMaterialId: string
      quantity: number
      pricePerUnit: number
      unit: string
    }>
  >()

  for (const suggestion of relevantSuggestions) {
    if (!suggestion.suggestion.recommendedSupplier) continue

    const supplierId = suggestion.suggestion.recommendedSupplier.id
    if (!supplierGroups.has(supplierId)) {
      supplierGroups.set(supplierId, [])
    }

    supplierGroups.get(supplierId)!.push({
      rawMaterialId: suggestion.rawMaterial.id,
      quantity: suggestion.suggestion.suggestedQuantity,
      pricePerUnit: suggestion.suggestion.recommendedSupplier.pricePerUnit,
      unit: suggestion.rawMaterial.unit,
    })
  }

  // Create purchase orders (one per supplier)
  const createdOrders = []
  for (const [supplierId, items] of supplierGroups.entries()) {
    const total = items.reduce((sum, item) => sum + item.quantity * item.pricePerUnit, 0)

    // Generate order number
    const orderNumber = await generateOrderNumber(venueId)

    const order = await prisma.purchaseOrder.create({
      data: {
        venueId,
        supplierId,
        orderNumber,
        orderDate: new Date(),
        status: options?.autoApprove ? 'APPROVED' : 'DRAFT',
        total: new Decimal(total),
        subtotal: new Decimal(total),
        createdBy: options?.staffId,
        ...(options?.autoApprove && {
          approvedBy: options.staffId,
          approvedAt: new Date(),
        }),
        items: {
          create: items.map(item => ({
            rawMaterial: {
              connect: { id: item.rawMaterialId },
            },
            quantityOrdered: item.quantity,
            unit: item.unit as Unit,
            unitPrice: item.pricePerUnit,
            total: new Decimal(item.quantity * item.pricePerUnit),
            quantityReceived: 0,
          })),
        },
      },
      include: {
        supplier: true,
        items: {
          include: {
            rawMaterial: true,
          },
        },
      },
    })

    createdOrders.push(order)
  }

  return {
    success: true,
    ordersCreated: createdOrders.length,
    orders: createdOrders,
  }
}
