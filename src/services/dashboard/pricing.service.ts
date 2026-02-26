import { PricingPolicy, PricingStrategy } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import { CreatePricingPolicyDto, UpdatePricingPolicyDto } from '../../schemas/dashboard/inventory.schema'
import { Decimal } from '@prisma/client/runtime/library'
import { logAction } from './activity-log.service'

/**
 * Get pricing policy for a product
 */
export async function getPricingPolicy(venueId: string, productId: string) {
  const policy = await prisma.pricingPolicy.findUnique({
    where: { productId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          price: true,
          venueId: true,
        },
      },
    },
  })

  if (policy && policy.product.venueId !== venueId) {
    throw new AppError('Pricing policy not found', 404)
  }

  return policy
}

/**
 * Calculate suggested price based on strategy
 */
function calculateSuggestedPrice(
  recipeCost: Decimal,
  strategy: PricingStrategy,
  targetFoodCostPercentage?: Decimal | null,
  targetMarkupPercentage?: Decimal | null,
): Decimal {
  if (strategy === PricingStrategy.MANUAL) {
    return new Decimal(0) // No auto-calculation
  }

  if (strategy === PricingStrategy.AUTO_TARGET_MARGIN) {
    if (!targetFoodCostPercentage) {
      throw new AppError('Target food cost percentage is required for AUTO_TARGET_MARGIN strategy', 400)
    }
    // Price = Cost / (Target Food Cost %)
    // Example: Cost = $5, Target = 30% → Price = $5 / 0.30 = $16.67
    const targetDecimal = targetFoodCostPercentage.div(100)
    return recipeCost.div(targetDecimal)
  }

  if (strategy === PricingStrategy.AUTO_MARKUP) {
    if (!targetMarkupPercentage) {
      throw new AppError('Target markup percentage is required for AUTO_MARKUP strategy', 400)
    }
    // Price = Cost × (1 + Markup %)
    // Example: Cost = $5, Markup = 50% → Price = $5 × 1.50 = $7.50
    const markupDecimal = targetMarkupPercentage.div(100).add(1)
    return recipeCost.mul(markupDecimal)
  }

  return new Decimal(0)
}

/**
 * Calculate food cost percentage
 */
function calculateFoodCostPercentage(recipeCost: Decimal, salePrice: Decimal): Decimal {
  if (salePrice.equals(0)) return new Decimal(0)
  // Food Cost % = (Cost / Price) × 100
  return recipeCost.div(salePrice).mul(100)
}

/**
 * Create a pricing policy for a product
 */
export async function createPricingPolicy(venueId: string, productId: string, data: CreatePricingPolicyDto): Promise<PricingPolicy> {
  // Verify product exists and belongs to venue
  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      venueId,
    },
    include: {
      recipe: {
        select: {
          totalCost: true,
        },
      },
    },
  })

  if (!product) {
    throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
  }

  if (!product.recipe) {
    throw new AppError(`Product ${product.name} does not have a recipe. Create a recipe first.`, 400)
  }

  // Check if policy already exists
  const existingPolicy = await prisma.pricingPolicy.findUnique({
    where: { productId },
  })

  if (existingPolicy) {
    throw new AppError(`Pricing policy already exists for product ${product.name}`, 400)
  }

  const recipeCost = product.recipe.totalCost
  const suggestedPrice = calculateSuggestedPrice(
    recipeCost,
    data.pricingStrategy,
    data.targetFoodCostPercentage ? new Decimal(data.targetFoodCostPercentage) : null,
    data.targetMarkupPercentage ? new Decimal(data.targetMarkupPercentage) : null,
  )

  const currentPrice = product.price
  const foodCostPercentage = calculateFoodCostPercentage(recipeCost, currentPrice)

  const policy = await prisma.pricingPolicy.create({
    data: {
      venueId,
      productId,
      pricingStrategy: data.pricingStrategy,
      targetFoodCostPercentage: data.targetFoodCostPercentage,
      targetMarkupPercentage: data.targetMarkupPercentage,
      calculatedCost: recipeCost,
      suggestedPrice: data.pricingStrategy !== PricingStrategy.MANUAL ? suggestedPrice : null,
      minimumPrice: data.minimumPrice,
      currentPrice,
      foodCostPercentage,
    },
    include: {
      product: true,
    },
  })

  logAction({
    venueId,
    action: 'PRICING_POLICY_CREATED',
    entity: 'PricingPolicy',
    entityId: policy.id,
  })

  return policy as any
}

