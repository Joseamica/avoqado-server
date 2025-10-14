import prisma from '../../utils/prismaClient'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * Product Mix (PMIX) Report - Sales volume and profitability analysis
 * OPTIMIZED: Uses raw SQL aggregation for better performance
 */
export async function getPMIXReport(
  venueId: string,
  startDate: Date,
  endDate: Date,
  options?: {
    limit?: number
    offset?: number
  },
) {
  // Use raw SQL for efficient aggregation at database level
  const productStats = await prisma.$queryRaw<
    Array<{
      product_id: string
      product_name: string
      quantity_sold: bigint
      total_revenue: Decimal
      recipe_cost: Decimal | null
      avg_price: Decimal
    }>
  >`
    SELECT
      oi.product_id,
      p.name as product_name,
      SUM(oi.quantity)::bigint as quantity_sold,
      SUM(oi.unit_price * oi.quantity) as total_revenue,
      r.total_cost as recipe_cost,
      AVG(oi.unit_price) as avg_price
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi.order_id
    INNER JOIN "Product" p ON p.id = oi.product_id
    LEFT JOIN "Recipe" r ON r.product_id = p.id
    WHERE o.venue_id = ${venueId}
      AND o.created_at >= ${startDate}
      AND o.created_at <= ${endDate}
      AND o.status = 'COMPLETED'
    GROUP BY oi.product_id, p.name, r.total_cost
    ORDER BY total_revenue DESC
    ${options?.limit ? `LIMIT ${options.limit}` : ''}
    ${options?.offset ? `OFFSET ${options.offset}` : ''}
  `

  // Calculate totals for percentages
  const totals = await prisma.$queryRaw<
    Array<{
      total_quantity: bigint
      total_revenue: Decimal
      total_cost: Decimal
    }>
  >`
    SELECT
      SUM(oi.quantity)::bigint as total_quantity,
      SUM(oi.unit_price * oi.quantity) as total_revenue,
      SUM(COALESCE(r.total_cost, 0) * oi.quantity) as total_cost
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi.order_id
    LEFT JOIN "Recipe" r ON r.product_id = oi.product_id
    WHERE o.venue_id = ${venueId}
      AND o.created_at >= ${startDate}
      AND o.created_at <= ${endDate}
      AND o.status = 'COMPLETED'
  `

  const totalQuantity = Number(totals[0]?.total_quantity || 0)
  const totalRevenue = new Decimal(totals[0]?.total_revenue || 0)
  const totalCost = new Decimal(totals[0]?.total_cost || 0)
  const totalProfit = totalRevenue.minus(totalCost)

  // Transform results
  const products = productStats.map(p => {
    const quantitySold = Number(p.quantity_sold)
    const revenue = new Decimal(p.total_revenue)
    const recipeCost = p.recipe_cost ? new Decimal(p.recipe_cost) : new Decimal(0)
    const cost = recipeCost.mul(quantitySold)
    const profit = revenue.minus(cost)

    return {
      productId: p.product_id,
      productName: p.product_name,
      quantitySold,
      quantityPercentage: totalQuantity > 0 ? (quantitySold / totalQuantity) * 100 : 0,
      revenue: revenue.toNumber(),
      revenuePercentage: totalRevenue.greaterThan(0) ? revenue.div(totalRevenue).mul(100).toNumber() : 0,
      cost: cost.toNumber(),
      profit: profit.toNumber(),
      profitMargin: revenue.greaterThan(0) ? profit.div(revenue).mul(100).toNumber() : 0,
      foodCostPercentage: revenue.greaterThan(0) ? cost.div(revenue).mul(100).toNumber() : 0,
      avgPrice: new Decimal(p.avg_price).toNumber(),
    }
  })

  return {
    period: { startDate, endDate },
    summary: {
      totalRevenue: totalRevenue.toNumber(),
      totalCost: totalCost.toNumber(),
      totalProfit: totalProfit.toNumber(),
      overallMargin: totalRevenue.greaterThan(0) ? totalProfit.div(totalRevenue).mul(100).toNumber() : 0,
      totalQuantitySold: totalQuantity,
      uniqueProducts: products.length,
    },
    products,
    pagination: {
      limit: options?.limit,
      offset: options?.offset,
      hasMore: options?.limit ? products.length === options.limit : false,
    },
  }
}

