/**
 * Demo Seed Service
 *
 * Seeds a demo venue with realistic sample data:
 * - Menu categories and products
 * - Sample orders (last 7 days)
 * - Tables and areas
 * - Demo staff
 *
 * This provides a great UX for users exploring the platform.
 */

import {
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  ProviderType,
  RawMaterialCategory,
  Unit,
  UnitType,
  ReviewSource,
  MenuType,
  InventoryMethod,
  BatchStatus,
  RawMaterialMovementType,
} from '@prisma/client'
import { subDays, subHours } from 'date-fns'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

/**
 * Seeds a venue with demo data
 *
 * @param venueId - Venue ID to seed
 * @returns Object with categoriesCreated and productsCreated counts
 */
export async function seedDemoVenue(venueId: string): Promise<{ categoriesCreated: number; productsCreated: number }> {
  logger.info(`🎬 Seeding demo data for venue: ${venueId}`)

  // 1. Create payment providers and merchant accounts (for multi-merchant support)
  const merchantAccounts = await seedPaymentProvidersAndMerchants(venueId)
  logger.info(`✅ Created ${merchantAccounts.length} merchant accounts`)

  // 2. Create main menu
  const menu = await seedMenu(venueId)
  logger.info(`✅ Created menu: ${menu.name}`)

  // 3. Create menu categories
  const categories = await seedMenuCategories(venueId)
  logger.info(`✅ Created ${categories.length} menu categories`)

  // 4. Link categories to menu
  await linkCategoriesToMenu(menu.id, categories)
  logger.info(`✅ Linked ${categories.length} categories to menu`)

  // 5. Create products
  const products = await seedProducts(venueId, categories)
  logger.info(`✅ Created ${products.length} products`)

  // 6. Create product inventory (QUANTITY type for some products)
  const inventories = await seedProductInventory(venueId, products)
  logger.info(`✅ Created ${inventories.length} product inventories`)

  // 7. Create modifier groups and modifiers
  const modifierGroups = await seedModifierGroups(venueId, products)
  logger.info(`✅ Created ${modifierGroups.length} modifier groups`)

  // 8. Create raw materials (ingredients)
  const rawMaterials = await seedRawMaterials(venueId)
  logger.info(`✅ Created ${rawMaterials.length} raw materials`)

  // 8.5. Link modifiers to raw materials for inventory tracking (Toast/Square pattern)
  await linkModifiersToRawMaterials(venueId, modifierGroups, rawMaterials)
  logger.info(`✅ Linked modifiers to raw materials for inventory tracking`)

  // 9. Create recipes (link products to ingredients, with variable ingredients for modifiers)
  const recipes = await seedRecipes(venueId, products, rawMaterials, modifierGroups)
  logger.info(`✅ Created ${recipes.length} recipes`)

  // 10. Create areas and tables
  const tables = await seedTablesAndAreas(venueId)
  logger.info(`✅ Created ${tables.length} tables`)

  // 11. Create loyalty config for the venue
  const loyaltyConfig = await seedLoyaltyConfig(venueId)
  logger.info(`✅ Created loyalty config: ${loyaltyConfig.pointsPerDollar} points/dollar`)

  // 12. Create customer groups
  const customerGroups = await seedCustomerGroups(venueId)
  logger.info(`✅ Created ${customerGroups.length} customer groups`)

  // 13. Create sample customers
  const customers = await seedCustomers(venueId, customerGroups)
  logger.info(`✅ Created ${customers.length} sample customers`)

  // 14. Create sample orders with tips and reviews (last 7 days)
  const productsForOrders = products.map(p => ({ id: p.id, name: p.name, price: Number(p.price) }))
  const { orders, reviews } = await seedOrders(venueId, productsForOrders, tables, merchantAccounts, customers)
  logger.info(`✅ Created ${orders.length} sample orders with ${reviews.length} reviews`)

  logger.info(`🎉 Demo venue seeded successfully!`)

  return {
    categoriesCreated: categories.length,
    productsCreated: products.length,
  }
}

/**
 * Seeds payment providers and merchant accounts for demo venue
 * Creates merchant accounts to demonstrate multi-merchant support:
 * - Stripe for online payments
 * - Blumon for physical TPV
 */
