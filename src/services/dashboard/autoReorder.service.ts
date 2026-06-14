import prisma from '../../utils/prismaClient'
import { Decimal } from '@prisma/client/runtime/library'
import { Unit, RawMaterialCategory, Prisma, PurchaseOrderStatus } from '@prisma/client'
import AppError from '../../errors/AppError'
import { getSupplierRecommendations } from './supplier.service'
import { logAction } from './activity-log.service'
import { venueHasFeatureAccess, getVenueBaseTier } from '../access/basePlan.service'
import { sendPurchaseOrderEmailAsync } from './purchaseOrder.service'

/**
 * Auto-Reorder Suggestion System
 * Analyzes inventory levels and usage patterns to suggest purchase orders
 */

export type ReorderUrgency = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface AutoReorderConfig {
  enabled: boolean
  dailyCapMxn: number | null
  minUrgency: ReorderUrgency
}

export const DEFAULT_AUTO_REORDER_CONFIG: AutoReorderConfig = {
  enabled: false,
  dailyCapMxn: null,
  minUrgency: 'LOW',
}

const URGENCY_RANK: Record<ReorderUrgency, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }

/** Parse the venue's autoReorderConfig JSON into a typed, defaulted config. */
export function parseAutoReorderConfig(json: Prisma.JsonValue | null | undefined): AutoReorderConfig {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ...DEFAULT_AUTO_REORDER_CONFIG }
  const o = json as Record<string, unknown>
  const minU = typeof o.minUrgency === 'string' && o.minUrgency in URGENCY_RANK ? (o.minUrgency as ReorderUrgency) : 'LOW'
  const cap = typeof o.dailyCapMxn === 'number' && o.dailyCapMxn > 0 ? o.dailyCapMxn : null
  return { enabled: o.enabled === true, dailyCapMxn: cap, minUrgency: minU }
}

export interface AutoReorderRunResult {
  ran: boolean
  reason?: string
  ordersCreated: number
  emailsSent: number
  itemsOrdered: number
  skippedOpenPo: number
  skippedNoSupplier: number
  skippedCap: number
  skippedLowUrgency: number
}

const ZERO_RESULT: AutoReorderRunResult = {
  ran: false,
  ordersCreated: 0,
  emailsSent: 0,
  itemsOrdered: 0,
  skippedOpenPo: 0,
  skippedNoSupplier: 0,
  skippedCap: 0,
  skippedLowUrgency: 0,
}

const OPEN_PO_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.DRAFT,
  PurchaseOrderStatus.PENDING_APPROVAL,
  PurchaseOrderStatus.APPROVED,
  PurchaseOrderStatus.SENT,
  PurchaseOrderStatus.CONFIRMED,
  PurchaseOrderStatus.SHIPPED,
  PurchaseOrderStatus.PARTIAL,
]

