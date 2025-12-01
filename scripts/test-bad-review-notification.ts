/**
 * Test script for bad review notification system
 *
 * Usage: npx ts-node -r tsconfig-paths/register scripts/test-bad-review-notification.ts
 *
 * This script tests the notification flow without creating actual reviews.
 */

import { StaffRole } from '@prisma/client'
import prisma from '../src/utils/prismaClient'
import {
  shouldNotifyBadReview,
  sendBadReviewNotifications,
  BadReviewContext,
} from '../src/services/dashboard/badReviewNotification.service'

async function testBadReviewNotifications() {
  console.log('🧪 Testing Bad Review Notification System\n')

  // Find a venue to test with - use Avoqado Full specifically
  const venue = await prisma.venue.findFirst({
    where: { active: true, name: { contains: 'Full' } },
    include: {
      settings: true,
    },
  })

  if (!venue) {
    console.log('❌ No active venue found for testing')
    process.exit(1)
  }

  console.log(`📍 Testing with venue: ${venue.name} (${venue.id})\n`)

  // Check current settings
  console.log('📊 Current VenueSettings:')
  console.log(`   - notifyBadReviews: ${venue.settings?.notifyBadReviews ?? 'not set (default: true)'}`)
  console.log(`   - badReviewThreshold: ${venue.settings?.badReviewThreshold ?? 'not set (default: 3)'}`)
  console.log(`   - badReviewAlertRoles: ${JSON.stringify(venue.settings?.badReviewAlertRoles ?? ['OWNER', 'ADMIN', 'MANAGER'])}`)
  console.log()

  // Test shouldNotifyBadReview for different ratings
  console.log('🔍 Testing shouldNotifyBadReview() for different ratings:\n')

  for (const rating of [1, 2, 3, 4, 5]) {
    const result = await shouldNotifyBadReview(venue.id, rating)
    const icon = result.shouldNotify ? '🔔' : '🔕'
    console.log(
      `   Rating ${rating}: ${icon} shouldNotify=${result.shouldNotify} (threshold=${result.threshold}, roles=${result.alertRoles.join(',')})`,
    )
  }

  // Find staff that would receive notifications
  const alertRoles = (venue.settings?.badReviewAlertRoles ?? ['OWNER', 'ADMIN', 'MANAGER']) as StaffRole[]
  const staffToNotify = await prisma.staffVenue.findMany({
    where: {
      venueId: venue.id,
      active: true,
      role: {
        in: alertRoles,
      },
    },
    select: {
      role: true,
      staff: {
        select: {
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  console.log('\n👥 Staff who would receive notifications:')
  if (staffToNotify.length === 0) {
    console.log('   ⚠️  No staff found with configured roles!')
  } else {
    for (const sv of staffToNotify) {
      console.log(`   - ${sv.staff.firstName} ${sv.staff.lastName} (${sv.role}) - ${sv.staff.email}`)
    }
  }

  // Ask user if they want to send a test notification
  console.log('\n' + '='.repeat(60))
  console.log('📨 SEND TEST NOTIFICATION?')
  console.log('='.repeat(60))
  console.log('\nTo send a test notification, run with --send flag:')
  console.log('npx ts-node -r tsconfig-paths/register scripts/test-bad-review-notification.ts --send')

  if (process.argv.includes('--send')) {
    console.log('\n🚀 Sending test notification...\n')

    const testContext: BadReviewContext = {
      reviewId: 'test-review-' + Date.now(),
      venueId: venue.id,
      venueName: venue.name,
      venueSlug: venue.slug,
      rating: 2,
      comment: 'Esta es una prueba del sistema de notificaciones. La comida estaba fría y el servicio fue lento.',
      customerName: 'Cliente de Prueba',
      customerEmail: 'test@example.com',
      tableNumber: '5',
      orderNumber: 'TEST-001',
      orderId: null,
      waiterName: 'Mesero de Prueba',
      waiterId: null,
      foodRating: 2,
      serviceRating: 1,
      ambienceRating: 3,
    }

    console.log('📋 Test context:')
    console.log(JSON.stringify(testContext, null, 2))
    console.log()

    try {
      await sendBadReviewNotifications(testContext)
      console.log('\n✅ Test notification sent successfully!')
      console.log('   Check the dashboard and emails of the staff members listed above.')
    } catch (error) {
      console.error('\n❌ Error sending test notification:', error)
    }
  }

  await prisma.$disconnect()
}

testBadReviewNotifications().catch(error => {
  console.error('Test failed:', error)
  process.exit(1)
})
