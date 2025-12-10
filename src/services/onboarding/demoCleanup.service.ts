/**
 * Demo Cleanup Service
 *
 * Cleans demo/sample data from a venue when converting from demo to real.
 * Called during KYC approval to give the venue a fresh start.
 *
 * IMPORTANT: Uses `isDemo` field to distinguish demo data from user data.
 * Only data with `isDemo: true` will be deleted for business setup items.
 *
 * What gets DELETED (transactional data - ALL):
 * - Orders and OrderItems
 * - Payments
 * - Reviews
 * - RawMaterialMovement (inventory movements)
 * - StockBatch (FIFO batches)
 * - Demo MerchantAccounts (if externalMerchantId contains 'demo')
 * - Demo Customers
 *
 * What gets DELETED (business setup - ONLY isDemo: true):
 * - RecipeLine
 * - Recipe
 * - Inventory
 * - Product
 * - Modifier
 * - ModifierGroup
 * - MenuCategory
 * - Menu
 * - Table
 * - Area
 * - CustomerGroup
 * - LoyaltyConfig
 * - RawMaterial
 *
 * What gets DELETED (payment config - ONLY if demo accounts):
 * - VenuePaymentConfig (only if linked to demo merchant accounts)
 * - VenuePricingStructure (only if VenuePaymentConfig was demo)
 * - ProviderCostStructure (only for demo merchant accounts)
 *
 * What gets KEPT:
 * - All data created by the user (isDemo: false)
 * - Staff/team members
 * - Real VenuePaymentConfig (post-KYC setup with real merchant accounts)
 * - Real VenuePricingStructure (configured for real accounts)
 * - Real ProviderCostStructure (for real merchant accounts)
 */

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

interface CleanupResult {
  // Transactional data (all deleted)
  deletedOrders: number
  deletedPayments: number
  deletedReviews: number
  deletedMovements: number
  deletedBatches: number
  deletedMerchantAccounts: number
  deletedCustomers: number
  // Business setup (only isDemo: true deleted)
  deletedRecipeLines: number
  deletedRecipes: number
  deletedInventory: number
  deletedProducts: number
  deletedModifiers: number
  deletedModifierGroups: number
  deletedMenuCategories: number
  deletedMenus: number
  deletedTables: number
  deletedAreas: number
  deletedCustomerGroups: number
  deletedLoyaltyConfig: number
  deletedRawMaterials: number
  // Reset counts
  resetRawMaterials: number
  resetInventory: number
}

/**
 * Cleans all demo/sample data from a venue
 * Call this when converting from demo to real (KYC approval)
 *
 * @param venueId - Venue ID to clean
 * @returns Cleanup statistics
 */
