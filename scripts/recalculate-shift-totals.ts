/**
 * Script to recalculate shift totals from existing payments
 *
 * This script:
 * 1. Finds all shifts with associated payments
 * 2. Recalculates totalSales and totalTips from payment records
 * 3. Updates shift records with correct totals
 *
 * Run with: npx ts-node -r tsconfig-paths/register scripts/recalculate-shift-totals.ts
 */

import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

async function recalculateShiftTotals() {
  try {
    logger.info('🔄 Starting shift totals recalculation...')

    // Get all shifts with their payments
    const shifts = await prisma.shift.findMany({
      include: {
        payments: {
          where: {
            status: 'COMPLETED',
          },
        },
      },
    })

    logger.info(`📊 Found ${shifts.length} shifts to process`)

    let updatedCount = 0
    let skippedCount = 0

    for (const shift of shifts) {
      // Calculate totals from payments
      const totalSales = shift.payments.reduce((sum, payment) => sum + Number(payment.amount), 0)
      const totalTips = shift.payments.reduce((sum, payment) => sum + Number(payment.tipAmount || 0), 0)
      const totalOrders = shift.payments.length

      // Check if update is needed
      const currentTotalSales = Number(shift.totalSales)
      const currentTotalTips = Number(shift.totalTips)
      const currentTotalOrders = shift.totalOrders

      if (currentTotalSales !== totalSales || currentTotalTips !== totalTips || currentTotalOrders !== totalOrders) {
        // Update shift with calculated totals
        await prisma.shift.update({
          where: { id: shift.id },
          data: {
            totalSales,
            totalTips,
            totalOrders,
          },
        })

        logger.info(`✅ Updated shift ${shift.id}`, {
          before: { sales: currentTotalSales, tips: currentTotalTips, orders: currentTotalOrders },
          after: { sales: totalSales, tips: totalTips, orders: totalOrders },
        })

        updatedCount++
      } else {
        skippedCount++
      }
    }

    logger.info('🎉 Shift totals recalculation completed!', {
      total: shifts.length,
      updated: updatedCount,
      skipped: skippedCount,
    })
  } catch (error) {
    logger.error('❌ Error recalculating shift totals:', error)
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

// Run the migration
recalculateShiftTotals()
  .then(() => {
    logger.info('✨ Migration script finished successfully')
    process.exit(0)
  })
  .catch(error => {
    logger.error('💥 Migration script failed:', error)
    process.exit(1)
  })
