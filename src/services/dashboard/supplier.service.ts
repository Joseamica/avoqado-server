import { Supplier, SupplierPricing, Prisma, Unit } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import { CreateSupplierDto, UpdateSupplierDto } from '../../schemas/dashboard/inventory.schema'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * Get all suppliers for a venue
 */
export async function getSuppliers(
  venueId: string,
  filters?: {
    active?: boolean
    search?: string
    rating?: number
  },
): Promise<Supplier[]> {
  const where: Prisma.SupplierWhereInput = {
    venueId,
    deletedAt: null, // Exclude soft-deleted records
    ...(filters?.active !== undefined && { active: filters.active }),
    ...(filters?.rating && { rating: { gte: filters.rating } }),
    ...(filters?.search && {
      OR: [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { contactName: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
      ],
    }),
  }

  const suppliers = await prisma.supplier.findMany({
    where,
    include: {
      pricing: {
        where: {
          active: true,
        },
        include: {
          rawMaterial: {
            select: {
              id: true,
              name: true,
              unit: true,
            },
          },
        },
      },
      purchaseOrders: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
          orderDate: true,
        },
        orderBy: {
          orderDate: 'desc',
        },
        take: 5,
      },
    },
    orderBy: [{ rating: 'desc' }, { name: 'asc' }],
  })

  return suppliers as any
}

/**
 * Get a single supplier by ID
 */
export async function getSupplier(venueId: string, supplierId: string): Promise<Supplier | null> {
  const supplier = await prisma.supplier.findFirst({
    where: {
      id: supplierId,
      venueId,
    },
    include: {
      pricing: {
        include: {
          rawMaterial: true,
        },
      },
      purchaseOrders: {
        orderBy: {
          orderDate: 'desc',
        },
        take: 20,
      },
    },
  })

  return supplier as any
}

/**
 * Create a new supplier
 */
export async function createSupplier(venueId: string, data: CreateSupplierDto): Promise<Supplier> {
  // Check for duplicate name
  const existing = await prisma.supplier.findFirst({
    where: {
      venueId,
      name: data.name,
    },
  })

  if (existing) {
    throw new AppError(`Supplier with name ${data.name} already exists`, 400)
  }

  const supplier = await prisma.supplier.create({
    data: {
      ...data,
      venueId,
    },
  })

  return supplier
}

/**
 * Update an existing supplier
 */
export async function updateSupplier(venueId: string, supplierId: string, data: UpdateSupplierDto): Promise<Supplier> {
  const existing = await prisma.supplier.findFirst({
    where: { id: supplierId, venueId },
  })

  if (!existing) {
    throw new AppError(`Supplier with ID ${supplierId} not found`, 404)
  }

  const supplier = await prisma.supplier.update({
    where: { id: supplierId },
    data,
  })

  return supplier
}

/**
 * Delete a supplier (soft delete)
 */
export async function deleteSupplier(venueId: string, supplierId: string, staffId?: string): Promise<void> {
  const existing = await prisma.supplier.findFirst({
    where: { id: supplierId, venueId, deletedAt: null },
    include: {
      purchaseOrders: true,
    },
  })

  if (!existing) {
    throw new AppError(`Supplier with ID ${supplierId} not found`, 404)
  }

  if (existing.purchaseOrders.length > 0) {
    throw new AppError(
      `Cannot delete supplier ${existing.name} - it has ${existing.purchaseOrders.length} associated purchase order(s)`,
      400,
    )
  }

  // Soft delete: set deletedAt timestamp instead of actually deleting
  await prisma.supplier.update({
    where: { id: supplierId },
    data: {
      deletedAt: new Date(),
      deletedBy: staffId,
      active: false, // Also mark as inactive
    },
  })
}

/**
 * Add or update supplier pricing for a raw material
 */