export async function cleanDemoData(venueId: string): Promise<CleanupResult> {
  logger.info(`🧹 Starting demo data cleanup for venue: ${venueId}`)

  const result: CleanupResult = {
    deletedOrders: 0,
    deletedPayments: 0,
    deletedReviews: 0,
    deletedMovements: 0,
    deletedBatches: 0,
    deletedMerchantAccounts: 0,
    deletedCustomers: 0,
    deletedRecipeLines: 0,
    deletedRecipes: 0,
    deletedInventory: 0,
    deletedProducts: 0,
    deletedModifiers: 0,
    deletedModifierGroups: 0,
    deletedMenuCategories: 0,
    deletedMenus: 0,
    deletedTables: 0,
    deletedAreas: 0,
    deletedCustomerGroups: 0,
    deletedLoyaltyConfig: 0,
    deletedRawMaterials: 0,
    resetRawMaterials: 0,
    resetInventory: 0,
  }

  // Use transaction to ensure atomicity
  await prisma.$transaction(
    async tx => {
      // ==========================================
      // PHASE 1: Delete ALL transactional data
      // (These are always temporary demo data)
      // ==========================================

      // 1. Delete Payments (must delete before orders due to FK)
      const deletedPayments = await tx.payment.deleteMany({
        where: { venueId },
      })
      result.deletedPayments = deletedPayments.count
      logger.info(`  ✓ Deleted ${deletedPayments.count} payments`)

      // 2. Delete OrderItems (cascade from orders)
      const orders = await tx.order.findMany({
        where: { venueId },
        select: { id: true },
      })
      const orderIds = orders.map(o => o.id)

      if (orderIds.length > 0) {
        await tx.orderItem.deleteMany({
          where: { orderId: { in: orderIds } },
        })
      }

      // 3. Delete Orders
      const deletedOrders = await tx.order.deleteMany({
        where: { venueId },
      })
      result.deletedOrders = deletedOrders.count
      logger.info(`  ✓ Deleted ${deletedOrders.count} orders`)

      // 4. Delete Reviews
      const deletedReviews = await tx.review.deleteMany({
        where: { venueId },
      })
      result.deletedReviews = deletedReviews.count
      logger.info(`  ✓ Deleted ${deletedReviews.count} reviews`)

      // 5. Delete RawMaterialMovement (inventory movements)
      const deletedMovements = await tx.rawMaterialMovement.deleteMany({
        where: { venueId },
      })
      result.deletedMovements = deletedMovements.count
      logger.info(`  ✓ Deleted ${deletedMovements.count} inventory movements`)

      // 6. Delete StockBatch (FIFO batches)
      const deletedBatches = await tx.stockBatch.deleteMany({
        where: { venueId },
      })
      result.deletedBatches = deletedBatches.count
      logger.info(`  ✓ Deleted ${deletedBatches.count} stock batches`)

      // 7. Delete demo MerchantAccounts for THIS venue only
      const venuePaymentConfig = await tx.venuePaymentConfig.findUnique({
        where: { venueId },
        select: { primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true },
      })

      const venueAccountIds: string[] = []
      if (venuePaymentConfig?.primaryAccountId) venueAccountIds.push(venuePaymentConfig.primaryAccountId)
      if (venuePaymentConfig?.secondaryAccountId) venueAccountIds.push(venuePaymentConfig.secondaryAccountId)
      if (venuePaymentConfig?.tertiaryAccountId) venueAccountIds.push(venuePaymentConfig.tertiaryAccountId)

      // Check if any of the venue's merchant accounts are demo accounts
      let hasDemoMerchantAccounts = false
      if (venueAccountIds.length > 0) {
        const demoAccountCheck = await tx.merchantAccount.findMany({
          where: {
            id: { in: venueAccountIds },
            OR: [
              { externalMerchantId: { contains: 'demo', mode: 'insensitive' } },
              { displayName: { contains: 'Demo', mode: 'insensitive' } },
              { blumonSerialNumber: { startsWith: 'DEMO' } },
            ],
          },
          select: { id: true },
        })
        hasDemoMerchantAccounts = demoAccountCheck.length > 0
      }

      // Delete VenuePaymentConfig ONLY if it points to demo accounts
      // Preserve real config that was set up post-KYC
      if (venuePaymentConfig && hasDemoMerchantAccounts) {
        await tx.venuePaymentConfig.delete({
          where: { venueId },
        })

        // Delete VenuePricingStructure ONLY if the config was demo
        // This preserves pricing structures created for real accounts post-KYC
        await tx.venuePricingStructure.deleteMany({
          where: { venueId },
        })
        logger.info(`  ✓ Deleted demo VenuePaymentConfig and VenuePricingStructures`)
      } else if (venuePaymentConfig) {
        logger.info(`  ⚡ Preserved real VenuePaymentConfig and VenuePricingStructures (non-demo accounts)`)
      }

      if (venueAccountIds.length > 0 && hasDemoMerchantAccounts) {
        const demoAccountsForVenue = await tx.merchantAccount.findMany({
          where: {
            id: { in: venueAccountIds },
            OR: [
              { externalMerchantId: { contains: 'demo', mode: 'insensitive' } },
              { displayName: { contains: 'Demo', mode: 'insensitive' } },
              { blumonSerialNumber: { startsWith: 'DEMO' } },
            ],
          },
          select: { id: true },
        })

        if (demoAccountsForVenue.length > 0) {
          const demoAccountIds = demoAccountsForVenue.map(m => m.id)

          const stillReferenced = await tx.venuePaymentConfig.findMany({
            where: {
              OR: [
                { primaryAccountId: { in: demoAccountIds } },
                { secondaryAccountId: { in: demoAccountIds } },
                { tertiaryAccountId: { in: demoAccountIds } },
              ],
            },
            select: { primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true },
          })

          const stillReferencedIds = new Set<string>()
          for (const config of stillReferenced) {
            if (config.primaryAccountId) stillReferencedIds.add(config.primaryAccountId)
            if (config.secondaryAccountId) stillReferencedIds.add(config.secondaryAccountId)
            if (config.tertiaryAccountId) stillReferencedIds.add(config.tertiaryAccountId)
          }

          const safeToDeleteIds = demoAccountIds.filter(id => !stillReferencedIds.has(id))

          if (safeToDeleteIds.length > 0) {
            await tx.providerCostStructure.deleteMany({
              where: { merchantAccountId: { in: safeToDeleteIds } },
            })

            const deletedMerchantAccounts = await tx.merchantAccount.deleteMany({
              where: { id: { in: safeToDeleteIds } },
            })
            result.deletedMerchantAccounts = deletedMerchantAccounts.count
            logger.info(`  ✓ Deleted ${deletedMerchantAccounts.count} demo merchant accounts`)
          }
        }
      }

      // 8. Delete demo Customers (those created by seed)
      const deletedCustomers = await tx.customer.deleteMany({
        where: {
          venueId,
          OR: [{ email: { endsWith: '@demo.com' } }, { email: null, phone: { startsWith: '555' } }],
        },
      })
      result.deletedCustomers = deletedCustomers.count
      logger.info(`  ✓ Deleted ${deletedCustomers.count} demo customers`)

      // 9. Reset remaining customers loyalty data
      await tx.customer.updateMany({
        where: { venueId },
        data: {
          loyaltyPoints: 0,
          totalVisits: 0,
          totalSpent: 0,
          averageOrderValue: 0,
          firstVisitAt: null,
          lastVisitAt: null,
        },
      })
      logger.info(`  ✓ Reset loyalty data for remaining customers`)

      // ==========================================
      // PHASE 2: Delete DEMO business setup data (isDemo: true only)
      // User-created data (isDemo: false) is preserved!
      // ==========================================

      logger.info(`  📦 Cleaning demo business setup data (preserving user data)...`)

      // 10. Delete demo RecipeLines first (FK to Recipe)
      const deletedRecipeLines = await tx.recipeLine.deleteMany({
        where: { isDemo: true },
      })
      result.deletedRecipeLines = deletedRecipeLines.count
      logger.info(`  ✓ Deleted ${deletedRecipeLines.count} demo recipe lines`)

      // 11. Delete demo Recipes (FK to Product)
      const deletedRecipes = await tx.recipe.deleteMany({
        where: { isDemo: true },
      })
      result.deletedRecipes = deletedRecipes.count
      logger.info(`  ✓ Deleted ${deletedRecipes.count} demo recipes`)

      // 12. Delete demo Inventory (FK to Product)
      const deletedInventory = await tx.inventory.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedInventory = deletedInventory.count
      logger.info(`  ✓ Deleted ${deletedInventory.count} demo inventory records`)

      // 13. Delete ProductModifierGroup links for demo products
      const demoProducts = await tx.product.findMany({
        where: { venueId, isDemo: true },
        select: { id: true },
      })
      if (demoProducts.length > 0) {
        await tx.productModifierGroup.deleteMany({
          where: { productId: { in: demoProducts.map(p => p.id) } },
        })
      }

      // 14. Delete demo Products (FK to MenuCategory)
      const deletedProducts = await tx.product.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedProducts = deletedProducts.count
      logger.info(`  ✓ Deleted ${deletedProducts.count} demo products`)

      // 15. Delete demo Modifiers (FK to ModifierGroup)
      const deletedModifiers = await tx.modifier.deleteMany({
        where: { isDemo: true },
      })
      result.deletedModifiers = deletedModifiers.count
      logger.info(`  ✓ Deleted ${deletedModifiers.count} demo modifiers`)

      // 16. Delete demo ModifierGroups
      const deletedModifierGroups = await tx.modifierGroup.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedModifierGroups = deletedModifierGroups.count
      logger.info(`  ✓ Deleted ${deletedModifierGroups.count} demo modifier groups`)

      // 17. Delete MenuCategoryAssignments for demo categories
      const demoCategories = await tx.menuCategory.findMany({
        where: { venueId, isDemo: true },
        select: { id: true },
      })
      if (demoCategories.length > 0) {
        await tx.menuCategoryAssignment.deleteMany({
          where: { categoryId: { in: demoCategories.map(c => c.id) } },
        })
      }

      // 18. Delete demo MenuCategories
      const deletedMenuCategories = await tx.menuCategory.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedMenuCategories = deletedMenuCategories.count
      logger.info(`  ✓ Deleted ${deletedMenuCategories.count} demo menu categories`)

      // 19. Delete MenuCategoryAssignments for demo menus
      const demoMenus = await tx.menu.findMany({
        where: { venueId, isDemo: true },
        select: { id: true },
      })
      if (demoMenus.length > 0) {
        await tx.menuCategoryAssignment.deleteMany({
          where: { menuId: { in: demoMenus.map(m => m.id) } },
        })
      }

      // 20. Delete demo Menus
      const deletedMenus = await tx.menu.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedMenus = deletedMenus.count
      logger.info(`  ✓ Deleted ${deletedMenus.count} demo menus`)

      // 21. Reset tables and delete demo tables
      await tx.table.updateMany({
        where: { venueId },
        data: {
          status: 'AVAILABLE',
          currentOrderId: null,
        },
      })

      const deletedTables = await tx.table.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedTables = deletedTables.count
      logger.info(`  ✓ Deleted ${deletedTables.count} demo tables`)

      // 22. Delete demo Areas
      const deletedAreas = await tx.area.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedAreas = deletedAreas.count
      logger.info(`  ✓ Deleted ${deletedAreas.count} demo areas`)

      // 23. Delete demo CustomerGroups
      const deletedCustomerGroups = await tx.customerGroup.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedCustomerGroups = deletedCustomerGroups.count
      logger.info(`  ✓ Deleted ${deletedCustomerGroups.count} demo customer groups`)

      // 24. Delete demo LoyaltyConfig
      const deletedLoyaltyConfig = await tx.loyaltyConfig.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedLoyaltyConfig = deletedLoyaltyConfig.count
      logger.info(`  ✓ Deleted ${deletedLoyaltyConfig.count} demo loyalty configs`)

      // 25. Reset non-demo RawMaterial stock to 0 (keep the records)
      const resetRawMaterials = await tx.rawMaterial.updateMany({
        where: {
          venueId,
          isDemo: false,
        },
        data: {
          currentStock: 0,
          avgCostPerUnit: 0,
        },
      })
      result.resetRawMaterials = resetRawMaterials.count
      logger.info(`  ✓ Reset ${resetRawMaterials.count} user raw materials to 0 stock`)

      // 26. Delete demo RawMaterials
      const deletedRawMaterials = await tx.rawMaterial.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedRawMaterials = deletedRawMaterials.count
      logger.info(`  ✓ Deleted ${deletedRawMaterials.count} demo raw materials`)

      // 27. Reset non-demo Inventory to 0 (keep the records)
      const resetInventory = await tx.inventory.updateMany({
        where: {
          venueId,
          isDemo: false,
        },
        data: {
          currentStock: 0,
          reservedStock: 0,
        },
      })
      result.resetInventory = resetInventory.count
      logger.info(`  ✓ Reset ${resetInventory.count} user inventory records to 0 stock`)
    },
    {
      timeout: 120000, // 2 minute timeout for comprehensive cleanup
    },
  )

  logger.info(`🎉 Demo data cleanup complete for venue ${venueId}`)
  logger.info(`   Transactional: ${result.deletedOrders} orders, ${result.deletedPayments} payments`)
  logger.info(
    `   Business Setup: ${result.deletedProducts} products, ${result.deletedMenuCategories} categories, ${result.deletedRecipes} recipes`,
  )
  logger.info(`   User data preserved: ${result.resetRawMaterials} raw materials reset, ${result.resetInventory} inventory reset`)

  return result
}

/**
 * Check if venue has demo data that needs cleanup
 * Useful for UI to show cleanup option
 *
 * @param venueId - Venue ID to check
 * @returns true if venue has demo data
 */
export async function hasDemoData(venueId: string): Promise<boolean> {
  // Check for demo indicators using isDemo field
  const [demoOrderCount, demoProductCount, demoMenuCount, demoRawMaterialCount, demoCustomerCount] = await Promise.all([
    prisma.order.count({
      where: {
        venueId,
        orderNumber: { startsWith: 'DEMO-' },
      },
    }),
    prisma.product.count({
      where: {
        venueId,
        isDemo: true,
      },
    }),
    prisma.menu.count({
      where: {
        venueId,
        isDemo: true,
      },
    }),
    prisma.rawMaterial.count({
      where: {
        venueId,
        isDemo: true,
      },
    }),
    prisma.customer.count({
      where: {
        venueId,
        email: { endsWith: '@demo.com' },
      },
    }),
  ])

  return demoOrderCount > 0 || demoProductCount > 0 || demoMenuCount > 0 || demoRawMaterialCount > 0 || demoCustomerCount > 0
}
