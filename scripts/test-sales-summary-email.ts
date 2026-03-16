/**
 * Test script to send a sales summary email with REAL data from the database
 * Run with: npx ts-node scripts/test-sales-summary-email.ts
 *
 * Uses the same logic as the nightly job but for a single venue.
 */

import '../src/config/env'
import { NightlySalesSummaryJob } from '../src/jobs/nightly-sales-summary.job'

async function sendTestEmail() {
  // Use the actual nightly job with a specific venue
  // Pass a venueId to only process that one venue
  const job = new NightlySalesSummaryJob()

  // Find an active venue to test with
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()

  try {
    // Get the first active venue with recent orders
    const venue = await prisma.venue.findFirst({
      where: {
        status: { in: ['ACTIVE', 'TRIAL', 'LIVE_DEMO'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, slug: true },
    })

    if (!venue) {
      console.error('No active venues found')
      process.exit(1)
    }

    console.log(`Testing with venue: ${venue.name} (${venue.id})`)
    console.log('Running nightly sales summary job for this venue...\n')

    const result = await job.runNow(venue.id)

    console.log('\nJob completed:')
    console.log(`  Venues processed: ${result.venuesProcessed}`)
    console.log(`  Emails sent: ${result.emailsSent}`)
    console.log(`  Errors: ${result.errors}`)
  } catch (error) {
    console.error('Failed:', error)
  } finally {
    await prisma.$disconnect()
    process.exit(0)
  }
}

sendTestEmail()