/** Dependencies injected for testability; defaults wire the real implementations. */
export interface AutoReorderDeps {
  getReorderSuggestions: typeof getReorderSuggestions
  createPurchaseOrdersFromSuggestions: typeof createPurchaseOrdersFromSuggestions
  sendPurchaseOrderEmailAsync: typeof sendPurchaseOrderEmailAsync
  venueHasFeatureAccess: typeof venueHasFeatureAccess
  getVenueBaseTier: typeof getVenueBaseTier
}

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
    autoGenerated?: boolean
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
    // Compute IVA like the manual createPurchaseOrder flow (net subtotal + 16% IVA) so the
    // supplier PO email shows a coherent tax line (not "(16%) $0.00") and matches manual POs.
    const subtotal = items.reduce((sum, item) => sum.add(new Decimal(item.quantity).mul(item.pricePerUnit)), new Decimal(0))
    const taxRate = new Decimal('0.16')
    const taxAmount = subtotal.mul(taxRate)
    const total = subtotal.add(taxAmount)

    // Generate order number
    const orderNumber = await generateOrderNumber(venueId)

    const order = await prisma.purchaseOrder.create({
      data: {
        venueId,
        supplierId,
        orderNumber,
        orderDate: new Date(),
        status: options?.autoApprove ? 'APPROVED' : 'DRAFT',
        autoGenerated: options?.autoGenerated ?? false,
        subtotal,
        taxRate,
        taxAmount,
        total,
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
            total: new Decimal(item.quantity).mul(item.pricePerUnit),
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

  logAction({
    staffId: options?.staffId,
    venueId,
    action: 'AUTO_REORDER_PO_CREATED',
    entity: 'PurchaseOrder',
    data: { ordersCreated: createdOrders.length, materialCount: rawMaterialIds.length, autoApprove: options?.autoApprove },
  })

  return {
    success: true,
    ordersCreated: createdOrders.length,
    orders: createdOrders,
  }
}

/**
 * Auto-reorder for one venue: detect low-stock items, drop ones already on an open PO,
 * apply min-urgency + daily-cap guardrails, create auto-approved POs grouped by supplier,
 * email each supplier, and audit. No-op unless the venue has AUTO_REORDER AND config.enabled.
 *
 * @param prefetchedConfig pass the venue's parsed config to skip a re-read (cron path); omit to read it.
 * @param deps injected for tests; omit in production to use the real implementations.
 */
export async function runAutoReorderForVenue(
  venueId: string,
  prefetchedConfig?: AutoReorderConfig,
  deps?: Partial<AutoReorderDeps>,
): Promise<AutoReorderRunResult> {
  const d: AutoReorderDeps = {
    getReorderSuggestions,
    createPurchaseOrdersFromSuggestions,
    sendPurchaseOrderEmailAsync,
    venueHasFeatureAccess,
    getVenueBaseTier,
    ...deps,
  }

  // 1. Resolve config
  let config = prefetchedConfig
  if (!config) {
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { autoReorderConfig: true } })
    config = parseAutoReorderConfig(venue?.autoReorderConfig ?? null)
  }
  if (!config.enabled) return { ...ZERO_RESULT, reason: 'disabled' }

  // 2. Feature gate (PREMIUM)
  const entitled = await d.venueHasFeatureAccess(venueId, 'AUTO_REORDER')
  if (!entitled) return { ...ZERO_RESULT, reason: 'no_feature' }

  // Side-effect (auto-creating POs + emailing real suppliers) requires a REAL active PREMIUM
  // base plan — NOT the demo/grandfather bypass that venueHasFeatureAccess honors. This keeps
  // LIVE_DEMO / seeded venues from auto-emailing real supplier addresses.
  const tier = await d.getVenueBaseTier(venueId)
  if (tier !== 'PREMIUM') return { ...ZERO_RESULT, reason: 'not_premium' }

  // 3. Suggestions
  const { suggestions } = await d.getReorderSuggestions(venueId)
  if (suggestions.length === 0) return { ...ZERO_RESULT, ran: true, reason: 'nothing_low' }

  const result: AutoReorderRunResult = { ...ZERO_RESULT, ran: true }

  // 4. Drop items with no recommended supplier
  let candidates = suggestions.filter(s => {
    if (!s.suggestion.recommendedSupplier) {
      result.skippedNoSupplier++
      return false
    }
    return true
  })

  // Drop items we can't actually order a quantity for (no usage history → suggestedQuantity 0)
  candidates = candidates.filter(s => s.suggestion.suggestedQuantity > 0)

  // 5. Min-urgency guardrail
  const minRank = URGENCY_RANK[config.minUrgency]
  candidates = candidates.filter(s => {
    if (URGENCY_RANK[s.suggestion.urgency] < minRank) {
      result.skippedLowUrgency++
      return false
    }
    return true
  })

  // 6. Dedupe — drop items already on an open PO
  if (candidates.length > 0) {
    const ids = candidates.map(s => s.rawMaterial.id)
    const openItems = await prisma.purchaseOrderItem.findMany({
      where: { rawMaterialId: { in: ids }, purchaseOrder: { venueId, status: { in: OPEN_PO_STATUSES } } },
      select: { rawMaterialId: true },
    })
    const alreadyOpen = new Set(openItems.map(i => i.rawMaterialId))
    candidates = candidates.filter(s => {
      if (alreadyOpen.has(s.rawMaterial.id)) {
        result.skippedOpenPo++
        return false
      }
      return true
    })
  }

  // 7. Daily cap guardrail (suggestions already CRITICAL-first)
  const finalIds: string[] = []
  if (config.dailyCapMxn != null) {
    let spent = 0
    for (const s of candidates) {
      const cost = s.suggestion.estimatedCost ?? 0
      if (spent + cost > config.dailyCapMxn) {
        result.skippedCap++
        continue
      }
      spent += cost
      finalIds.push(s.rawMaterial.id)
    }
  } else {
    finalIds.push(...candidates.map(s => s.rawMaterial.id))
  }

  if (finalIds.length === 0) {
    await logAction({ venueId, action: 'AUTO_REORDER_RUN', entity: 'PurchaseOrder', data: { ...result, ordersCreated: 0 } })
    return result
  }

  // 8. Create auto-approved POs + email each supplier
  const created = await d.createPurchaseOrdersFromSuggestions(venueId, finalIds, { autoApprove: true, autoGenerated: true })
  result.ordersCreated = created.ordersCreated
  result.itemsOrdered = finalIds.length

  for (const order of created.orders) {
    const sent = await d.sendPurchaseOrderEmailAsync(venueId, order.id)
    if (sent) result.emailsSent++
  }

  // 9. Audit
  await logAction({
    venueId,
    action: 'AUTO_REORDER_RUN',
    entity: 'PurchaseOrder',
    data: {
      ordersCreated: result.ordersCreated,
      emailsSent: result.emailsSent,
      itemsOrdered: result.itemsOrdered,
      skippedOpenPo: result.skippedOpenPo,
      skippedCap: result.skippedCap,
      skippedLowUrgency: result.skippedLowUrgency,
      skippedNoSupplier: result.skippedNoSupplier,
    },
  })

  return result
}

/** Read the venue's parsed auto-reorder config. */
export async function getAutoReorderConfig(venueId: string): Promise<AutoReorderConfig> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { autoReorderConfig: true } })
  return parseAutoReorderConfig(venue?.autoReorderConfig ?? null)
}

/** Persist a new auto-reorder config (full overwrite of the JSON singleton). */
export async function setAutoReorderConfig(venueId: string, config: AutoReorderConfig): Promise<AutoReorderConfig> {
  await prisma.venue.update({
    where: { id: venueId },
    data: { autoReorderConfig: config as unknown as Prisma.InputJsonValue },
  })
  return config
}