/**
 * Profitability Report - Analyze product profitability
 * OPTIMIZED: Added pagination support
 */
export async function getProfitabilityReport(
  venueId: string,
  options?: {
    categoryId?: string
    limit?: number
    offset?: number
  },
) {
  const products = await prisma.product.findMany({
    where: {
      venueId,
      ...(options?.categoryId && { categoryId: options.categoryId }),
    },
    include: {
      category: {
        select: {
          id: true,
          name: true,
        },
      },
      recipe: {
        select: {
          totalCost: true,
        },
      },
      pricingPolicy: {
        select: {
          pricingStrategy: true,
          targetFoodCostPercentage: true,
          foodCostPercentage: true,
          lastReviewedAt: true,
        },
      },
    },
    ...(options?.limit && { take: options.limit }),
    ...(options?.offset && { skip: options.offset }),
  })

  const analysis = products
    .map(product => {
      if (!product.recipe) {
        return {
          productId: product.id,
          productName: product.name,
          categoryName: product.category.name,
          hasRecipe: false,
          currentPrice: product.price.toNumber(),
          needsReview: true,
        }
      }

      const recipeCost = product.recipe.totalCost
      const currentPrice = product.price
      const foodCostPercentage = currentPrice.greaterThan(0) ? recipeCost.div(currentPrice).mul(100) : new Decimal(0)
      const markup = recipeCost.greaterThan(0) ? currentPrice.minus(recipeCost).div(recipeCost).mul(100) : new Decimal(0)
      const contribution = currentPrice.minus(recipeCost)

      // Determine profitability status
      let profitabilityStatus: 'EXCELLENT' | 'GOOD' | 'ACCEPTABLE' | 'POOR'
      if (foodCostPercentage.lessThan(20)) {
        profitabilityStatus = 'EXCELLENT'
      } else if (foodCostPercentage.lessThan(30)) {
        profitabilityStatus = 'GOOD'
      } else if (foodCostPercentage.lessThan(40)) {
        profitabilityStatus = 'ACCEPTABLE'
      } else {
        profitabilityStatus = 'POOR'
      }

      // Check if pricing needs review
      const needsReview =
        !product.pricingPolicy ||
        (product.pricingPolicy.targetFoodCostPercentage && foodCostPercentage.greaterThan(product.pricingPolicy.targetFoodCostPercentage))

      return {
        productId: product.id,
        productName: product.name,
        categoryName: product.category.name,
        hasRecipe: true,
        currentPrice: currentPrice.toNumber(),
        recipeCost: recipeCost.toNumber(),
        foodCostPercentage: foodCostPercentage.toNumber(),
        markupPercentage: markup.toNumber(),
        contribution: contribution.toNumber(),
        profitabilityStatus,
        pricingStrategy: product.pricingPolicy?.pricingStrategy || null,
        targetFoodCostPercentage: product.pricingPolicy?.targetFoodCostPercentage?.toNumber() || null,
        isUnderTarget:
          product.pricingPolicy?.targetFoodCostPercentage && foodCostPercentage.greaterThan(product.pricingPolicy.targetFoodCostPercentage),
        needsReview,
        lastReviewedAt: product.pricingPolicy?.lastReviewedAt || null,
      }
    })
    .sort((a, b) => {
      // Sort by profitability status (POOR first, then by food cost % descending)
      const statusOrder = { POOR: 0, ACCEPTABLE: 1, GOOD: 2, EXCELLENT: 3 }
      const statusA = a.hasRecipe && a.profitabilityStatus ? statusOrder[a.profitabilityStatus] : 4
      const statusB = b.hasRecipe && b.profitabilityStatus ? statusOrder[b.profitabilityStatus] : 4

      if (statusA !== statusB) return statusA - statusB
      if (a.hasRecipe && b.hasRecipe) {
        return (b.foodCostPercentage || 0) - (a.foodCostPercentage || 0)
      }
      return 0
    })

  // Calculate summary statistics
  const productsWithRecipes = analysis.filter(p => p.hasRecipe)
  const avgFoodCostPercentage =
    productsWithRecipes.length > 0
      ? productsWithRecipes.reduce((sum, p) => sum + (p.foodCostPercentage || 0), 0) / productsWithRecipes.length
      : 0

  const profitabilityBreakdown = {
    excellent: analysis.filter(p => p.profitabilityStatus === 'EXCELLENT').length,
    good: analysis.filter(p => p.profitabilityStatus === 'GOOD').length,
    acceptable: analysis.filter(p => p.profitabilityStatus === 'ACCEPTABLE').length,
    poor: analysis.filter(p => p.profitabilityStatus === 'POOR').length,
  }

  return {
    summary: {
      totalProducts: analysis.length,
      productsWithRecipes: productsWithRecipes.length,
      productsNeedingReview: analysis.filter(p => p.needsReview).length,
      avgFoodCostPercentage: Math.round(avgFoodCostPercentage * 10) / 10,
      profitabilityBreakdown,
    },
    products: analysis,
    pagination: {
      limit: options?.limit,
      offset: options?.offset,
      hasMore: options?.limit ? analysis.length === options.limit : false,
    },
  }
}

