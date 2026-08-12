import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * 🔴 These queries were WRITTEN IN snake_case (`o.venue_id`, `rmm.raw_material_id`,
 * `rm.cost_per_unit`) against tables whose columns are camelCase. This schema does NOT map
 * names — the only `@@map`s that exist belong to other tables: time_entries, tpv_messages,
 * training_*, mcp_* — so PostgreSQL answered `column does not exist` and the THREE reports
 * in this file (PMIX, ingredient usage and cost variance) blew up on every single call.
 * Verified against the production database on 2026-08-07.
 *
 * Nobody noticed because PMIX and cost variance live behind the premium inventory gate and
 * almost no venue ever opens them.
 *
 * Second defect, in the same place: the conditional fragments (LIMIT, OFFSET, raw material
 * filter) were interpolated as `${cond ? `LIMIT ${n}` : ''}` INSIDE a tagged template. In a
 * tagged template that does NOT concatenate SQL: it sends the text as a PARAMETER, so the
 * query ended up as `ORDER BY ... DESC $4 $5` — a syntax error — and the raw material filter
 * never filtered anything. They are now assembled with `Prisma.sql` and `Prisma.empty`,
 * which is the correct way to compose parameterized SQL.
 *
 * When touching this: camelCase identifiers MUST be double-quoted, or PostgreSQL folds them
 * to lowercase and the same error comes right back.
 */

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
      oi."productId" as product_id,
      p.name as product_name,
      SUM(oi.quantity)::bigint as quantity_sold,
      SUM(oi."unitPrice" * oi.quantity) as total_revenue,
      r."totalCost" as recipe_cost,
      AVG(oi."unitPrice") as avg_price
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi."orderId"
    INNER JOIN "Product" p ON p.id = oi."productId"
    LEFT JOIN "Recipe" r ON r."productId" = p.id
    WHERE o."venueId" = ${venueId}
      AND o."createdAt" >= ${startDate}
      AND o."createdAt" <= ${endDate}
      AND o.status = 'COMPLETED'
    GROUP BY oi."productId", p.name, r."totalCost"
    ORDER BY total_revenue DESC, oi."productId" ASC
    ${options?.limit ? Prisma.sql`LIMIT ${options.limit}` : Prisma.empty}
    ${options?.offset ? Prisma.sql`OFFSET ${options.offset}` : Prisma.empty}
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
      SUM(oi."unitPrice" * oi.quantity) as total_revenue,
      SUM(COALESCE(r."totalCost", 0) * oi.quantity) as total_cost
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi."orderId"
    LEFT JOIN "Recipe" r ON r."productId" = oi."productId"
    WHERE o."venueId" = ${venueId}
      AND o."createdAt" >= ${startDate}
      AND o."createdAt" <= ${endDate}
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
      rmm."rawMaterialId" as raw_material_id,
      rm.name as raw_material_name,
      rm.category,
      rm.unit,
      COALESCE(SUM(CASE WHEN rmm.type = 'PURCHASE' THEN rmm.quantity ELSE 0 END), 0) as purchases,
      COALESCE(SUM(CASE WHEN rmm.type = 'USAGE' THEN ABS(rmm.quantity) ELSE 0 END), 0) as usage,
      COALESCE(SUM(CASE WHEN rmm.type = 'ADJUSTMENT' THEN rmm.quantity ELSE 0 END), 0) as adjustments,
      COALESCE(SUM(CASE WHEN rmm.type = 'SPOILAGE' THEN ABS(rmm.quantity) ELSE 0 END), 0) as waste,
      COALESCE(SUM(rmm.quantity), 0) as net_change,
      COALESCE(SUM(rmm.quantity * rm."costPerUnit"), 0) as total_cost,
      rm."costPerUnit" as avg_cost_per_unit
    FROM "RawMaterialMovement" rmm
    INNER JOIN "RawMaterial" rm ON rm.id = rmm."rawMaterialId"
    WHERE rmm."venueId" = ${venueId}
      AND rmm."createdAt" >= ${startDate}
      AND rmm."createdAt" <= ${endDate}
      ${options?.rawMaterialId ? Prisma.sql`AND rmm."rawMaterialId" = ${options.rawMaterialId}` : Prisma.empty}
    GROUP BY rmm."rawMaterialId", rm.name, rm.category, rm.unit, rm."costPerUnit"
    ORDER BY total_cost DESC, rmm."rawMaterialId" ASC
    ${options?.limit ? Prisma.sql`LIMIT ${options.limit}` : Prisma.empty}
    ${options?.offset ? Prisma.sql`OFFSET ${options.offset}` : Prisma.empty}
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
      COALESCE(SUM(COALESCE(r."totalCost", 0) * oi.quantity), 0) as expected_cost,
      COALESCE(SUM(oi."unitPrice" * oi.quantity), 0) as actual_revenue
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi."orderId"
    LEFT JOIN "Recipe" r ON r."productId" = oi."productId"
    WHERE o."venueId" = ${venueId}
      AND o."createdAt" >= ${startDate}
      AND o."createdAt" <= ${endDate}
      AND o.status = 'COMPLETED'
  `

  // Calculate actual costs from ingredient movements
  const actualCostData = await prisma.$queryRaw<
    Array<{
      actual_cost: Decimal
    }>
  >`
    SELECT
      COALESCE(SUM(ABS(rmm.quantity) * rm."costPerUnit"), 0) as actual_cost
    FROM "RawMaterialMovement" rmm
    INNER JOIN "RawMaterial" rm ON rm.id = rmm."rawMaterialId"
    WHERE rmm."venueId" = ${venueId}
      AND rmm."createdAt" >= ${startDate}
      AND rmm."createdAt" <= ${endDate}
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

