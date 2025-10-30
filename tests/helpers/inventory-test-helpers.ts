/**
 * Inventory Test Helpers
 *
 * Helper functions for setting up inventory test data:
 * - Raw materials with FIFO batches
 * - Products with recipes
 * - Orders with inventory-tracked items
 *
 * Used by integration tests to verify inventory deduction flow.
 */

import prisma from '@/utils/prismaClient'
import { Prisma, Unit } from '@prisma/client'

export interface TestInventoryData {
  venue: {
    id: string
    name: string
    slug: string
  }
  staff: {
    id: string
    role: string
  }
  rawMaterials: Array<{
    id: string
    name: string
    currentStock: number
  }>
  batches: Array<{
    id: string
    batchNumber: string
    remainingQuantity: number
  }>
  products: Array<{
    id: string
    name: string
    inventoryMethod: string | null
  }>
  recipes: Array<{
    id: string
    productId: string
  }>
}

/**
 * Create a raw material with initial stock batch
 */
export async function createRawMaterial(
  venueId: string,
  data: {
    name: string
    sku: string
    unit: Unit
    costPerUnit: number
    minimumStock?: number
    reorderPoint?: number
    initialStock?: number
    initialCostPerUnit?: number
  },
) {
  const rawMaterial = await prisma.rawMaterial.create({
    data: {
      venueId,
      name: data.name,
      sku: data.sku,
      unit: data.unit,
      unitType: data.unit === 'KILOGRAM' || data.unit === 'GRAM' ? 'WEIGHT' : 'VOLUME',
      costPerUnit: new Prisma.Decimal(data.costPerUnit),
      avgCostPerUnit: new Prisma.Decimal(data.costPerUnit),
      currentStock: new Prisma.Decimal(data.initialStock || 0),
      minimumStock: new Prisma.Decimal(data.minimumStock || 0),
      reorderPoint: new Prisma.Decimal(data.reorderPoint || 0),
      active: true,
      deletedAt: null,
    },
  })

  // Create initial batch if stock provided
  if (data.initialStock && data.initialStock > 0) {
    await createStockBatch(venueId, rawMaterial.id, {
      quantity: data.initialStock,
      costPerUnit: data.initialCostPerUnit || data.costPerUnit,
      receivedDate: new Date(),
      batchNumber: `BATCH-${Date.now()}-001`,
    })
  }

  return rawMaterial
}

/**
 * Create a FIFO stock batch for a raw material
 */
export async function createStockBatch(
  venueId: string,
  rawMaterialId: string,
  data: {
    quantity: number
    costPerUnit: number
    receivedDate: Date
    batchNumber: string
    expirationDate?: Date
  },
) {
  // Get the raw material to get its unit
  const rawMaterial = await prisma.rawMaterial.findUnique({
    where: { id: rawMaterialId },
    select: { unit: true },
  })

  const batch = await prisma.stockBatch.create({
    data: {
      venueId,
      rawMaterialId,
      batchNumber: data.batchNumber,
      initialQuantity: new Prisma.Decimal(data.quantity),
      remainingQuantity: new Prisma.Decimal(data.quantity),
      costPerUnit: new Prisma.Decimal(data.costPerUnit),
      receivedDate: data.receivedDate,
      expirationDate: data.expirationDate,
      status: 'ACTIVE',
      unit: rawMaterial!.unit, // Add required unit field
    },
  })

  // Update raw material current stock
  await prisma.rawMaterial.update({
    where: { id: rawMaterialId },
    data: {
      currentStock: {
        increment: new Prisma.Decimal(data.quantity),
      },
    },
  })

  // Create movement record
  await prisma.rawMaterialMovement.create({
    data: {
      venueId,
      rawMaterialId,
      batchId: batch.id,
      type: 'PURCHASE',
      quantity: new Prisma.Decimal(data.quantity),
      unit: (await prisma.rawMaterial.findUnique({ where: { id: rawMaterialId }, select: { unit: true } }))!.unit,
      previousStock: new Prisma.Decimal(0), // Simplified for tests
      newStock: new Prisma.Decimal(data.quantity),
      costImpact: new Prisma.Decimal(data.quantity * data.costPerUnit),
      reason: 'Test batch creation',
      reference: `BATCH-${data.batchNumber}`,
    },
  })

  return batch
}

/**
 * Create a product with inventory tracking
 */
export async function createProduct(
  venueId: string,
  categoryId: string,
  data: {
    name: string
    price: number
    sku: string
    inventoryMethod?: 'RECIPE' | 'QUANTITY' | null
    trackInventory?: boolean
  },
) {
  return await prisma.product.create({
    data: {
      venueId,
      categoryId,
      name: data.name,
      sku: data.sku,
      price: new Prisma.Decimal(data.price),
      trackInventory: data.trackInventory ?? true,
      inventoryMethod: data.inventoryMethod,
    },
  })
}

/**
 * Create a recipe for a product
 */
export async function createRecipe(
  venueId: string,
  productId: string,
  data: {
    portionYield: number
    lines: Array<{
      rawMaterialId: string
      quantity: number
      unit: Unit
      isOptional?: boolean
    }>
  },
) {
  // Calculate total cost
  const lineCosts = await Promise.all(
    data.lines.map(async line => {
      const rawMaterial = await prisma.rawMaterial.findUnique({
        where: { id: line.rawMaterialId },
        select: { costPerUnit: true },
      })
      return line.quantity * parseFloat(rawMaterial!.costPerUnit.toString())
    }),
  )
  const totalCost = lineCosts.reduce((sum, cost) => sum + cost, 0)

  const recipe = await prisma.recipe.create({
    data: {
      productId,
      portionYield: data.portionYield,
      totalCost: new Prisma.Decimal(totalCost),
    },
  })

  // Create recipe lines with proper cost calculation
  await Promise.all(
    data.lines.map(async line => {
      const rawMaterial = await prisma.rawMaterial.findUnique({
        where: { id: line.rawMaterialId },
        select: { costPerUnit: true },
      })
      return prisma.recipeLine.create({
        data: {
          recipeId: recipe.id,
          rawMaterialId: line.rawMaterialId,
          quantity: new Prisma.Decimal(line.quantity),
          unit: line.unit,
          isOptional: line.isOptional ?? false,
          costPerServing: new Prisma.Decimal((line.quantity / data.portionYield) * parseFloat(rawMaterial!.costPerUnit.toString())),
        },
      })
    }),
  )

  return recipe
}