/**
 * Ingredient Usage Report - Track ingredient consumption and costs
 * OPTIMIZED: Uses database aggregations for better performance
 */
export async function getIngredientUsageReport(
  venueId: string,
  startDate: Date,
  endDate: Date,
  options?: {
    rawMaterialId?: string
    limit?: number
    offset?: number
  },
) {
  // Use raw SQL for efficient aggregation by movement type
  const materialStats = await prisma.$queryRaw<
    Array<{
      raw_material_id: string
      raw_material_name: string
      category: string
      unit: string
      purchases: Decimal
      usage: Decimal
      adjustments: Decimal
      waste: Decimal
      net_change: Decimal
      total_cost: Decimal
      avg_cost_per_unit: Decimal
    }>
  >`
    SELECT
      rmm.raw_material_id,
      rm.name as raw_material_name,
      rm.category,
      rm.unit,
      COALESCE(SUM(CASE WHEN rmm.type = 'PURCHASE' THEN rmm.quantity ELSE 0 END), 0) as purchases,
      COALESCE(SUM(CASE WHEN rmm.type = 'USAGE' THEN ABS(rmm.quantity) ELSE 0 END), 0) as usage,
      COALESCE(SUM(CASE WHEN rmm.type = 'ADJUSTMENT' THEN rmm.quantity ELSE 0 END), 0) as adjustments,
      COALESCE(SUM(CASE WHEN rmm.type = 'SPOILAGE' THEN ABS(rmm.quantity) ELSE 0 END), 0) as waste,
      COALESCE(SUM(rmm.quantity), 0) as net_change,
      COALESCE(SUM(rmm.quantity * rm.cost_per_unit), 0) as total_cost,
      rm.cost_per_unit as avg_cost_per_unit
    FROM "RawMaterialMovement" rmm
    INNER JOIN "RawMaterial" rm ON rm.id = rmm.raw_material_id
    WHERE rmm.venue_id = ${venueId}
      AND rmm.created_at >= ${startDate}
      AND rmm.created_at <= ${endDate}
      ${options?.rawMaterialId ? `AND rmm.raw_material_id = ${options.rawMaterialId}` : ''}
    GROUP BY rmm.raw_material_id, rm.name, rm.category, rm.unit, rm.cost_per_unit
    ORDER BY total_cost DESC
    ${options?.limit ? `LIMIT ${options.limit}` : ''}
    ${options?.offset ? `OFFSET ${options.offset}` : ''}
  `

  // Calculate totals
  const totalCost = materialStats.reduce((sum, m) => sum.add(new Decimal(m.total_cost)), new Decimal(0))

  const materials = materialStats.map(m => ({
    rawMaterialId: m.raw_material_id,
    rawMaterialName: m.raw_material_name,
    category: m.category,
    unit: m.unit,
    purchases: new Decimal(m.purchases).toNumber(),
    usage: new Decimal(m.usage).toNumber(),
    adjustments: new Decimal(m.adjustments).toNumber(),
    waste: new Decimal(m.waste).toNumber(),
    netChange: new Decimal(m.net_change).toNumber(),
    totalCost: new Decimal(m.total_cost).toNumber(),
    costPercentage: totalCost.greaterThan(0) ? new Decimal(m.total_cost).div(totalCost).mul(100).toNumber() : 0,
    avgCostPerUnit: new Decimal(m.avg_cost_per_unit).toNumber(),
  }))

  return {
    period: { startDate, endDate },
    summary: {
      totalMaterials: materials.length,
      totalCost: totalCost.toNumber(),
      totalUsage: materials.reduce((sum, m) => sum + m.usage, 0),
      totalWaste: materials.reduce((sum, m) => sum + m.waste, 0),
      totalPurchases: materials.reduce((sum, m) => sum + m.purchases, 0),
    },
    materials,
    pagination: {
      limit: options?.limit,
      offset: options?.offset,
      hasMore: options?.limit ? materials.length === options.limit : false,
    },
  }
}