export async function createSupplierPricing(
  venueId: string,
  supplierId: string,
  data: {
    rawMaterialId: string
    pricePerUnit: number
    unit: string
    minimumQuantity: number
    bulkDiscount?: number
    effectiveFrom: string
    effectiveTo?: string
  },
): Promise<SupplierPricing> {
  // Verify supplier exists and belongs to venue
  const supplier = await prisma.supplier.findFirst({
    where: {
      id: supplierId,
      venueId,
    },
  })

  if (!supplier) {
    throw new AppError(`Supplier with ID ${supplierId} not found`, 404)
  }

  // Verify raw material exists and belongs to venue
  const rawMaterial = await prisma.rawMaterial.findFirst({
    where: {
      id: data.rawMaterialId,
      venueId,
    },
  })

  if (!rawMaterial) {
    throw new AppError(`Raw material not found`, 404)
  }

  // Deactivate existing pricing for the same raw material from this supplier
  await prisma.supplierPricing.updateMany({
    where: {
      supplierId,
      rawMaterialId: data.rawMaterialId,
      active: true,
    },
    data: {
      active: false,
      effectiveTo: new Date().toISOString(),
    },
  })

  const pricing = await prisma.supplierPricing.create({
    data: {
      supplierId,
      rawMaterialId: data.rawMaterialId,
      pricePerUnit: data.pricePerUnit,
      unit: data.unit as Unit,
      minimumQuantity: data.minimumQuantity,
      bulkDiscount: data.bulkDiscount,
      effectiveFrom: new Date(data.effectiveFrom),
      effectiveTo: data.effectiveTo ? new Date(data.effectiveTo) : undefined,
    },
    include: {
      supplier: true,
      rawMaterial: true,
    },
  })

  return pricing as any
}

/**
 * Get supplier pricing history for a raw material
 */
export async function getSupplierPricingHistory(venueId: string, rawMaterialId: string) {
  const rawMaterial = await prisma.rawMaterial.findFirst({
    where: {
      id: rawMaterialId,
      venueId,
    },
  })

  if (!rawMaterial) {
    throw new AppError(`Raw material not found`, 404)
  }

  const pricingHistory = await prisma.supplierPricing.findMany({
    where: {
      rawMaterialId,
    },
    include: {
      supplier: {
        select: {
          id: true,
          name: true,
          rating: true,
          leadTimeDays: true,
        },
      },
    },
    orderBy: {
      effectiveFrom: 'desc',
    },
  })

  return pricingHistory
}

/**
 * Get best suppliers for a raw material based on price, lead time, and reliability
 */
export async function getSupplierRecommendations(
  venueId: string,
  rawMaterialId: string,
  quantity: number = 1,
  weights?: {
    priceWeight?: number
    leadTimeWeight?: number
    reliabilityWeight?: number
  },
) {
  const { priceWeight = 0.5, leadTimeWeight = 0.2, reliabilityWeight = 0.3 } = weights || {}

  // Verify raw material exists
  const rawMaterial = await prisma.rawMaterial.findFirst({
    where: {
      id: rawMaterialId,
      venueId,
    },
  })

  if (!rawMaterial) {
    throw new AppError(`Raw material not found`, 404)
  }

  // Get all active suppliers with pricing for this material
  const suppliers = await prisma.supplier.findMany({
    where: {
      venueId,
      active: true,
      pricing: {
        some: {
          rawMaterialId,
          active: true,
        },
      },
    },
    include: {
      pricing: {
        where: {
          rawMaterialId,
          active: true,
        },
      },
    },
  })

  if (suppliers.length === 0) {
    return []
  }

  // Calculate scores for each supplier
  const recommendations = suppliers.map(supplier => {
    const pricing = supplier.pricing[0] // Active pricing for this material

    // Calculate effective price considering bulk discounts
    let effectivePrice = pricing.pricePerUnit.toNumber()
    if (quantity >= pricing.minimumQuantity.toNumber() && pricing.bulkDiscount) {
      effectivePrice = effectivePrice * (1 - pricing.bulkDiscount.toNumber())
    }

    const totalCost = effectivePrice * quantity

    // Normalize metrics to 0-100 scale
    // Price score: Lower is better (inverse relationship)
    const prices = suppliers.map(s => {
      const p = s.pricing[0].pricePerUnit.toNumber()
      const q =
        quantity >= s.pricing[0].minimumQuantity.toNumber() && s.pricing[0].bulkDiscount
          ? p * (1 - s.pricing[0].bulkDiscount.toNumber())
          : p
      return q
    })
    const minPrice = Math.min(...prices)
    const maxPrice = Math.max(...prices)
    const priceScore = maxPrice === minPrice ? 100 : ((maxPrice - effectivePrice) / (maxPrice - minPrice)) * 100

    // Lead time score: Faster is better (inverse relationship)
    const leadTimes = suppliers.map(s => s.leadTimeDays)
    const minLeadTime = Math.min(...leadTimes)
    const maxLeadTime = Math.max(...leadTimes)
    const leadTimeScore = maxLeadTime === minLeadTime ? 100 : ((maxLeadTime - supplier.leadTimeDays) / (maxLeadTime - minLeadTime)) * 100

    // Reliability score: Higher is better (direct relationship)
    const reliabilityScore = (supplier.reliabilityScore?.toNumber() || 0.5) * 100

    // Calculate weighted total score
    const totalScore = priceScore * priceWeight + leadTimeScore * leadTimeWeight + reliabilityScore * reliabilityWeight

    return {
      supplier: {
        id: supplier.id,
        name: supplier.name,
        contactName: supplier.contactName,
        email: supplier.email,
        phone: supplier.phone,
        rating: supplier.rating?.toNumber() || null,
        leadTimeDays: supplier.leadTimeDays,
        reliabilityScore: supplier.reliabilityScore?.toNumber() || null,
        minimumOrder: supplier.minimumOrder?.toNumber() || null,
      },
      pricing: {
        pricePerUnit: pricing.pricePerUnit.toNumber(),
        unit: pricing.unit,
        minimumQuantity: pricing.minimumQuantity.toNumber(),
        bulkDiscount: pricing.bulkDiscount?.toNumber() || null,
        effectivePrice,
      },
      analysis: {
        quantity,
        totalCost,
        estimatedDeliveryDays: supplier.leadTimeDays,
        meetsMinimumOrder: supplier.minimumOrder ? totalCost >= supplier.minimumOrder.toNumber() : true,
        scores: {
          priceScore: Math.round(priceScore * 10) / 10,
          leadTimeScore: Math.round(leadTimeScore * 10) / 10,
          reliabilityScore: Math.round(reliabilityScore * 10) / 10,
          totalScore: Math.round(totalScore * 10) / 10,
        },
      },
    }
  })

  // Sort by total score descending
  recommendations.sort((a, b) => b.analysis.scores.totalScore - a.analysis.scores.totalScore)

  return recommendations
}