async function seedPaymentProvidersAndMerchants(venueId: string) {
  // Check if Menta provider exists (used as fallback for Stripe)
  let mentaProvider = await prisma.paymentProvider.findFirst({
    where: { code: 'MENTA' },
  })

  if (!mentaProvider) {
    mentaProvider = await prisma.paymentProvider.create({
      data: {
        code: 'MENTA',
        name: 'Menta Payment Solutions',
        type: ProviderType.PAYMENT_PROCESSOR,
        countryCode: ['MX'],
        active: true,
        configSchema: {
          required: ['acquirerId', 'merchantId'],
          properties: {
            acquirerId: { type: 'string', description: 'Acquirer identifier' },
            merchantId: { type: 'string', description: 'Merchant identifier' },
          },
        },
      },
    })
  }

  // Check if Blumon provider exists, if not create it
  let blumonProvider = await prisma.paymentProvider.findFirst({
    where: { code: 'BLUMON' },
  })

  if (!blumonProvider) {
    blumonProvider = await prisma.paymentProvider.create({
      data: {
        code: 'BLUMON',
        name: 'Blumon PAX Payment Solutions',
        type: ProviderType.PAYMENT_PROCESSOR,
        countryCode: ['MX'],
        active: true,
        configSchema: {
          required: ['serialNumber', 'posId', 'environment'],
          properties: {
            serialNumber: { type: 'string', description: 'Terminal serial number' },
            posId: { type: 'string', description: 'POS identifier' },
            environment: { type: 'string', description: 'SANDBOX or PRODUCTION' },
          },
        },
      },
    })
  }

  // 1. Create Stripe merchant account (for online payments)
  const stripeMerchant = await prisma.merchantAccount.create({
    data: {
      providerId: mentaProvider.id, // Using Menta provider as fallback
      externalMerchantId: `acct_stripe_demo_${venueId.substring(0, 8)}`,
      alias: 'Stripe Gateway Account',
      displayName: 'Cuenta Stripe (Online)',
      active: true,
      displayOrder: 0,
      bankName: 'Stripe Mexico',
      clabeNumber: '646180157000000004', // STP CLABE for Stripe
      accountHolder: 'Demo Restaurant Online S.A.',
      credentialsEncrypted: {
        publishableKey: `pk_test_demo_${venueId.substring(0, 8)}`,
        secretKey: `sk_test_demo_${venueId.substring(0, 8)}`,
        webhookSecret: `whsec_demo_${venueId.substring(0, 8)}`,
      },
      providerConfig: {
        countryCode: 'MX',
        currencyCode: 'MXN',
        paymentMethods: ['card', 'oxxo', 'spei'],
      },
    },
  })

  // 2. Create Blumon merchant account (for physical TPV)
  const blumonMerchant = await prisma.merchantAccount.create({
    data: {
      providerId: blumonProvider.id,
      externalMerchantId: `blumon_demo_${venueId.substring(0, 8)}`,
      alias: 'Blumon TPV Account',
      displayName: 'Cuenta Blumon TPV',
      active: true,
      displayOrder: 1,
      blumonSerialNumber: `DEMO${venueId.substring(0, 8)}`, // Demo serial number
      blumonPosId: '999',
      blumonEnvironment: 'SANDBOX',
      blumonMerchantId: `blumon_demo_${venueId.substring(0, 8)}`,
      credentialsEncrypted: {
        clientId: `demo_client_id_${venueId.substring(0, 8)}`,
        clientSecret: `demo_client_secret_${venueId.substring(0, 8)}`,
        serialNumber: `DEMO${venueId.substring(0, 8)}`,
        environment: 'SANDBOX',
      },
      providerConfig: {
        serialNumber: `DEMO${venueId.substring(0, 8)}`,
        posId: '999',
        environment: 'SANDBOX',
        brand: 'PAX',
        model: 'A910S',
      },
    },
  })

  return [stripeMerchant, blumonMerchant]
}

/**
 * Seeds the main menu
 */
async function seedMenu(venueId: string) {
  const menu = await prisma.menu.create({
    data: {
      venueId,
      name: 'Menú Principal',
      description: 'Menú completo del restaurante',
      type: MenuType.REGULAR,
      isDefault: true,
      active: true,
      displayOrder: 1,
    },
  })

  return menu
}

/**
 * Links categories to menu via MenuCategoryAssignment
 */
async function linkCategoriesToMenu(menuId: string, categories: Array<{ id: string; displayOrder: number }>) {
  for (const category of categories) {
    await prisma.menuCategoryAssignment.create({
      data: {
        menuId,
        categoryId: category.id,
        displayOrder: category.displayOrder,
      },
    })
  }
}

/**
 * Seeds menu categories
 */
async function seedMenuCategories(venueId: string) {
  const categories = [
    {
      name: 'Bebidas Calientes',
      slug: 'bebidas-calientes',
      description: 'Café, té y chocolate',
      displayOrder: 1,
    },
    {
      name: 'Bebidas Frías',
      slug: 'bebidas-frias',
      description: 'Smoothies, jugos y frapés',
      displayOrder: 2,
    },
    {
      name: 'Alimentos',
      slug: 'alimentos',
      description: 'Sandwiches, ensaladas y postres',
      displayOrder: 3,
    },
    {
      name: 'Repostería',
      slug: 'reposteria',
      description: 'Pasteles, galletas y panes',
      displayOrder: 4,
    },
  ]

  const createdCategories = []
  for (const category of categories) {
    const createdCategory = await prisma.menuCategory.create({
      data: {
        venueId,
        ...category,
        active: true,
      },
    })
    createdCategories.push(createdCategory)
  }

  return createdCategories
}

/**
 * Seeds products
 */