/**
 * Create a product with recipe (full setup)
 */
export async function createProductWithRecipe(
  venueId: string,
  categoryId: string,
  data: {
    name: string
    price: number
    sku: string
    ingredients: Array<{
      name: string
      quantity: number
      unit: Unit
      costPerUnit: number
    }>
  },
) {
  // Create raw materials
  const rawMaterials = await Promise.all(
    data.ingredients.map(ing =>
      createRawMaterial(venueId, {
        name: ing.name,
        sku: `${ing.name.toUpperCase()}-001`,
        unit: ing.unit,
        costPerUnit: ing.costPerUnit,
        initialStock: 100, // Default stock
        initialCostPerUnit: ing.costPerUnit,
      }),
    ),
  )

  // Create product
  const product = await createProduct(venueId, categoryId, {
    name: data.name,
    price: data.price,
    sku: data.sku,
    inventoryMethod: 'RECIPE',
    trackInventory: true,
  })

  // Create recipe
  const recipe = await createRecipe(venueId, product.id, {
    portionYield: 1,
    lines: data.ingredients.map((ing, index) => ({
      rawMaterialId: rawMaterials[index].id,
      quantity: ing.quantity,
      unit: ing.unit,
    })),
  })

  return {
    product,
    recipe,
    rawMaterials,
  }
}

/**
 * Create an order with items
 */
export async function createOrder(
  venueId: string,
  staffId: string,
  items: Array<{
    productId: string
    quantity: number
    price?: number
  }>,
) {
  // Calculate total
  const itemsWithPrices = await Promise.all(
    items.map(async item => {
      const product = await prisma.product.findUnique({
        where: { id: item.productId },
        select: { price: true },
      })
      return {
        ...item,
        price: item.price ?? parseFloat(product!.price.toString()),
      }
    }),
  )

  const subtotal = itemsWithPrices.reduce((sum, item) => sum + item.price * item.quantity, 0)
  const taxAmount = subtotal * 0.16 // 16% IVA
  const total = subtotal + taxAmount

  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `TEST-${Date.now()}`,
      total: new Prisma.Decimal(total),
      subtotal: new Prisma.Decimal(subtotal),
      taxAmount: new Prisma.Decimal(taxAmount),
      status: 'PENDING',
      paymentStatus: 'PENDING',
      createdById: staffId,
    },
  })

  // Create order items
  await Promise.all(
    itemsWithPrices.map(item => {
      const itemTax = item.price * item.quantity * 0.16
      const itemTotal = item.price * item.quantity + itemTax
      return prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: new Prisma.Decimal(item.price),
          taxAmount: new Prisma.Decimal(itemTax),
          total: new Prisma.Decimal(itemTotal),
        },
      })
    }),
  )

  return order
}

/**
 * Setup limited stock scenario for concurrency tests
 */
export async function setupLimitedStock(
  venueId: string,
  categoryId: string,
  staffId: string,
  data: {
    productName: string
    stockQuantity: number
    recipeQuantity: number // Quantity per portion
    costPerUnit: number
  },
) {
  const timestamp = Date.now()
  const rawMaterial = await createRawMaterial(venueId, {
    name: `Limited Stock Ingredient ${timestamp}`,
    sku: `LIMITED-${timestamp}`, // Make SKU unique to avoid conflicts
    unit: 'KILOGRAM',
    costPerUnit: data.costPerUnit,
    initialStock: 0, // Will be added via batch
  })

  const batch = await createStockBatch(venueId, rawMaterial.id, {
    quantity: data.stockQuantity,
    costPerUnit: data.costPerUnit,
    receivedDate: new Date('2025-01-01'),
    batchNumber: `BATCH-LIMITED-${Date.now()}`,
  })

  const product = await createProduct(venueId, categoryId, {
    name: data.productName,
    price: 100,
    sku: `PROD-LIMITED-${Date.now()}`, // Make SKU unique
    inventoryMethod: 'RECIPE',
    trackInventory: true,
  })

  const recipe = await createRecipe(venueId, product.id, {
    portionYield: 1,
    lines: [
      {
        rawMaterialId: rawMaterial.id,
        quantity: data.recipeQuantity,
        unit: 'KILOGRAM',
      },
    ],
  })

  return {
    rawMaterial,
    batch,
    product,
    recipe,
    venueId,
    staffId,
  }
}

/**
 * Cleanup inventory test data
 */
export async function cleanupInventoryTestData(venueId: string): Promise<void> {
  // Delete in correct order (reverse of dependencies)
  await prisma.rawMaterialMovement.deleteMany({ where: { venueId } })
  await prisma.stockBatch.deleteMany({ where: { venueId } })
  await prisma.recipeLine.deleteMany({
    where: { recipe: { product: { venueId } } },
  })
  await prisma.recipe.deleteMany({
    where: { product: { venueId } },
  })
  await prisma.rawMaterial.deleteMany({ where: { venueId } })
}