/**
 * Cost Variance Report - Compare expected vs actual costs
 * OPTIMIZED: Uses raw SQL aggregations for better performance
 */
export async function getCostVarianceReport(venueId: string, startDate: Date, endDate: Date) {
  // Calculate expected costs and revenue from orders (recipe-based)
  const expectedData = await prisma.$queryRaw<
    Array<{
      expected_cost: Decimal
      actual_revenue: Decimal
    }>
  >`
    SELECT
      COALESCE(SUM(COALESCE(r.total_cost, 0) * oi.quantity), 0) as expected_cost,
      COALESCE(SUM(oi.unit_price * oi.quantity), 0) as actual_revenue
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi.order_id
    LEFT JOIN "Recipe" r ON r.product_id = oi.product_id
    WHERE o.venue_id = ${venueId}
      AND o.created_at >= ${startDate}
      AND o.created_at <= ${endDate}
      AND o.status = 'COMPLETED'
  `

  // Calculate actual costs from ingredient movements
  const actualCostData = await prisma.$queryRaw<
    Array<{
      actual_cost: Decimal
    }>
  >`
    SELECT
      COALESCE(SUM(ABS(rmm.quantity) * rm.cost_per_unit), 0) as actual_cost
    FROM "RawMaterialMovement" rmm
    INNER JOIN "RawMaterial" rm ON rm.id = rmm.raw_material_id
    WHERE rmm.venue_id = ${venueId}
      AND rmm.created_at >= ${startDate}
      AND rmm.created_at <= ${endDate}
      AND rmm.type IN ('USAGE', 'SPOILAGE')
  `

  const expectedTotalCost = new Decimal(expectedData[0]?.expected_cost || 0)
  const actualRevenue = new Decimal(expectedData[0]?.actual_revenue || 0)
  const actualTotalCost = new Decimal(actualCostData[0]?.actual_cost || 0)

  const variance = actualTotalCost.minus(expectedTotalCost)
  const variancePercentage = expectedTotalCost.greaterThan(0) ? variance.div(expectedTotalCost).mul(100) : new Decimal(0)

  const expectedFoodCostPercentage = actualRevenue.greaterThan(0) ? expectedTotalCost.div(actualRevenue).mul(100) : new Decimal(0)
  const actualFoodCostPercentage = actualRevenue.greaterThan(0) ? actualTotalCost.div(actualRevenue).mul(100) : new Decimal(0)

  return {
    period: { startDate, endDate },
    revenue: actualRevenue.toNumber(),
    costs: {
      expected: expectedTotalCost.toNumber(),
      actual: actualTotalCost.toNumber(),
      variance: variance.toNumber(),
      variancePercentage: variancePercentage.toNumber(),
    },
    foodCostPercentages: {
      expected: expectedFoodCostPercentage.toNumber(),
      actual: actualFoodCostPercentage.toNumber(),
      difference: actualFoodCostPercentage.minus(expectedFoodCostPercentage).toNumber(),
    },
    analysis: {
      status: variance.greaterThan(0) ? 'OVER_BUDGET' : variance.lessThan(0) ? 'UNDER_BUDGET' : 'ON_TARGET',
      message: variance.greaterThan(0)
        ? `Actual costs are ${variancePercentage.toFixed(1)}% higher than expected`
        : variance.lessThan(0)
          ? `Actual costs are ${variancePercentage.abs().toFixed(1)}% lower than expected`
          : 'Costs are on target',
    },
  }
}