/**
 * Update a pricing policy
 */
export async function updatePricingPolicy(venueId: string, productId: string, data: UpdatePricingPolicyDto): Promise<PricingPolicy> {
  const existingPolicy = await prisma.pricingPolicy.findUnique({
    where: { productId },
    include: {
      product: {
        include: {
          recipe: {
            select: {
              totalCost: true,
            },
          },
        },
      },
    },
  })

  if (!existingPolicy || existingPolicy.product.venueId !== venueId) {
    throw new AppError(`Pricing policy not found for product ${productId}`, 404)
  }

  if (!existingPolicy.product.recipe) {
    throw new AppError(`Product does not have a recipe`, 400)
  }

  const recipeCost = existingPolicy.product.recipe.totalCost
  const strategy = data.pricingStrategy || existingPolicy.pricingStrategy

  let suggestedPrice = existingPolicy.suggestedPrice

  if (data.pricingStrategy || data.targetFoodCostPercentage !== undefined || data.targetMarkupPercentage !== undefined) {
    suggestedPrice = calculateSuggestedPrice(
      recipeCost,
      strategy,
      data.targetFoodCostPercentage !== undefined
        ? data.targetFoodCostPercentage
          ? new Decimal(data.targetFoodCostPercentage)
          : null
        : existingPolicy.targetFoodCostPercentage,
      data.targetMarkupPercentage !== undefined
        ? data.targetMarkupPercentage
          ? new Decimal(data.targetMarkupPercentage)
          : null
        : existingPolicy.targetMarkupPercentage,
    )
  }

  const currentPrice = data.currentPrice !== undefined ? new Decimal(data.currentPrice) : existingPolicy.currentPrice
  const foodCostPercentage = calculateFoodCostPercentage(recipeCost, currentPrice)

  const policy = await prisma.pricingPolicy.update({
    where: { id: existingPolicy.id },
    data: {
      pricingStrategy: data.pricingStrategy,
      targetFoodCostPercentage: data.targetFoodCostPercentage,
      targetMarkupPercentage: data.targetMarkupPercentage,
      calculatedCost: recipeCost,
      suggestedPrice: strategy !== PricingStrategy.MANUAL ? suggestedPrice : null,
      minimumPrice: data.minimumPrice,
      currentPrice,
      foodCostPercentage,
      lastReviewedAt: new Date(),
    },
    include: {
      product: true,
    },
  })

  logAction({
    venueId,
    action: 'PRICING_POLICY_UPDATED',
    entity: 'PricingPolicy',
    entityId: policy.id,
  })

  return policy as any
}

/**
 * Calculate suggested price for a product (preview without saving)
 */
export async function calculatePrice(venueId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      venueId,
    },
    include: {
      recipe: {
        select: {
          totalCost: true,
        },
      },
      pricingPolicy: true,
    },
  })

  if (!product) {
    throw new AppError(`Product not found`, 404)
  }

  if (!product.recipe) {
    throw new AppError(`Product ${product.name} does not have a recipe`, 400)
  }

  if (!product.pricingPolicy) {
    throw new AppError(`Product ${product.name} does not have a pricing policy`, 400)
  }

  const policy = product.pricingPolicy
  const recipeCost = product.recipe.totalCost

  const suggestedPrice = calculateSuggestedPrice(
    recipeCost,
    policy.pricingStrategy,
    policy.targetFoodCostPercentage,
    policy.targetMarkupPercentage,
  )

  const currentPrice = product.price
  const currentFoodCostPercentage = calculateFoodCostPercentage(recipeCost, currentPrice)
  const suggestedFoodCostPercentage = calculateFoodCostPercentage(recipeCost, suggestedPrice)

  // Calculate markup
  const currentMarkup = currentPrice.minus(recipeCost).div(recipeCost).mul(100)
  const suggestedMarkup = suggestedPrice.minus(recipeCost).div(recipeCost).mul(100)

  // Calculate contribution (profit per unit)
  const currentContribution = currentPrice.minus(recipeCost)
  const suggestedContribution = suggestedPrice.minus(recipeCost)

  return {
    productId: product.id,
    productName: product.name,
    recipeCost: recipeCost.toNumber(),
    currentPrice: currentPrice.toNumber(),
    suggestedPrice: suggestedPrice.toNumber(),
    minimumPrice: policy.minimumPrice?.toNumber() || null,
    pricingStrategy: policy.pricingStrategy,
    targetFoodCostPercentage: policy.targetFoodCostPercentage?.toNumber() || null,
    targetMarkupPercentage: policy.targetMarkupPercentage?.toNumber() || null,
    currentMetrics: {
      foodCostPercentage: currentFoodCostPercentage.toNumber(),
      markupPercentage: currentMarkup.toNumber(),
      contribution: currentContribution.toNumber(),
    },
    suggestedMetrics: {
      foodCostPercentage: suggestedFoodCostPercentage.toNumber(),
      markupPercentage: suggestedMarkup.toNumber(),
      contribution: suggestedContribution.toNumber(),
    },
    recommendation: suggestedPrice.greaterThan(currentPrice) ? 'INCREASE' : suggestedPrice.lessThan(currentPrice) ? 'DECREASE' : 'MAINTAIN',
    priceChange: suggestedPrice.minus(currentPrice).toNumber(),
    priceChangePercentage: suggestedPrice.minus(currentPrice).div(currentPrice).mul(100).toNumber(),
  }
}

