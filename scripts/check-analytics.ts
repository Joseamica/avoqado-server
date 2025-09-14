#!/usr/bin/env tsx

/**
 * Analytics Validation Script
 *
 * Validates the seeded data by running analytics queries and checking that
 * key metrics are within expected ranges. This helps ensure the seed data
 * generates meaningful analytics for the frontend components.
 *
 * Usage:
 *   pnpm ts-node scripts/check-analytics.ts
 *   VENUE_SLUG=avoqado-centro pnpm ts-node scripts/check-analytics.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Validation thresholds
const EXPECTED_RANGES = {
  // Revenue metrics
  MIN_DAILY_REVENUE: 500,
  MAX_DAILY_REVENUE: 25000,
  MIN_AOV: 80,
  MAX_AOV: 1200,

  // Volume metrics
  MIN_ORDERS_PER_DAY: 5,
  MAX_ORDERS_PER_DAY: 100,
  MIN_ITEMS_PER_ORDER: 1,
  MAX_ITEMS_PER_ORDER: 8,

  // Customer satisfaction
  MIN_AVG_RATING: 3.5,
  MAX_AVG_RATING: 5.0,
  MIN_FIVE_STAR_PERCENTAGE: 40,
  MAX_FIVE_STAR_PERCENTAGE: 90,

  // Tips and payments
  MIN_TIP_PERCENTAGE: 5,
  MAX_TIP_PERCENTAGE: 30,
  MIN_CASH_RATIO: 10,
  MAX_CASH_RATIO: 40,

  // Data quality
  MIN_COMPLETION_RATE: 60,
  MIN_REVIEW_COVERAGE: 20,
  MAX_REVIEW_COVERAGE: 60,
}

interface MetricValidation {
  name: string
  value: number | string
  expected: string
  status: 'pass' | 'fail' | 'warn'
  details?: string
}

async function validateVenueMetrics(venueSlug: string) {
  console.log(`\n🔍 Validating analytics metrics for venue: ${venueSlug}`)

  const venue = await prisma.venue.findUnique({
    where: { slug: venueSlug },
    include: {
      orders: {
        include: {
          items: true,
          payments: true,
        },
      },
      payments: true,
      reviews: true,
    },
  })

  if (!venue) {
    throw new Error(`Venue with slug '${venueSlug}' not found`)
  }

  const validations: MetricValidation[] = []

  // ====================
  // REVENUE ANALYTICS
  // ====================

  // Calculate total revenue
  const totalRevenue = venue.payments.reduce((sum, payment) => sum + parseFloat(payment.amount.toString()), 0)

  // Calculate AOV
  const completedOrders = venue.orders.filter(o => o.status === 'COMPLETED')
  const avgOrderValue = completedOrders.length > 0 ? totalRevenue / completedOrders.length : 0

  validations.push({
    name: 'Average Order Value',
    value: `$${avgOrderValue.toFixed(2)}`,
    expected: `$${EXPECTED_RANGES.MIN_AOV} - $${EXPECTED_RANGES.MAX_AOV}`,
    status: avgOrderValue >= EXPECTED_RANGES.MIN_AOV && avgOrderValue <= EXPECTED_RANGES.MAX_AOV ? 'pass' : 'warn',
  })

  // Calculate daily revenue average
  const daysOfData = 90 // Assuming default seed period
  const dailyRevenueAvg = totalRevenue / daysOfData

  validations.push({
    name: 'Daily Revenue Average',
    value: `$${dailyRevenueAvg.toFixed(2)}`,
    expected: `$${EXPECTED_RANGES.MIN_DAILY_REVENUE} - $${EXPECTED_RANGES.MAX_DAILY_REVENUE}`,
    status: dailyRevenueAvg >= EXPECTED_RANGES.MIN_DAILY_REVENUE && dailyRevenueAvg <= EXPECTED_RANGES.MAX_DAILY_REVENUE ? 'pass' : 'warn',
  })

  // ====================
  // ORDER ANALYTICS
  // ====================

  // Calculate items per order
  const totalItems = venue.orders.reduce((sum, order) => sum + order.items.length, 0)
  const avgItemsPerOrder = venue.orders.length > 0 ? totalItems / venue.orders.length : 0

  validations.push({
    name: 'Items per Order',
    value: avgItemsPerOrder.toFixed(1),
    expected: `${EXPECTED_RANGES.MIN_ITEMS_PER_ORDER} - ${EXPECTED_RANGES.MAX_ITEMS_PER_ORDER}`,
    status:
      avgItemsPerOrder >= EXPECTED_RANGES.MIN_ITEMS_PER_ORDER && avgItemsPerOrder <= EXPECTED_RANGES.MAX_ITEMS_PER_ORDER ? 'pass' : 'warn',
  })

  // Order completion rate
  const completionRate = venue.orders.length > 0 ? (completedOrders.length / venue.orders.length) * 100 : 0

  validations.push({
    name: 'Order Completion Rate',
    value: `${completionRate.toFixed(1)}%`,
    expected: `>${EXPECTED_RANGES.MIN_COMPLETION_RATE}%`,
    status: completionRate >= EXPECTED_RANGES.MIN_COMPLETION_RATE ? 'pass' : 'fail',
  })

  // ====================
  // CUSTOMER SATISFACTION
  // ====================

  // Average rating
  const avgRating =
    venue.reviews.length > 0 ? venue.reviews.reduce((sum, review) => sum + review.overallRating, 0) / venue.reviews.length : 0

  validations.push({
    name: 'Average Rating',
    value: `${avgRating.toFixed(2)} ⭐`,
    expected: `${EXPECTED_RANGES.MIN_AVG_RATING} - ${EXPECTED_RANGES.MAX_AVG_RATING} ⭐`,
    status: avgRating >= EXPECTED_RANGES.MIN_AVG_RATING && avgRating <= EXPECTED_RANGES.MAX_AVG_RATING ? 'pass' : 'warn',
  })

  // Five star percentage
  const fiveStarReviews = venue.reviews.filter(r => r.overallRating === 5).length
  const fiveStarPercentage = venue.reviews.length > 0 ? (fiveStarReviews / venue.reviews.length) * 100 : 0

  validations.push({
    name: 'Five Star Reviews',
    value: `${fiveStarPercentage.toFixed(1)}% (${fiveStarReviews}/${venue.reviews.length})`,
    expected: `${EXPECTED_RANGES.MIN_FIVE_STAR_PERCENTAGE}% - ${EXPECTED_RANGES.MAX_FIVE_STAR_PERCENTAGE}%`,
    status:
      fiveStarPercentage >= EXPECTED_RANGES.MIN_FIVE_STAR_PERCENTAGE && fiveStarPercentage <= EXPECTED_RANGES.MAX_FIVE_STAR_PERCENTAGE
        ? 'pass'
        : 'warn',
  })

  // Review coverage
  const reviewCoverage = completedOrders.length > 0 ? (venue.reviews.length / completedOrders.length) * 100 : 0

  validations.push({
    name: 'Review Coverage',
    value: `${reviewCoverage.toFixed(1)}%`,
    expected: `${EXPECTED_RANGES.MIN_REVIEW_COVERAGE}% - ${EXPECTED_RANGES.MAX_REVIEW_COVERAGE}%`,
    status:
      reviewCoverage >= EXPECTED_RANGES.MIN_REVIEW_COVERAGE && reviewCoverage <= EXPECTED_RANGES.MAX_REVIEW_COVERAGE ? 'pass' : 'warn',
  })

  // ====================
  // TIP ANALYTICS
  // ====================

  // Calculate tip percentage
  const totalTips = venue.payments.reduce((sum, payment) => sum + parseFloat(payment.tipAmount.toString()), 0)
  const avgTipPercentage = totalRevenue > 0 ? (totalTips / (totalRevenue - totalTips)) * 100 : 0

  validations.push({
    name: 'Average Tip Percentage',
    value: `${avgTipPercentage.toFixed(1)}%`,
    expected: `${EXPECTED_RANGES.MIN_TIP_PERCENTAGE}% - ${EXPECTED_RANGES.MAX_TIP_PERCENTAGE}%`,
    status:
      avgTipPercentage >= EXPECTED_RANGES.MIN_TIP_PERCENTAGE && avgTipPercentage <= EXPECTED_RANGES.MAX_TIP_PERCENTAGE ? 'pass' : 'warn',
  })

  // ====================
  // PAYMENT METHOD ANALYTICS
  // ====================

  // Cash vs Card ratio
  const cashPayments = venue.payments.filter(p => p.method === 'CASH').length
  const cashRatio = venue.payments.length > 0 ? (cashPayments / venue.payments.length) * 100 : 0

  validations.push({
    name: 'Cash Payment Ratio',
    value: `${cashRatio.toFixed(1)}%`,
    expected: `${EXPECTED_RANGES.MIN_CASH_RATIO}% - ${EXPECTED_RANGES.MAX_CASH_RATIO}%`,
    status: cashRatio >= EXPECTED_RANGES.MIN_CASH_RATIO && cashRatio <= EXPECTED_RANGES.MAX_CASH_RATIO ? 'pass' : 'warn',
  })

  // ====================
  // DATA QUALITY CHECKS
  // ====================

  // Check for NULL values
  const ordersWithNullTotal = venue.orders.filter(o => !o.total || parseFloat(o.total.toString()) === 0).length
  validations.push({
    name: 'Data Quality: Non-null Totals',
    value: `${venue.orders.length - ordersWithNullTotal}/${venue.orders.length}`,
    expected: 'All orders should have valid totals',
    status: ordersWithNullTotal === 0 ? 'pass' : 'fail',
    details: ordersWithNullTotal > 0 ? `${ordersWithNullTotal} orders have null/zero totals` : undefined,
  })

  // Check for realistic date distribution
  const today = new Date()
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
  const recentOrders = venue.orders.filter(o => new Date(o.createdAt) >= thirtyDaysAgo).length
  const recentOrdersPercentage = venue.orders.length > 0 ? (recentOrders / venue.orders.length) * 100 : 0

  validations.push({
    name: 'Time Distribution',
    value: `${recentOrdersPercentage.toFixed(1)}% recent (30d)`,
    expected: '>20% recent orders',
    status: recentOrdersPercentage >= 20 ? 'pass' : 'warn',
  })

  return {
    venue: venue.name,
    validations,
    summary: {
      totalRevenue,
      totalOrders: venue.orders.length,
      totalPayments: venue.payments.length,
      totalReviews: venue.reviews.length,
      avgRating,
      avgOrderValue,
    },
  }
}

function printValidationResults(results: Awaited<ReturnType<typeof validateVenueMetrics>>) {
  console.log(`\n📊 Analytics Validation Results for: ${results.venue}`)
  console.log(`${'='.repeat(60)}`)

  console.log(`\n📈 Summary Metrics:`)
  console.log(`   Total Revenue: $${results.summary.totalRevenue.toFixed(2)}`)
  console.log(`   Total Orders: ${results.summary.totalOrders}`)
  console.log(`   Total Payments: ${results.summary.totalPayments}`)
  console.log(`   Total Reviews: ${results.summary.totalReviews}`)
  console.log(`   Average Rating: ${results.summary.avgRating.toFixed(2)} ⭐`)
  console.log(`   Average Order Value: $${results.summary.avgOrderValue.toFixed(2)}`)

  console.log(`\n🧪 Detailed Validations:`)
  console.log(`${'─'.repeat(60)}`)

  let passCount = 0
  let warnCount = 0
  let failCount = 0

  results.validations.forEach(validation => {
    const statusIcon = validation.status === 'pass' ? '✅' : validation.status === 'warn' ? '⚠️' : '❌'
    console.log(`${statusIcon} ${validation.name}`)
    console.log(`   Value: ${validation.value}`)
    console.log(`   Expected: ${validation.expected}`)
    if (validation.details) {
      console.log(`   Details: ${validation.details}`)
    }
    console.log()

    if (validation.status === 'pass') passCount++
    else if (validation.status === 'warn') warnCount++
    else failCount++
  })

  console.log(`${'─'.repeat(60)}`)
  console.log(`📋 Validation Summary:`)
  console.log(`   ✅ Passed: ${passCount}`)
  console.log(`   ⚠️  Warnings: ${warnCount}`)
  console.log(`   ❌ Failed: ${failCount}`)
  console.log(`   📊 Total: ${results.validations.length}`)

  const overallStatus = failCount === 0 ? (warnCount === 0 ? 'EXCELLENT' : 'GOOD') : 'NEEDS_ATTENTION'
  const statusIcon = overallStatus === 'EXCELLENT' ? '🎉' : overallStatus === 'GOOD' ? '👍' : '⚠️'

  console.log(`\n${statusIcon} Overall Status: ${overallStatus}`)

  if (overallStatus === 'EXCELLENT') {
    console.log(`🚀 All metrics are within expected ranges! Your analytics components should work perfectly.`)
  } else if (overallStatus === 'GOOD') {
    console.log(`✨ Most metrics look good. Some values are outside ideal ranges but should still provide meaningful analytics.`)
  } else {
    console.log(`🔧 Some metrics need attention. Consider adjusting seed configuration and re-running the seed.`)
  }

  return { passCount, warnCount, failCount, overallStatus }
}

async function main() {
  console.log('🧮 Analytics Validation Script')
  console.log('================================')

  try {
    // Get target venue from environment or use default
    const targetVenueSlug = process.env.VENUE_SLUG || 'avoqado-centro'

    console.log(`🎯 Target venue: ${targetVenueSlug}`)

    // Validate metrics for the target venue
    const results = await validateVenueMetrics(targetVenueSlug)
    const summary = printValidationResults(results)

    // Check if we should run for all venues
    if (!process.env.VENUE_SLUG) {
      console.log(`\n🏢 Running quick validation for other venues...`)

      const otherVenues = await prisma.venue.findMany({
        where: { slug: { not: targetVenueSlug } },
        select: { slug: true, name: true },
      })

      for (const venue of otherVenues.slice(0, 2)) {
        // Check first 2 other venues
        try {
          const otherResults = await validateVenueMetrics(venue.slug)
          console.log(
            `\n   ${venue.name}: ${otherResults.validations.filter(v => v.status === 'pass').length}/${otherResults.validations.length} validations passed`,
          )
        } catch (error) {
          console.log(`   ${venue.name}: Validation failed - ${error}`)
        }
      }
    }

    console.log(`\n✨ Validation completed!`)

    // Exit with appropriate code
    if (summary.failCount > 0) {
      process.exit(1)
    } else if (summary.warnCount > 3) {
      process.exit(1)
    } else {
      process.exit(0)
    }
  } catch (error) {
    console.error('❌ Validation script failed:', error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main()
}