/**
 * Inventory Valuation Report - Current stock value
 * OPTIMIZED: Added pagination support
 */
export async function getInventoryValuation(
  venueId: string,
  options?: {
    limit?: number
    offset?: number
  },
) {
  const rawMaterials = await prisma.rawMaterial.findMany({
    where: {
      venueId,
      active: true,
    },
    select: {
      id: true,
      name: true,
      sku: true,
      category: true,
      currentStock: true,
      unit: true,
      costPerUnit: true,
      avgCostPerUnit: true,
    },
    ...(options?.limit && { take: options.limit }),
    ...(options?.offset && { skip: options.offset }),
  })

  const materialValues = rawMaterials.map(rm => {
    const currentValue = rm.currentStock.mul(rm.costPerUnit)
    const avgValue = rm.currentStock.mul(rm.avgCostPerUnit)

    return {
      rawMaterialId: rm.id,
      name: rm.name,
      sku: rm.sku,
      category: rm.category,
      currentStock: rm.currentStock.toNumber(),
      unit: rm.unit,
      costPerUnit: rm.costPerUnit.toNumber(),
      avgCostPerUnit: rm.avgCostPerUnit.toNumber(),
      currentValue: currentValue.toNumber(),
      avgValue: avgValue.toNumber(),
    }
  })

  const totalCurrentValue = materialValues.reduce((sum, m) => sum + m.currentValue, 0)
  const totalAvgValue = materialValues.reduce((sum, m) => sum + m.avgValue, 0)

  // Group by category
  const categoryBreakdown = materialValues.reduce(
    (acc, m) => {
      if (!acc[m.category]) {
        acc[m.category] = {
          category: m.category,
          itemCount: 0,
          totalValue: 0,
          percentage: 0,
        }
      }
      acc[m.category].itemCount++
      acc[m.category].totalValue += m.currentValue
      return acc
    },
    {} as Record<string, { category: string; itemCount: number; totalValue: number; percentage: number }>,
  )

  // Calculate percentages
  Object.values(categoryBreakdown).forEach(cat => {
    cat.percentage = totalCurrentValue > 0 ? (cat.totalValue / totalCurrentValue) * 100 : 0
  })

  return {
    asOf: new Date(),
    summary: {
      totalItems: rawMaterials.length,
      totalCurrentValue,
      totalAvgValue,
      valueDifference: totalCurrentValue - totalAvgValue,
    },
    byCategory: Object.values(categoryBreakdown).sort((a, b) => b.totalValue - a.totalValue),
    materials: materialValues.sort((a, b) => b.currentValue - a.currentValue),
    pagination: {
      limit: options?.limit,
      offset: options?.offset,
      hasMore: options?.limit ? materialValues.length === options.limit : false,
    },
  }
}