async function seedProducts(venueId: string, categories: Array<{ id: string; slug: string }>) {
  // Find category IDs
  const bebidasCalientes = categories.find(c => c.slug === 'bebidas-calientes')!
  const bebidasFrias = categories.find(c => c.slug === 'bebidas-frias')!
  const alimentos = categories.find(c => c.slug === 'alimentos')!
  const reposteria = categories.find(c => c.slug === 'reposteria')!

  const products = [
    // Bebidas Calientes
    {
      categoryId: bebidasCalientes.id,
      name: 'Café Americano',
      sku: 'BEB-001',
      description: 'Café negro tradicional',
      price: 35.0,
      type: 'BEVERAGE',
    },
    {
      categoryId: bebidasCalientes.id,
      name: 'Cappuccino',
      sku: 'BEB-002',
      description: 'Espresso con leche espumada',
      price: 45.0,
      type: 'BEVERAGE',
    },
    {
      categoryId: bebidasCalientes.id,
      name: 'Latte',
      sku: 'BEB-003',
      description: 'Espresso con leche vaporizada',
      price: 48.0,
      type: 'BEVERAGE',
    },
    {
      categoryId: bebidasCalientes.id,
      name: 'Chocolate Caliente',
      sku: 'BEB-004',
      description: 'Chocolate belga con leche',
      price: 42.0,
      type: 'BEVERAGE',
    },

    // Bebidas Frías
    {
      categoryId: bebidasFrias.id,
      name: 'Frappé de Caramelo',
      sku: 'BEB-005',
      description: 'Café frío con caramelo y crema',
      price: 55.0,
      type: 'BEVERAGE',
    },
    {
      categoryId: bebidasFrias.id,
      name: 'Smoothie de Fresa',
      sku: 'BEB-006',
      description: 'Smoothie natural de fresa',
      price: 50.0,
      type: 'BEVERAGE',
    },
    {
      categoryId: bebidasFrias.id,
      name: 'Jugo Naranja',
      sku: 'BEB-007',
      description: 'Jugo de naranja natural',
      price: 38.0,
      type: 'BEVERAGE',
    },

    // Alimentos
    {
      categoryId: alimentos.id,
      name: 'Sandwich Club',
      sku: 'ALI-001',
      description: 'Pechuga de pollo, tocino, lechuga y aguacate',
      price: 85.0,
      type: 'FOOD',
    },
    {
      categoryId: alimentos.id,
      name: 'Ensalada César',
      sku: 'ALI-002',
      description: 'Lechuga romana, crutones, parmesano',
      price: 75.0,
      type: 'FOOD',
    },
    {
      categoryId: alimentos.id,
      name: 'Wrap Vegetariano',
      sku: 'ALI-003',
      description: 'Tortilla con verduras asadas y hummus',
      price: 70.0,
      type: 'FOOD',
    },

    // Repostería
    {
      categoryId: reposteria.id,
      name: 'Croissant',
      sku: 'REP-001',
      description: 'Croissant de mantequilla artesanal',
      price: 30.0,
      type: 'FOOD',
    },
    {
      categoryId: reposteria.id,
      name: 'Muffin Chocolate',
      sku: 'REP-002',
      description: 'Muffin con chispas de chocolate',
      price: 35.0,
      type: 'FOOD',
    },
    {
      categoryId: reposteria.id,
      name: 'Cheesecake',
      sku: 'REP-003',
      description: 'Pastel de queso con frutos rojos',
      price: 55.0,
      type: 'FOOD',
    },
  ]

  const createdProducts = []
  for (const product of products) {
    const createdProduct = await prisma.product.create({
      data: {
        venueId,
        categoryId: product.categoryId,
        name: product.name,
        sku: product.sku,
        description: product.description,
        price: product.price,
        type: product.type as any,
        active: true,
      },
    })
    createdProducts.push(createdProduct)
  }

  return createdProducts
}

/**
 * Seeds product inventory (QUANTITY type)
 * Creates inventory records for products that use simple quantity tracking
 */
async function seedProductInventory(venueId: string, products: Array<{ id: string; name: string }>) {
  const inventories = []

  // Products with QUANTITY inventory (simple stock tracking)
  const inventoryProducts = [
    { name: 'Croissant', currentStock: 40, minimumStock: 10, maximumStock: 60 },
    { name: 'Muffin Chocolate', currentStock: 35, minimumStock: 10, maximumStock: 50 },
    { name: 'Cheesecake', currentStock: 8, minimumStock: 3, maximumStock: 15 },
    { name: 'Wrap Vegetariano', currentStock: 15, minimumStock: 5, maximumStock: 25 },
    { name: 'Frappé de Caramelo', currentStock: 0, minimumStock: 0, maximumStock: 0 }, // Made to order
    { name: 'Café Americano', currentStock: 0, minimumStock: 0, maximumStock: 0 }, // Made to order
    { name: 'Chocolate Caliente', currentStock: 0, minimumStock: 0, maximumStock: 0 }, // Made to order
  ]

  for (const invProduct of inventoryProducts) {
    const product = products.find(p => p.name === invProduct.name)
    if (!product) continue

    // Create inventory record
    const inventory = await prisma.inventory.create({
      data: {
        venueId,
        productId: product.id,
        currentStock: invProduct.currentStock,
        minimumStock: invProduct.minimumStock,
        maximumStock: invProduct.maximumStock,
        reservedStock: 0,
      },
    })

    // Update product to use QUANTITY inventory method
    await prisma.product.update({
      where: { id: product.id },
      data: {
        inventoryMethod: InventoryMethod.QUANTITY,
        unit: Unit.UNIT, // Default unit for quantity tracking
      },
    })

    inventories.push(inventory)
  }

  return inventories
}

/**
 * Seeds modifier groups and modifiers
 */
async function seedModifierGroups(venueId: string, products: Array<{ id: string; name: string }>) {
  // Find coffee products to add milk modifier group
  const coffeeProducts = products.filter(p => p.name.includes('Café') || p.name.includes('Cappuccino') || p.name.includes('Latte'))

  if (coffeeProducts.length === 0) {
    return []
  }

  // Create "Leche" (Milk) modifier group
  const milkGroup = await prisma.modifierGroup.create({
    data: {
      venueId,
      name: 'Tipo de Leche',
      description: 'Selecciona el tipo de leche para tu bebida',
      minSelections: 0,
      maxSelections: 1,
      active: true,
    },
  })

  // Create modifiers for milk group
  const milkModifiers = [
    {
      name: 'Leche Normal',
      description: 'Leche entera tradicional',
      price: 0.0,
      displayOrder: 1,
    },
    {
      name: 'Leche Light',
      description: 'Leche baja en grasa',
      price: 5.0,
      displayOrder: 2,
    },
    {
      name: 'Leche de Almendra',
      description: 'Alternativa vegana de almendra',
      price: 10.0,
      displayOrder: 3,
    },
  ]

  for (const modifier of milkModifiers) {
    await prisma.modifier.create({
      data: {
        groupId: milkGroup.id,
        name: modifier.name,
        price: modifier.price,
      },
    })
  }

  // Link modifier group to coffee products
  for (const product of coffeeProducts) {
    await prisma.productModifierGroup.create({
      data: {
        productId: product.id,
        groupId: milkGroup.id,
      },
    })
  }

  return [milkGroup]
}

/**
 * ✅ WORLD-CLASS: Links modifiers to raw materials for inventory tracking (Toast/Square pattern)
 * This enables automatic stock deduction when modifiers are selected
 */
