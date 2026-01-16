/**
 * Test Revenue Calculation
 *
 * Verifica que los cálculos del dashboard de revenue sean correctos
 */

import { PrismaClient } from '@prisma/client'
import { DateTime } from 'luxon'

const prisma = new PrismaClient()

async function testRevenueCalculation() {
  console.log('🔍 TESTING REVENUE CALCULATION\n')

  // Usar el mes actual
  const startDate = DateTime.now().startOf('month').toJSDate()
  const endDate = DateTime.now().toJSDate()

  console.log(`📅 Período: ${DateTime.fromJSDate(startDate).toFormat('yyyy-MM-dd')} to ${DateTime.fromJSDate(endDate).toFormat('yyyy-MM-dd')}\n`)

  // 1. PAGOS COMPLETADOS (base para todo)
  const payments = await prisma.payment.findMany({
    where: {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
      status: 'COMPLETED',
    },
    include: {
      order: {
        include: {
          venue: true,
        },
      },
    },
  })

  console.log('💰 PAYMENT DATA:')
  console.log(`   Total payments: ${payments.length}`)

  const totalAmount = payments.reduce((sum, p) => sum + Number(p.amount), 0)
  const totalFees = payments.reduce((sum, p) => sum + Number(p.feeAmount || 0), 0)

  console.log(`   Total amount: $${totalAmount.toFixed(2)}`)
  console.log(`   Total fees (actual): $${totalFees.toFixed(2)}`)
  console.log(`   Average order value: $${(totalAmount / payments.length).toFixed(2)}\n`)

  // 2. COMISIÓN CALCULADA (15% del total)
  const calculatedCommission = totalAmount * 0.15
  console.log('📊 COMMISSION CALCULATION:')
  console.log(`   Calculated commission (15%): $${calculatedCommission.toFixed(2)}`)
  console.log(`   Actual fees collected: $${totalFees.toFixed(2)}`)
  console.log(`   ⚠️  Difference: $${(calculatedCommission - totalFees).toFixed(2)}`)
  console.log(`   ⚠️  This is expected if commission rate varies by venue\n`)

  // 3. SUBSCRIPTION REVENUE
  const activeVenues = await prisma.venue.findMany({
    where: {
      status: {
        in: ['ONBOARDING', 'PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'ADMIN_SUSPENDED', 'CLOSED'],
        notIn: ['LIVE_DEMO', 'TRIAL'],
      },
      createdAt: {
        lte: endDate,
      },
    },
    select: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
    },
  })

  console.log('🏢 SUBSCRIPTION REVENUE:')
  console.log(`   Production venues: ${activeVenues.length}`)

  const monthlyFeePerVenue = 99
  let totalSubscriptionRevenue = 0

  for (const venue of activeVenues) {
    const venueActiveStartDate = venue.createdAt > startDate ? venue.createdAt : startDate
    const daysActive = Math.ceil((endDate.getTime() - venueActiveStartDate.getTime()) / (1000 * 60 * 60 * 24))
    const dailyRate = monthlyFeePerVenue / 30
    const proratedRevenue = dailyRate * Math.max(0, daysActive)

    totalSubscriptionRevenue += proratedRevenue

    console.log(`   - ${venue.name} (${venue.status}): ${daysActive} days active = $${proratedRevenue.toFixed(2)}`)
  }

  console.log(`   Total subscription revenue: $${totalSubscriptionRevenue.toFixed(2)}\n`)

  // 4. FEATURE REVENUE
  const venueFeatures = await prisma.venueFeature.findMany({
    where: {
      active: true,
      startDate: {
        lte: endDate,
      },
      OR: [
        { endDate: null },
        { endDate: { gte: startDate } },
      ],
    },
    include: {
      feature: true,
      venue: true,
    },
  })

  console.log('✨ FEATURE REVENUE:')
  console.log(`   Active venue features: ${venueFeatures.length}`)

  let totalFeatureRevenue = 0
  const monthsInPeriod = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 30)))

  for (const vf of venueFeatures) {
    const monthlyPrice = Number(vf.monthlyPrice || vf.feature.monthlyPrice || 0)
    const revenue = monthlyPrice * monthsInPeriod
    totalFeatureRevenue += revenue

    console.log(`   - ${vf.venue.name}: ${vf.feature.name} ($${monthlyPrice}/month × ${monthsInPeriod} months) = $${revenue.toFixed(2)}`)
  }

  console.log(`   Total feature revenue: $${totalFeatureRevenue.toFixed(2)}\n`)

  // 5. REVENUE BY VENUE
  const venueRevenueMap = new Map()

  payments.forEach(payment => {
    const venue = payment.order.venue
    const venueId = venue.id
    const amount = Number(payment.amount)

    if (!venueRevenueMap.has(venueId)) {
      venueRevenueMap.set(venueId, {
        venueName: venue.name,
        revenue: 0,
        commission: 0,
        transactionCount: 0,
      })
    }

    const venueRevenue = venueRevenueMap.get(venueId)
    venueRevenue.revenue += amount
    venueRevenue.commission += amount * 0.15
    venueRevenue.transactionCount += 1
  })

  console.log('🏪 REVENUE BY VENUE:')
  Array.from(venueRevenueMap.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .forEach(([venueId, data]) => {
      console.log(`   - ${data.venueName}:`)
      console.log(`     Revenue: $${data.revenue.toFixed(2)}`)
      console.log(`     Commission (15%): $${data.commission.toFixed(2)}`)
      console.log(`     Transactions: ${data.transactionCount}`)
      console.log(`     Avg order value: $${(data.revenue / data.transactionCount).toFixed(2)}`)
    })

  console.log('\n')

  // 6. SUMMARY
  console.log('📈 SUMMARY:')
  console.log(`   Total Revenue (payment amount): $${totalAmount.toFixed(2)}`)
  console.log(`   Commission Revenue (15%): $${calculatedCommission.toFixed(2)}`)
  console.log(`   Subscription Revenue: $${totalSubscriptionRevenue.toFixed(2)}`)
  console.log(`   Feature Revenue: $${totalFeatureRevenue.toFixed(2)}`)
  console.log(`   Transaction Count: ${payments.length}`)
  console.log(`   Average Order Value: $${(totalAmount / payments.length).toFixed(2)}`)

  console.log('\n⚠️  POTENTIAL ISSUES TO CHECK:')
  console.log('   1. Commission is hardcoded to 15% but actual fees may vary by venue')
  console.log('   2. Subscription revenue is prorated but may need to check billing cycles')
  console.log('   3. Feature revenue calculation multiplies by months which may inflate numbers')
  console.log('   4. No growth rate validation (requires previous period data)')
}

testRevenueCalculation()
  .then(() => {
    console.log('\n✅ Test completed')
    process.exit(0)
  })
  .catch(error => {
    console.error('❌ Test failed:', error)
    process.exit(1)
  })
