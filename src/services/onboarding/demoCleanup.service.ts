/**
 * Demo Cleanup Service
 *
 * Cleans demo/sample data from a venue when converting from demo to real.
 * Called during KYC approval to give the venue a fresh start.
 *
 * What gets DELETED (transactional data):
 * - Orders and OrderItems
 * - Payments
 * - Reviews
 * - RawMaterialMovement (inventory movements)
 * - StockBatch (FIFO batches)
 * - Demo MerchantAccounts
 * - Demo Customers
 *
 * What gets RESET (keep structure, zero out values):
 * - RawMaterial currentStock -> 0
 * - Inventory currentStock -> 0
 * - Customer loyalty points -> 0 (if keeping customers)
 *
 * What gets KEPT (business setup):
 * - Menu, categories, products
 * - Modifier groups and modifiers
 * - Tables and areas
 * - Raw materials (ingredient list)
 * - Recipes
 * - LoyaltyConfig
 * - CustomerGroups
 * - Staff/team members
 */

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

interface CleanupResult {
  deletedOrders: number
  deletedPayments: number
  deletedReviews: number
  deletedMovements: number
  deletedBatches: number
  deletedMerchantAccounts: number
  deletedCustomers: number
  resetRawMaterials: number
  resetInventory: number
}

/**
 * Cleans all demo/sample transactional data from a venue
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
    resetRawMaterials: 0,
    resetInventory: 0,
  }

  // Use transaction to ensure atomicity
  await prisma.$transaction(
    async tx => {
      // 1. Delete Payments (must delete before orders due to FK)
      const deletedPayments = await tx.payment.deleteMany({
        where: { venueId },
      })
      result.deletedPayments = deletedPayments.count
      logger.info(`  ✓ Deleted ${deletedPayments.count} payments`)

      // 2. Delete OrderItems (cascade from orders)
      // Note: OrderItems have orderId FK, need to delete via orders
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

      // 7. Reset RawMaterial currentStock to 0
      const resetRawMaterials = await tx.rawMaterial.updateMany({
        where: { venueId },
        data: {
          currentStock: 0,
          avgCostPerUnit: 0,
        },
      })
      result.resetRawMaterials = resetRawMaterials.count
      logger.info(`  ✓ Reset ${resetRawMaterials.count} raw materials to 0 stock`)

      // 8. Reset Inventory (product inventory) to 0
      const resetInventory = await tx.inventory.updateMany({
        where: { venueId },
        data: {
          currentStock: 0,
          reservedStock: 0,
        },
      })
      result.resetInventory = resetInventory.count
      logger.info(`  ✓ Reset ${resetInventory.count} product inventories to 0 stock`)

      // 9. Delete demo MerchantAccounts
      // First get VenuePaymentConfig to find linked merchant accounts
      const venuePaymentConfig = await tx.venuePaymentConfig.findUnique({
        where: { venueId },
        select: { primaryAccountId: true, secondaryAccountId: true },
      })

      // Delete VenuePaymentConfig first (has FK to MerchantAccount)
      if (venuePaymentConfig) {
        await tx.venuePaymentConfig.delete({
          where: { venueId },
        })
      }

      // Find demo merchant accounts (those with DEMO in externalMerchantId or displayName)
      const demoMerchantAccounts = await tx.merchantAccount.findMany({
        where: {
          OR: [
            { externalMerchantId: { contains: 'demo' } },
            { externalMerchantId: { contains: 'DEMO' } },
            { displayName: { contains: 'Demo' } },
            { blumonSerialNumber: { startsWith: 'DEMO' } },
          ],
        },
        select: { id: true },
      })

      if (demoMerchantAccounts.length > 0) {
        const demoAccountIds = demoMerchantAccounts.map(m => m.id)

        // Delete ProviderCostStructure for demo accounts
        await tx.providerCostStructure.deleteMany({
          where: { merchantAccountId: { in: demoAccountIds } },
        })

        // Delete VenuePricingStructure for this venue
        await tx.venuePricingStructure.deleteMany({
          where: { venueId },
        })

        // Delete demo MerchantAccounts
        const deletedMerchantAccounts = await tx.merchantAccount.deleteMany({
          where: { id: { in: demoAccountIds } },
        })
        result.deletedMerchantAccounts = deletedMerchantAccounts.count
        logger.info(`  ✓ Deleted ${deletedMerchantAccounts.count} demo merchant accounts`)
      }

      // 10. Delete demo Customers (those created by seed)
      // Demo customers have email pattern *@demo.com
      const deletedCustomers = await tx.customer.deleteMany({
        where: {
          venueId,
          OR: [{ email: { endsWith: '@demo.com' } }, { email: null, phone: { startsWith: '555' } }],
        },
      })
      result.deletedCustomers = deletedCustomers.count
      logger.info(`  ✓ Deleted ${deletedCustomers.count} demo customers`)

      // 11. Reset remaining customers loyalty data (if any real customers were added)
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

      // 12. Reset table statuses to available
      await tx.table.updateMany({
        where: { venueId },
        data: {
          status: 'AVAILABLE',
          currentOrderId: null,
        },
      })
      logger.info(`  ✓ Reset all tables to AVAILABLE status`)
    },
    {
      timeout: 60000, // 60 second timeout for large cleanups
    },
  )

  logger.info(`🎉 Demo data cleanup complete for venue ${venueId}`)
  logger.info(`   Summary: ${result.deletedOrders} orders, ${result.deletedPayments} payments, ${result.deletedReviews} reviews`)

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
  // Check for demo indicators
  const [orderCount, demoCustomerCount, demoMerchantCount] = await Promise.all([
    prisma.order.count({
      where: {
        venueId,
        orderNumber: { startsWith: 'DEMO-' },
      },
    }),
    prisma.customer.count({
      where: {
        venueId,
        email: { endsWith: '@demo.com' },
      },
    }),
    prisma.merchantAccount.count({
      where: {
        OR: [{ externalMerchantId: { contains: 'demo' } }, { blumonSerialNumber: { startsWith: 'DEMO' } }],
      },
    }),
  ])

  return orderCount > 0 || demoCustomerCount > 0 || demoMerchantCount > 0
}