async function linkModifiersToRawMaterials(
  venueId: string,
  modifierGroups: Array<{ id: string; name: string }>,
  rawMaterials: Array<{ id: string; name: string }>,
) {
  // Find the milk modifier group
  const milkGroup = modifierGroups.find(g => g.name === 'Tipo de Leche')
  if (!milkGroup) return

  // Get all modifiers in the milk group
  const modifiers = await prisma.modifier.findMany({
    where: { groupId: milkGroup.id },
  })

  // Map modifier names to raw material names
  const modifierToRawMaterial: Record<string, { rawMaterialName: string; quantityPerUnit: number }> = {
    'Leche Normal': { rawMaterialName: 'Leche Entera', quantityPerUnit: 0.15 }, // 150ml per serving
    'Leche Light': { rawMaterialName: 'Leche Light', quantityPerUnit: 0.15 },
    'Leche de Almendra': { rawMaterialName: 'Leche de Almendra', quantityPerUnit: 0.15 },
  }

  for (const modifier of modifiers) {
    const mapping = modifierToRawMaterial[modifier.name]
    if (!mapping) continue

    const rawMaterial = rawMaterials.find(rm => rm.name === mapping.rawMaterialName)
    if (!rawMaterial) continue

    // Calculate cost: avgCostPerUnit × quantityPerUnit
    const rawMaterialData = await prisma.rawMaterial.findUnique({
      where: { id: rawMaterial.id },
      select: { avgCostPerUnit: true },
    })

    const cost = rawMaterialData ? rawMaterialData.avgCostPerUnit.mul(mapping.quantityPerUnit).toNumber() : 0

    // Update modifier with inventory tracking
    await prisma.modifier.update({
      where: { id: modifier.id },
      data: {
        rawMaterialId: rawMaterial.id,
        quantityPerUnit: mapping.quantityPerUnit,
        unit: 'LITER',
        inventoryMode: 'SUBSTITUTION', // These modifiers SUBSTITUTE the recipe's milk
        cost,
      },
    })
  }

  logger.info(`✅ Linked ${modifiers.length} milk modifiers to raw materials for inventory tracking`)
}

/**
 * Seeds raw materials (ingredients)
 */
async function seedRawMaterials(venueId: string) {
  const materials = [
    // Dairy
    {
      name: 'Leche Entera',
      sku: 'RM-001',
      category: RawMaterialCategory.DAIRY,
      currentStock: 50,
      unit: Unit.LITER,
      unitType: UnitType.VOLUME,
      minimumStock: 10,
      reorderPoint: 15,
      costPerUnit: 22.5, // $22.50 per liter
      avgCostPerUnit: 22.5,
    },
    {
      name: 'Leche Light',
      sku: 'RM-001B',
      category: RawMaterialCategory.DAIRY,
      currentStock: 30,
      unit: Unit.LITER,
      unitType: UnitType.VOLUME,
      minimumStock: 5,
      reorderPoint: 10,
      costPerUnit: 20.0, // $20 per liter (slightly cheaper)
      avgCostPerUnit: 20.0,
    },
    {
      name: 'Leche de Almendra',
      sku: 'RM-001C',
      category: RawMaterialCategory.DAIRY,
      currentStock: 20,
      unit: Unit.LITER,
      unitType: UnitType.VOLUME,
      minimumStock: 5,
      reorderPoint: 8,
      costPerUnit: 45.0, // $45 per liter (premium)
      avgCostPerUnit: 45.0,
    },
    {
      name: 'Queso Manchego',
      sku: 'RM-002',
      category: RawMaterialCategory.CHEESE,
      currentStock: 5,
      unit: Unit.KILOGRAM,
      unitType: UnitType.WEIGHT,
      minimumStock: 1,
      reorderPoint: 2,
      costPerUnit: 180.0, // $180 per kg
      avgCostPerUnit: 180.0,
    },
    // Meat & Poultry
    {
      name: 'Pechuga de Pollo',
      sku: 'RM-003',
      category: RawMaterialCategory.POULTRY,
      currentStock: 10,
      unit: Unit.KILOGRAM,
      unitType: UnitType.WEIGHT,
      minimumStock: 2,
      reorderPoint: 3,
      costPerUnit: 85.0, // $85 per kg
      avgCostPerUnit: 85.0,
    },
    {
      name: 'Tocino',
      sku: 'RM-004',
      category: RawMaterialCategory.MEAT,
      currentStock: 3,
      unit: Unit.KILOGRAM,
      unitType: UnitType.WEIGHT,
      minimumStock: 0.5,
      reorderPoint: 1,
      costPerUnit: 120.0, // $120 per kg
      avgCostPerUnit: 120.0,
    },
    // Vegetables & Fruits
    {
      name: 'Lechuga Romana',
      sku: 'RM-005',
      category: RawMaterialCategory.VEGETABLES,
      currentStock: 8,
      unit: Unit.KILOGRAM,
      unitType: UnitType.WEIGHT,
      minimumStock: 2,
      reorderPoint: 3,
      costPerUnit: 18.0, // $18 per kg
      avgCostPerUnit: 18.0,
    },
    {
      name: 'Aguacate',
      sku: 'RM-006',
      category: RawMaterialCategory.FRUITS,
      currentStock: 30,
      unit: Unit.UNIT,
      unitType: UnitType.COUNT,
      minimumStock: 10,
      reorderPoint: 15,
      costPerUnit: 15.0, // $15 per unit
      avgCostPerUnit: 15.0,
    },
    {
      name: 'Fresas',
      sku: 'RM-007',
      category: RawMaterialCategory.FRUITS,
      currentStock: 5,
      unit: Unit.KILOGRAM,
      unitType: UnitType.WEIGHT,
      minimumStock: 1,
      reorderPoint: 2,
      costPerUnit: 65.0, // $65 per kg
      avgCostPerUnit: 65.0,
    },
    {
      name: 'Naranjas',
      sku: 'RM-008',
      category: RawMaterialCategory.FRUITS,
      currentStock: 50,
      unit: Unit.UNIT,
      unitType: UnitType.COUNT,
      minimumStock: 15,
      reorderPoint: 20,
      costPerUnit: 5.0, // $5 per orange
      avgCostPerUnit: 5.0,
    },
    // Coffee & Ingredients
    {
      name: 'Café Molido',
      sku: 'RM-009',
      category: RawMaterialCategory.GRAINS,
      currentStock: 5,
      unit: Unit.KILOGRAM,
      unitType: UnitType.WEIGHT,
      minimumStock: 1,
      reorderPoint: 2,
      costPerUnit: 250.0, // $250 per kg (specialty coffee)
      avgCostPerUnit: 250.0,
    },
    {
      name: 'Chocolate en Polvo',
      sku: 'RM-010',
      category: RawMaterialCategory.OTHER,
      currentStock: 3,
      unit: Unit.KILOGRAM,
      unitType: UnitType.WEIGHT,
      minimumStock: 0.5,
      reorderPoint: 1,
      costPerUnit: 150.0, // $150 per kg
      avgCostPerUnit: 150.0,
    },
    // Bread & Baking
    {
      name: 'Pan de Croissant',
      sku: 'RM-011',
      category: RawMaterialCategory.BREAD,
      currentStock: 40,
      unit: Unit.UNIT,
      unitType: UnitType.COUNT,
      minimumStock: 10,
      reorderPoint: 15,
      costPerUnit: 8.0, // $8 per croissant bread
      avgCostPerUnit: 8.0,
    },
    {
      name: 'Harina de Trigo',
      sku: 'RM-012',
      category: RawMaterialCategory.GRAINS,
      currentStock: 20,
      unit: Unit.KILOGRAM,
      unitType: UnitType.WEIGHT,
      minimumStock: 5,
      reorderPoint: 10,
      costPerUnit: 25.0, // $25 per kg
      avgCostPerUnit: 25.0,
    },
  ]

  const createdMaterials = []
  for (const material of materials) {
    // Create raw material
    const created = await prisma.rawMaterial.create({
      data: {
        venueId,
        ...material,
      },
    })

    // Create initial FIFO batch for the stock
    if (material.currentStock > 0) {
      const batchNumber = `BATCH-DEMO-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`

      const batch = await prisma.stockBatch.create({
        data: {
          venueId,
          rawMaterialId: created.id,
          batchNumber,
          initialQuantity: material.currentStock,
          remainingQuantity: material.currentStock,
          unit: material.unit,
          costPerUnit: material.costPerUnit,
          receivedDate: new Date(),
          status: BatchStatus.ACTIVE,
        },
      })

      // Create movement record for initial stock
      await prisma.rawMaterialMovement.create({
        data: {
          venueId,
          rawMaterialId: created.id,
          batchId: batch.id,
          type: RawMaterialMovementType.ADJUSTMENT,
          quantity: material.currentStock,
          unit: material.unit,
          previousStock: 0,
          newStock: material.currentStock,
          costImpact: material.costPerUnit * material.currentStock,
          reason: 'Stock inicial - Demo venue',
          reference: `DEMO-${Date.now()}`,
        },
      })
    }

    createdMaterials.push(created)
  }

  return createdMaterials
}