/**
 * Calculate supplier performance metrics
 */
export async function getSupplierPerformance(venueId: string, supplierId: string, startDate?: Date, endDate?: Date) {
  const supplier = await prisma.supplier.findFirst({
    where: {
      id: supplierId,
      venueId,
    },
  })

  if (!supplier) {
    throw new AppError(`Supplier not found`, 404)
  }

  const dateFilter = {
    ...(startDate && { gte: startDate }),
    ...(endDate && { lte: endDate }),
  }

  // Get all purchase orders in date range
  const purchaseOrders = await prisma.purchaseOrder.findMany({
    where: {
      supplierId,
      venueId,
      ...(Object.keys(dateFilter).length > 0 && { orderDate: dateFilter }),
    },
    include: {
      items: true,
    },
  })

  if (purchaseOrders.length === 0) {
    return {
      supplierId: supplier.id,
      supplierName: supplier.name,
      period: { startDate, endDate },
      orderCount: 0,
      totalSpent: 0,
      averageOrderValue: 0,
      onTimeDeliveryRate: 0,
      qualityScore: supplier.reliabilityScore?.toNumber() || 0,
    }
  }

  // Calculate metrics
  const totalSpent = purchaseOrders.reduce((sum, po) => sum.add(po.total), new Decimal(0))
  const averageOrderValue = totalSpent.div(purchaseOrders.length)

  // Calculate on-time delivery rate
  const completedOrders = purchaseOrders.filter(po => po.status === 'RECEIVED')
  const onTimeOrders = completedOrders.filter(po => {
    if (!po.receivedDate || !po.expectedDeliveryDate) return false
    return new Date(po.receivedDate) <= new Date(po.expectedDeliveryDate)
  })
  const onTimeDeliveryRate = completedOrders.length > 0 ? (onTimeOrders.length / completedOrders.length) * 100 : 0

  return {
    supplierId: supplier.id,
    supplierName: supplier.name,
    rating: supplier.rating?.toNumber() || null,
    period: { startDate, endDate },
    orderCount: purchaseOrders.length,
    totalSpent: totalSpent.toNumber(),
    averageOrderValue: averageOrderValue.toNumber(),
    onTimeDeliveryRate: Math.round(onTimeDeliveryRate * 10) / 10,
    completedOrders: completedOrders.length,
    pendingOrders: purchaseOrders.filter(po => po.status === 'DRAFT' || po.status === 'SENT' || po.status === 'CONFIRMED').length,
    cancelledOrders: purchaseOrders.filter(po => po.status === 'CANCELLED').length,
    qualityScore: (supplier.reliabilityScore?.toNumber() || 0) * 100,
  }
}
