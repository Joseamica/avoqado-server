/**
 * Cleanup Old Checkout Sessions
 *
 * Deletes checkout sessions older than specified days (default: 7 days)
 * Useful for keeping development database clean
 *
 * Usage:
 *   npm run dev:clean-sessions
 *   npm run dev:clean-sessions -- --days=30
 *   npm run dev:clean-sessions -- --dry-run
 */

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

interface CleanupOptions {
  days: number
  dryRun: boolean
}

async function parseArgs(): Promise<CleanupOptions> {
  const args = process.argv.slice(2)
  const options: CleanupOptions = {
    days: 7, // Default: delete sessions older than 7 days
    dryRun: false,
  }

  for (const arg of args) {
    if (arg.startsWith('--days=')) {
      options.days = parseInt(arg.split('=')[1], 10)
    }
    if (arg === '--dry-run') {
      options.dryRun = true
    }
  }

  return options
}

async function cleanupOldSessions() {
  console.log('\n🧹 Cleanup Old Checkout Sessions\n')
  console.log('='.repeat(60))

  const options = await parseArgs()

  // Calculate cutoff date
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - options.days)

  console.log(`\n📅 Cutoff Date: ${cutoffDate.toISOString()}`)
  console.log(`   Sessions older than ${options.days} days will be deleted`)

  if (options.dryRun) {
    console.log('\n⚠️  DRY RUN MODE - No changes will be made\n')
  }

  try {
    // Find sessions to delete
    const sessionsToDelete = await prisma.checkoutSession.findMany({
      where: {
        createdAt: {
          lt: cutoffDate,
        },
      },
      select: {
        id: true,
        sessionId: true,
        status: true,
        amount: true,
        createdAt: true,
        ecommerceMerchant: {
          select: {
            channelName: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    })

    if (sessionsToDelete.length === 0) {
      console.log('✅ No sessions found older than the cutoff date')
      console.log('   Nothing to clean up!\n')
      return
    }

    // Show sessions to be deleted
    console.log(`\n📊 Found ${sessionsToDelete.length} sessions to delete:\n`)

    // Group by status
    const grouped = sessionsToDelete.reduce(
      (acc, session) => {
        acc[session.status] = (acc[session.status] || 0) + 1
        return acc
      },
      {} as Record<string, number>,
    )

    for (const [status, count] of Object.entries(grouped)) {
      console.log(`   ${status}: ${count} sessions`)
    }

    // Show sample sessions
    console.log(`\n📝 Sample sessions (first 5):\n`)
    sessionsToDelete.slice(0, 5).forEach(session => {
      console.log(`   ${session.sessionId}`)
      console.log(`      Status: ${session.status}`)
      console.log(`      Amount: $${session.amount}`)
      console.log(`      Merchant: ${session.ecommerceMerchant.channelName}`)
      console.log(`      Created: ${session.createdAt.toISOString()}`)
      console.log('')
    })

    if (options.dryRun) {
      console.log('🔍 DRY RUN: Would delete these sessions (but not actually deleting)\n')
      return
    }

    // Confirm deletion
    console.log(`⚠️  About to delete ${sessionsToDelete.length} sessions`)
    console.log('   Press Ctrl+C to cancel, or wait 3 seconds to continue...\n')

    await new Promise(resolve => setTimeout(resolve, 3000))

    // Delete sessions
    const deleteResult = await prisma.checkoutSession.deleteMany({
      where: {
        createdAt: {
          lt: cutoffDate,
        },
      },
    })

    console.log(`✅ Deleted ${deleteResult.count} checkout sessions\n`)

    // Show remaining sessions
    const remainingSessions = await prisma.checkoutSession.count()
    console.log(`📊 Remaining sessions: ${remainingSessions}`)

    logger.info('Cleanup completed', {
      deletedCount: deleteResult.count,
      remainingCount: remainingSessions,
      cutoffDate: cutoffDate.toISOString(),
    })
  } catch (error: any) {
    console.error('\n❌ Error during cleanup:', error.message)
    logger.error('Cleanup failed', { error: error.message })
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

// Run cleanup
cleanupOldSessions()
  .then(() => {
    console.log('🎉 Cleanup complete!\n')
    process.exit(0)
  })
  .catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