/**
 * Seeds recipes (links products to raw materials)
 * Only creates recipes for SOME products to show both inventory-tracked and non-tracked items
 */
async function seedRecipes(
  venueId: string,
  products: Array<{ id: string; name: string }>,
  rawMaterials: Array<{ id: string; name: string }>,
  modifierGroups: Array<{ id: string; name: string }>,
) {
  // Find the milk modifier group for SUBSTITUTION mode
  const milkModifierGroup = modifierGroups.find(g => g.name === 'Tipo de Leche')
  // Find products
  const cappuccino = products.find(p => p.name === 'Cappuccino')
  const latte = products.find(p => p.name === 'Latte')
  const sandwichClub = products.find(p => p.name === 'Sandwich Club')
  const ensaladaCesar = products.find(p => p.name === 'Ensalada César')
  const smoothieFresa = products.find(p => p.name === 'Smoothie de Fresa')
  const jugoNaranja = products.find(p => p.name === 'Jugo Naranja')

  // Find raw materials
  const leche = rawMaterials.find(m => m.name === 'Leche Entera')
  const cafe = rawMaterials.find(m => m.name === 'Café Molido')
  const pollo = rawMaterials.find(m => m.name === 'Pechuga de Pollo')
  const tocino = rawMaterials.find(m => m.name === 'Tocino')
  const lechuga = rawMaterials.find(m => m.name === 'Lechuga Romana')
  const aguacate = rawMaterials.find(m => m.name === 'Aguacate')
  const queso = rawMaterials.find(m => m.name === 'Queso Manchego')
  const fresas = rawMaterials.find(m => m.name === 'Fresas')
  const naranjas = rawMaterials.find(m => m.name === 'Naranjas')

  const recipes = []

  // Recipe 1: Cappuccino (with inventory tracking)
  if (cappuccino && leche && cafe) {
    const recipe = await prisma.recipe.create({
      data: {
        productId: cappuccino.id,
        portionYield: 1,
        totalCost: 8.5, // Calculated cost
        prepTime: 3,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: cafe.id,
        quantity: 0.018, // 18g
        unit: Unit.KILOGRAM,
        displayOrder: 1,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: leche.id,
        quantity: 0.15, // 150ml
        unit: Unit.LITER,
        displayOrder: 2,
        // ✅ WORLD-CLASS: Mark milk as variable ingredient for SUBSTITUTION mode
        // When customer selects "Leche de Almendra", the modifier replaces this ingredient
        isVariable: true,
        linkedModifierGroupId: milkModifierGroup?.id,
      },
    })

    recipes.push(recipe)
  }

  // Recipe 2: Latte (with inventory tracking)
  if (latte && leche && cafe) {
    const recipe = await prisma.recipe.create({
      data: {
        productId: latte.id,
        portionYield: 1,
        totalCost: 9.0,
        prepTime: 3,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: cafe.id,
        quantity: 0.018, // 18g
        unit: Unit.KILOGRAM,
        displayOrder: 1,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: leche.id,
        quantity: 0.2, // 200ml
        unit: Unit.LITER,
        displayOrder: 2,
        // ✅ WORLD-CLASS: Mark milk as variable ingredient for SUBSTITUTION mode
        isVariable: true,
        linkedModifierGroupId: milkModifierGroup?.id,
      },
    })

    recipes.push(recipe)
  }

  // Recipe 3: Sandwich Club (with inventory tracking)
  if (sandwichClub && pollo && tocino && lechuga && aguacate) {
    const recipe = await prisma.recipe.create({
      data: {
        productId: sandwichClub.id,
        portionYield: 1,
        totalCost: 32.0,
        prepTime: 8,
        cookTime: 5,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: pollo.id,
        quantity: 0.15, // 150g
        unit: Unit.KILOGRAM,
        displayOrder: 1,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: tocino.id,
        quantity: 0.03, // 30g
        unit: Unit.KILOGRAM,
        displayOrder: 2,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: lechuga.id,
        quantity: 0.05, // 50g
        unit: Unit.KILOGRAM,
        displayOrder: 3,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: aguacate.id,
        quantity: 0.5, // Half avocado
        unit: Unit.UNIT,
        displayOrder: 4,
      },
    })

    recipes.push(recipe)
  }

  // Recipe 4: Ensalada César (with inventory tracking)
  if (ensaladaCesar && lechuga && queso) {
    const recipe = await prisma.recipe.create({
      data: {
        productId: ensaladaCesar.id,
        portionYield: 1,
        totalCost: 22.0,
        prepTime: 5,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: lechuga.id,
        quantity: 0.15, // 150g
        unit: Unit.KILOGRAM,
        displayOrder: 1,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: queso.id,
        quantity: 0.03, // 30g
        unit: Unit.KILOGRAM,
        displayOrder: 2,
      },
    })

    recipes.push(recipe)
  }

  // Recipe 5: Smoothie de Fresa (with inventory tracking)
  if (smoothieFresa && fresas && leche) {
    const recipe = await prisma.recipe.create({
      data: {
        productId: smoothieFresa.id,
        portionYield: 1,
        totalCost: 18.0,
        prepTime: 3,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: fresas.id,
        quantity: 0.15, // 150g
        unit: Unit.KILOGRAM,
        displayOrder: 1,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: leche.id,
        quantity: 0.2, // 200ml
        unit: Unit.LITER,
        displayOrder: 2,
      },
    })

    recipes.push(recipe)
  }

  // Recipe 6: Jugo Naranja (with inventory tracking)
  if (jugoNaranja && naranjas) {
    const recipe = await prisma.recipe.create({
      data: {
        productId: jugoNaranja.id,
        portionYield: 1,
        totalCost: 12.0,
        prepTime: 2,
      },
    })

    await prisma.recipeLine.create({
      data: {
        recipeId: recipe.id,
        rawMaterialId: naranjas.id,
        quantity: 3, // 3 oranges
        unit: Unit.UNIT,
        displayOrder: 1,
      },
    })

    recipes.push(recipe)
  }

  // Update all products with recipes to use RECIPE inventory method
  for (const recipe of recipes) {
    await prisma.product.update({
      where: { id: recipe.productId },
      data: {
        inventoryMethod: InventoryMethod.RECIPE,
      },
    })
  }

  return recipes
}