/**
 * Days of coverage: at this consumption rate, how many days does the stock on hand last?
 *
 * It is the question a buyer asks before raising a purchase order, and the one that decides
 * whether a reorder point is set right. A version of this already existed, but ONLY for
 * serialized inventory (SIMs) in `stockDashboard.service` — for raw materials and
 * merchandise there was nothing.
 *
 * Decisions that make the number usable instead of merely pretty:
 *
 * - Consumption counts USAGE **and** SPOILAGE. Spoilage is not "good" consumption, but it
 *   DOES empty the warehouse: ignoring it yields optimistic coverage precisely on the goods
 *   that spoil the most, which are the ones that tolerate a stockout the worst.
 * - Zero consumption returns `null`, not infinity nor a giant number. "It hasn't moved" and
 *   "it lasts forever" are different things, and an ∞ sorted in a table sends to the bottom
 *   exactly what needs to be reviewed.
 * - The window is rolling (N days back from now), so it does not depend on the server's
 *   timezone — which in production runs in UTC.
 */
export async function getStockCoverageReport(
  venueId: string,
  options?: {
    /** Days back to average consumption over. Defaults to 30. */
    windowDays?: number
    /** Only materials with coverage at or below this (for "what runs out first?"). */
    maxDays?: number
    limit?: number
  },
) {
  const windowDays = options?.windowDays && options.windowDays > 0 ? Math.floor(options.windowDays) : 30
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  const rows = await prisma.$queryRaw<
    Array<{
      raw_material_id: string
      name: string
      category: string
      unit: string
      current_stock: Decimal
      reorder_point: Decimal | null
      consumed: Decimal
    }>
  >`
    SELECT
      rm.id as raw_material_id,
      rm.name,
      rm.category,
      rm.unit,
      rm."currentStock" as current_stock,
      rm."reorderPoint" as reorder_point,
      COALESCE(SUM(ABS(rmm.quantity)) FILTER (WHERE rmm.type IN ('USAGE', 'SPOILAGE')), 0) as consumed
    FROM "RawMaterial" rm
    LEFT JOIN "RawMaterialMovement" rmm
      ON rmm."rawMaterialId" = rm.id
      AND rmm."venueId" = ${venueId}
      AND rmm."createdAt" >= ${since}
    WHERE rm."venueId" = ${venueId}
      AND rm.active = true
    GROUP BY rm.id, rm.name, rm.category, rm.unit, rm."currentStock", rm."reorderPoint"
    ORDER BY rm.name ASC, rm.id ASC
  `

  const materials = rows
    .map(row => {
      const totalConsumed = new Decimal(row.consumed)
      const dailyConsumption = totalConsumed.div(windowDays)
      const stockOnHand = new Decimal(row.current_stock)
      // Zero consumption ⇒ no data, not "it lasts forever".
      const coverage = dailyConsumption.greaterThan(0) ? stockOnHand.div(dailyConsumption).toDecimalPlaces(1).toNumber() : null
      const reorderPoint = row.reorder_point === null ? null : new Decimal(row.reorder_point)

      return {
        rawMaterialId: row.raw_material_id,
        name: row.name,
        category: row.category,
        unit: row.unit,
        currentStock: stockOnHand.toNumber(),
        reorderPoint: reorderPoint ? reorderPoint.toNumber() : null,
        consumedInWindow: totalConsumed.toNumber(),
        avgDailyConsumption: dailyConsumption.toDecimalPlaces(3).toNumber(),
        daysOfCoverage: coverage,
        belowReorderPoint: reorderPoint ? stockOnHand.lessThanOrEqualTo(reorderPoint) : false,
      }
    })
    .filter(m => (options?.maxDays === undefined ? true : m.daysOfCoverage !== null && m.daysOfCoverage <= options.maxDays))

  // The ones that DO have data, from tightest to roomiest; the ones with no movement go last,
  // because they are not urgent but they must not be hidden either.
  materials.sort((a, b) => {
    if (a.daysOfCoverage === null && b.daysOfCoverage === null) return a.name.localeCompare(b.name)
    if (a.daysOfCoverage === null) return 1
    if (b.daysOfCoverage === null) return -1
    return a.daysOfCoverage - b.daysOfCoverage
  })

  const withData = materials.filter(m => m.daysOfCoverage !== null)

  return {
    windowDays,
    asOf: new Date(),
    summary: {
      totalMaterials: materials.length,
      withoutMovement: materials.length - withData.length,
      belowReorderPoint: materials.filter(m => m.belowReorderPoint).length,
      /** Median coverage: summarizes better than the average, which a single material skews. */
      medianDaysOfCoverage: withData.length > 0 ? withData[Math.floor(withData.length / 2)].daysOfCoverage : null,
    },
    materials: options?.limit ? materials.slice(0, options.limit) : materials,
  }
}