/**
 * Apply suggested price to product
 */
export async function applySuggestedPrice(venueId: string, productId: string, staffId?: string) {
  const calculation = await calculatePrice(venueId, productId)

  if (calculation.minimumPrice && calculation.suggestedPrice < calculation.minimumPrice) {
    throw new AppError(`Suggested price ${calculation.suggestedPrice} is below minimum price ${calculation.minimumPrice}`, 400)
  }

  // Update product price and pricing policy
  await prisma.$transaction([
    prisma.product.update({
      where: { id: productId },
      data: { price: calculation.suggestedPrice },
    }),
    prisma.pricingPolicy.update({
      where: { productId },
      data: {
        currentPrice: calculation.suggestedPrice,
        foodCostPercentage: calculation.suggestedMetrics.foodCostPercentage,
        lastReviewedAt: new Date(),
        lastUpdatedBy: staffId,
      },
    }),
  ])

  return calculation
}

/**
 * Get all products with pricing analysis
 */
export async function getPricingAnalysis(venueId: string, options?: { categoryId?: string }) {
  const products = await prisma.product.findMany({
    where: {
      venueId,
      ...(options?.categoryId && { categoryId: options.categoryId }),
    },
    include: {
      recipe: {
        select: {
          totalCost: true,
        },
      },
      pricingPolicy: true,
      category: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  })

  return products.map(product => {
    if (!product.recipe || !product.pricingPolicy) {
      return {
        productId: product.id,
        productName: product.name,
        categoryName: product.category.name,
        hasRecipe: !!product.recipe,
        hasPricingPolicy: !!product.pricingPolicy,
        currentPrice: product.price.toNumber(),
      }
    }

    const recipeCost = product.recipe.totalCost
    const currentPrice = product.price
    const foodCostPercentage = calculateFoodCostPercentage(recipeCost, currentPrice)
    const markup = currentPrice.minus(recipeCost).div(recipeCost).mul(100)
    const contribution = currentPrice.minus(recipeCost)

    return {
      productId: product.id,
      productName: product.name,
      categoryName: product.category.name,
      hasRecipe: true,
      hasPricingPolicy: true,
      currentPrice: currentPrice.toNumber(),
      recipeCost: recipeCost.toNumber(),
      foodCostPercentage: foodCostPercentage.toNumber(),
      markupPercentage: markup.toNumber(),
      contribution: contribution.toNumber(),
      pricingStrategy: product.pricingPolicy.pricingStrategy,
      targetFoodCostPercentage: product.pricingPolicy.targetFoodCostPercentage?.toNumber() || null,
      isUnderTarget:
        product.pricingPolicy.targetFoodCostPercentage && foodCostPercentage.greaterThan(product.pricingPolicy.targetFoodCostPercentage),
      profitabilityStatus: foodCostPercentage.lessThan(20)
        ? 'EXCELLENT'
        : foodCostPercentage.lessThan(30)
          ? 'GOOD'
          : foodCostPercentage.lessThan(40)
            ? 'ACCEPTABLE'
            : 'POOR',
    }
  })
}