/**
 * Seeds tables and areas
 */
async function seedTablesAndAreas(venueId: string) {
  // Create area
  const area = await prisma.area.create({
    data: {
      venueId,
      name: 'Sala Principal',
      description: 'Área principal del restaurante',
    },
  })

  // Create tables
  const tables = []
  for (let i = 1; i <= 10; i++) {
    const table = await prisma.table.create({
      data: {
        venueId,
        areaId: area.id,
        number: `Mesa ${i}`,
        capacity: i <= 6 ? 4 : 6, // Mesas 1-6 para 4, 7-10 para 6
        qrCode: `DEMO-${venueId.substring(0, 8)}-T${i}`,
        active: true,
      },
    })
    tables.push(table)
  }

  return tables
}

/**
 * Seeds sample orders with tips and reviews (last 7 days)
 * Links some orders to existing customers
 */
async function seedOrders(
  venueId: string,
  products: Array<{ id: string; name: string; price: number }>,
  tables: Array<{ id: string }>,
  merchantAccounts: Array<{ id: string; displayName: string | null }>,
  customers: Array<{ id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null }>,
) {
  const orders = []
  const reviews = []
  const now = new Date()

  // Customer names for reviews (fallback for orders without linked customers)
  const customerNames = ['María González', 'Carlos Hernández', 'Ana López', 'Roberto Martínez', 'Laura Sánchez', 'José Ramírez']

  // Review comments
  const positiveComments = [
    'Excelente servicio y comida deliciosa. Totalmente recomendado!',
    'El café es de muy buena calidad y el ambiente es acogedor.',
    'Me encantó el Sandwich Club, muy bien preparado y servido.',
    'Atención rápida y amable. Volveremos sin duda.',
  ]

  const neutralComments = [
    'Buena experiencia en general, aunque el tiempo de espera fue un poco largo.',
    'La comida está bien, nada excepcional pero cumple con lo esperado.',
  ]

  // Create 50 random orders over last 7 days
  for (let i = 0; i < 50; i++) {
    // Random date in last 7 days
    const daysAgo = Math.floor(Math.random() * 7)
    const hoursAgo = Math.floor(Math.random() * 12)
    const orderDate = subHours(subDays(now, daysAgo), hoursAgo)

    // Random table
    const table = tables[Math.floor(Math.random() * tables.length)]

    // Random products (1-3 items)
    const numItems = Math.floor(Math.random() * 3) + 1
    const orderProducts = []
    let subtotal = 0

    for (let j = 0; j < numItems; j++) {
      const product = products[Math.floor(Math.random() * products.length)]
      const quantity = Math.floor(Math.random() * 2) + 1
      orderProducts.push({ product, quantity })
      subtotal += product.price * quantity
    }

    const taxAmount = subtotal * 0.16
    const total = subtotal + taxAmount

    // Determine if this order has a tip (40% chance)
    const hasTip = Math.random() < 0.4
    const tipAmount = hasTip ? Math.round(total * (0.1 + Math.random() * 0.1)) : 0 // 10-20% tip

    // Link 60% of orders to customers
    const hasCustomer = Math.random() < 0.6 && customers.length > 0
    const customer = hasCustomer ? customers[Math.floor(Math.random() * customers.length)] : null

    // Create order
    const order = await prisma.order.create({
      data: {
        venueId,
        tableId: table.id,
        customerId: customer?.id,
        customerName: customer ? `${customer.firstName || ''} ${customer.lastName || ''}`.trim() : null,
        customerEmail: customer?.email,
        customerPhone: customer?.phone,
        orderNumber: `DEMO-${String(i + 1).padStart(4, '0')}`,
        type: OrderType.DINE_IN,
        status: OrderStatus.COMPLETED,
        paymentStatus: PaymentStatus.PAID,
        subtotal,
        taxAmount,
        total,
        createdAt: orderDate,
        completedAt: orderDate,
      },
    })

    // Create order items
    for (const { product, quantity } of orderProducts) {
      await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          quantity,
          unitPrice: product.price,
          taxAmount: product.price * quantity * 0.16,
          total: product.price * quantity * 1.16,
        },
      })
    }

    // Create payment with tip and merchant account
    // Distribution: 50% Blumon (TPV), 20% Stripe (online), 30% Cash
    const randomValue = Math.random()
    let paymentMethod: PaymentMethod
    let merchantAccountId: string | undefined

    if (randomValue < 0.5) {
      // 50% Blumon (physical TPV)
      paymentMethod = PaymentMethod.CREDIT_CARD
      merchantAccountId = merchantAccounts[1].id // Blumon merchant
    } else if (randomValue < 0.7) {
      // 20% Stripe (online payments)
      paymentMethod = PaymentMethod.CREDIT_CARD
      merchantAccountId = merchantAccounts[0].id // Stripe merchant
    } else {
      // 30% Cash (no merchant account)
      paymentMethod = PaymentMethod.CASH
      merchantAccountId = undefined
    }

    await prisma.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount: total,
        tipAmount,
        method: paymentMethod,
        merchantAccountId, // 🆕 Link payment to merchant account
        status: 'COMPLETED',
        feePercentage: 0.025,
        feeAmount: (total + tipAmount) * 0.025,
        netAmount: (total + tipAmount) * 0.975,
        createdAt: orderDate,
      },
    })

    orders.push(order)

    // Create review for some orders (only first 4 orders get reviews)
    if (i < 4) {
      const isPositive = i < 3 // First 3 are positive, last 1 is neutral
      const overallRating = isPositive ? 4 + Math.floor(Math.random() * 2) : 3 // 4-5 stars or 3 stars

      // Use linked customer name if available, otherwise fallback to preset names
      const reviewerName = customer ? `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || customerNames[i] : customerNames[i]

      const review = await prisma.review.create({
        data: {
          venueId,
          overallRating,
          foodRating: overallRating,
          serviceRating: overallRating,
          ambienceRating: overallRating,
          comment: isPositive ? positiveComments[i] : neutralComments[0],
          customerName: reviewerName,
          source: ReviewSource.AVOQADO,
          createdAt: subHours(orderDate, Math.floor(Math.random() * 2) + 1), // 1-3 hours after order
        },
      })

      reviews.push(review)
    }
  }

  return { orders, reviews }
}

/**
 * Seeds loyalty configuration for a venue
 */
async function seedLoyaltyConfig(venueId: string) {
  const loyaltyConfig = await prisma.loyaltyConfig.create({
    data: {
      venueId,
      pointsPerDollar: 1,
      pointsPerVisit: 10,
      redemptionRate: 0.01, // 100 points = $1
      minPointsRedeem: 100,
      pointsExpireDays: 365,
      active: true,
    },
  })

  return loyaltyConfig
}

/**
 * Seeds customer groups for a venue
 */
async function seedCustomerGroups(venueId: string) {
  const groups = [
    {
      name: 'VIP',
      description: 'Clientes frecuentes con beneficios exclusivos',
      color: '#FFD700', // Gold
      discountPercentage: 10,
      priority: 1,
    },
    {
      name: 'Nuevos',
      description: 'Clientes en su primera visita',
      color: '#4CAF50', // Green
      discountPercentage: 5,
      priority: 3,
    },
    {
      name: 'Cumpleañeros',
      description: 'Clientes celebrando su cumpleaños este mes',
      color: '#E91E63', // Pink
      discountPercentage: 15,
      priority: 2,
    },
    {
      name: 'Empleados',
      description: 'Empleados y colaboradores',
      color: '#2196F3', // Blue
      discountPercentage: 20,
      priority: 4,
    },
  ]

  const createdGroups = []
  for (const group of groups) {
    const created = await prisma.customerGroup.create({
      data: {
        venueId,
        ...group,
        active: true,
      },
    })
    createdGroups.push(created)
  }

  return createdGroups
}

/**
 * Seeds sample customers for a venue
 * Creates diverse customers with different attributes
 */
async function seedCustomers(venueId: string, customerGroups: Array<{ id: string; name: string }>) {
  const vipGroup = customerGroups.find(g => g.name === 'VIP')
  const nuevosGroup = customerGroups.find(g => g.name === 'Nuevos')
  const cumpleanosGroup = customerGroups.find(g => g.name === 'Cumpleañeros')

  const now = new Date()
  const thirtyDaysAgo = subDays(now, 30)
  const sixtyDaysAgo = subDays(now, 60)
  const ninetyDaysAgo = subDays(now, 90)

  const customers = [
    // VIP customers with high loyalty points and visits
    {
      firstName: 'María',
      lastName: 'González',
      email: 'maria.gonzalez@demo.com',
      phone: '5551234567',
      customerGroupId: vipGroup?.id,
      loyaltyPoints: 850,
      totalVisits: 25,
      totalSpent: 4250.0,
      averageOrderValue: 170.0,
      firstVisitAt: ninetyDaysAgo,
      lastVisitAt: subDays(now, 2),
      tags: ['frecuente', 'café'],
      marketingConsent: true,
    },
    {
      firstName: 'Carlos',
      lastName: 'Hernández',
      email: 'carlos.hernandez@demo.com',
      phone: '5552345678',
      customerGroupId: vipGroup?.id,
      loyaltyPoints: 620,
      totalVisits: 18,
      totalSpent: 3100.0,
      averageOrderValue: 172.22,
      firstVisitAt: sixtyDaysAgo,
      lastVisitAt: subDays(now, 1),
      tags: ['frecuente', 'almuerzo'],
      marketingConsent: true,
    },
    // Birthday customer
    {
      firstName: 'Ana',
      lastName: 'López',
      email: 'ana.lopez@demo.com',
      phone: '5553456789',
      customerGroupId: cumpleanosGroup?.id,
      loyaltyPoints: 320,
      totalVisits: 8,
      totalSpent: 1280.0,
      averageOrderValue: 160.0,
      birthDate: new Date(1990, now.getMonth(), 15), // Birthday this month
      firstVisitAt: thirtyDaysAgo,
      lastVisitAt: subDays(now, 5),
      tags: ['cumpleaños'],
      marketingConsent: true,
    },
    // New customers
    {
      firstName: 'Roberto',
      lastName: 'Martínez',
      email: 'roberto.martinez@demo.com',
      phone: '5554567890',
      customerGroupId: nuevosGroup?.id,
      loyaltyPoints: 45,
      totalVisits: 2,
      totalSpent: 180.0,
      averageOrderValue: 90.0,
      firstVisitAt: subDays(now, 7),
      lastVisitAt: subDays(now, 3),
      tags: ['nuevo'],
      marketingConsent: false,
    },
    {
      firstName: 'Laura',
      lastName: 'Sánchez',
      email: 'laura.sanchez@demo.com',
      phone: '5555678901',
      customerGroupId: nuevosGroup?.id,
      loyaltyPoints: 20,
      totalVisits: 1,
      totalSpent: 85.0,
      averageOrderValue: 85.0,
      firstVisitAt: subDays(now, 2),
      lastVisitAt: subDays(now, 2),
      tags: ['nuevo'],
      marketingConsent: true,
    },
    // Regular customers without group
    {
      firstName: 'José',
      lastName: 'Ramírez',
      email: 'jose.ramirez@demo.com',
      phone: '5556789012',
      customerGroupId: null,
      loyaltyPoints: 280,
      totalVisits: 12,
      totalSpent: 1400.0,
      averageOrderValue: 116.67,
      firstVisitAt: sixtyDaysAgo,
      lastVisitAt: subDays(now, 10),
      tags: ['regular'],
      marketingConsent: true,
    },
    {
      firstName: 'Patricia',
      lastName: 'Fernández',
      email: 'patricia.fernandez@demo.com',
      phone: '5557890123',
      customerGroupId: null,
      loyaltyPoints: 150,
      totalVisits: 6,
      totalSpent: 750.0,
      averageOrderValue: 125.0,
      firstVisitAt: thirtyDaysAgo,
      lastVisitAt: subDays(now, 8),
      tags: ['regular', 'desayuno'],
      marketingConsent: false,
    },
    // Customer with only phone (no email)
    {
      firstName: 'Miguel',
      lastName: 'Torres',
      email: null,
      phone: '5558901234',
      customerGroupId: null,
      loyaltyPoints: 95,
      totalVisits: 4,
      totalSpent: 380.0,
      averageOrderValue: 95.0,
      firstVisitAt: subDays(now, 20),
      lastVisitAt: subDays(now, 6),
      tags: [],
      marketingConsent: false,
    },
    // Customer with only email (no phone)
    {
      firstName: 'Gabriela',
      lastName: 'Ruiz',
      email: 'gabriela.ruiz@demo.com',
      phone: null,
      customerGroupId: null,
      loyaltyPoints: 180,
      totalVisits: 7,
      totalSpent: 630.0,
      averageOrderValue: 90.0,
      firstVisitAt: thirtyDaysAgo,
      lastVisitAt: subDays(now, 4),
      tags: ['bebidas'],
      marketingConsent: true,
    },
    // High spender VIP
    {
      firstName: 'Fernando',
      lastName: 'Vega',
      email: 'fernando.vega@demo.com',
      phone: '5559012345',
      customerGroupId: vipGroup?.id,
      loyaltyPoints: 1200,
      totalVisits: 35,
      totalSpent: 7000.0,
      averageOrderValue: 200.0,
      firstVisitAt: ninetyDaysAgo,
      lastVisitAt: now,
      tags: ['frecuente', 'vip', 'eventos'],
      marketingConsent: true,
      notes: 'Cliente frecuente, prefiere mesa junto a la ventana',
    },
  ]

  const createdCustomers = []
  for (const customer of customers) {
    const created = await prisma.customer.create({
      data: {
        venueId,
        ...customer,
        active: true,
      },
    })
    createdCustomers.push(created)
  }

  return createdCustomers
}
