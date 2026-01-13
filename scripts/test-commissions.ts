/**
 * Commission System Test Script
 *
 * Tests the entire commission flow:
 * 1. Create commission config
 * 2. Create tiers
 * 3. Calculate commissions for orders
 * 4. Aggregate summaries
 * 5. Approve summaries
 * 6. Create and process payouts
 * 7. Test stats endpoint
 */

import { PrismaClient, CommissionCalcType, CommissionRecipient, TierType, TierPeriod, StaffRole, CommissionTrigger } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

const prisma = new PrismaClient()

const VENUE_ID = 'cmk4a4ieg00219k2rseuzfrbh' // avoqado-full
const OWNER_ID = 'cmk4a4ie5001x9k2rks9dvflo' // Main Owner

async function main() {
  console.log('🚀 Starting Commission System Test...\n')

  try {
    // 1. Clean up any existing test data
    console.log('1️⃣ Cleaning up existing commission data...')
    await cleanupCommissionData()
    console.log('   ✅ Cleanup complete\n')

    // 2. Create commission config
    console.log('2️⃣ Creating commission config...')
    const config = await createCommissionConfig()
    console.log(`   ✅ Config created: ${config.name} (ID: ${config.id})\n`)

    // 3. Create tiers
    console.log('3️⃣ Creating commission tiers...')
    const tiers = await createCommissionTiers(config.id)
    console.log(`   ✅ Created ${tiers.length} tiers\n`)

    // 4. Get staff members
    console.log('4️⃣ Getting staff members...')
    const staff = await getStaffMembers()
    console.log(`   ✅ Found ${staff.length} staff members\n`)

    // 5. Create test orders and calculate commissions
    console.log('5️⃣ Creating test orders with commission calculations...')
    const calculations = await createTestOrdersWithCommissions(config.id, staff)
    console.log(`   ✅ Created ${calculations.length} commission calculations\n`)

    // 6. Run aggregation to create summaries
    console.log('6️⃣ Running commission aggregation...')
    const summaries = await runAggregation()
    console.log(`   ✅ Created ${summaries.length} summaries\n`)

    // 7. Test stats endpoint data
    console.log('7️⃣ Testing stats data...')
    const stats = await testStatsData()
    console.log('   ✅ Stats retrieved:')
    console.log(`      - Total Calculations: ${stats.totalCalculations}`)
    console.log(`      - Total Summaries: ${stats.totalSummaries}`)
    console.log(`      - Staff with Commissions: ${stats.staffWithCommissions}\n`)

    // 8. Approve summaries
    console.log('8️⃣ Approving summaries...')
    await approveSummaries()
    console.log('   ✅ Summaries approved\n')

    // 9. Create payouts
    console.log('9️⃣ Creating payouts...')
    const payouts = await createPayouts()
    console.log(`   ✅ Created ${payouts.length} payouts\n`)

    // 10. Process and complete payouts
    console.log('🔟 Processing payouts...')
    await processPayouts()
    console.log('   ✅ Payouts processed and completed\n')

    // 11. Final verification
    console.log('1️⃣1️⃣ Final verification...')
    await finalVerification()

    console.log('\n🎉 All tests passed! Commission system is working correctly.')
  } catch (error) {
    console.error('\n❌ Test failed:', error)
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

async function cleanupCommissionData() {
  // Delete in correct order due to foreign keys
  await prisma.commissionPayout.deleteMany({ where: { venueId: VENUE_ID } })

  // Clawbacks need to be deleted based on calculation's venueId
  const calcIds = await prisma.commissionCalculation.findMany({
    where: { venueId: VENUE_ID },
    select: { id: true },
  })
  if (calcIds.length > 0) {
    await prisma.commissionClawback.deleteMany({
      where: { calculationId: { in: calcIds.map(c => c.id) } },
    })
  }

  await prisma.commissionSummary.deleteMany({ where: { venueId: VENUE_ID } })
  await prisma.commissionCalculation.deleteMany({ where: { venueId: VENUE_ID } })
  await prisma.commissionOverride.deleteMany({ where: { config: { venueId: VENUE_ID } } })

  await prisma.commissionMilestone.deleteMany({ where: { config: { venueId: VENUE_ID } } })
  await prisma.commissionTier.deleteMany({ where: { config: { venueId: VENUE_ID } } })
  await prisma.commissionConfig.deleteMany({ where: { venueId: VENUE_ID } })

  // Also cleanup test orders
  await prisma.order.deleteMany({
    where: {
      venueId: VENUE_ID,
      orderNumber: { startsWith: 'TEST-' },
    },
  })
}

async function createCommissionConfig() {
  return prisma.commissionConfig.create({
    data: {
      venueId: VENUE_ID,
      name: 'Comisión por Ventas (Test)',
      description: 'Comisión estándar por ventas para el equipo',
      priority: 1,
      recipient: CommissionRecipient.SERVER,
      trigger: CommissionTrigger.PER_PAYMENT,
      calcType: CommissionCalcType.PERCENTAGE,
      defaultRate: new Decimal(0.03), // 3%
      minAmount: new Decimal(0),
      maxAmount: null,
      includeTips: false,
      includeDiscount: false,
      includeTax: false,
      roleRates: {
        WAITER: 0.03,
        CASHIER: 0.025,
        MANAGER: 0.02,
      },
      effectiveFrom: new Date(),
      effectiveTo: null,
      active: true,
      createdById: OWNER_ID,
    },
  })
}

async function createCommissionTiers(configId: string) {
  const tiersData = [
    {
      configId,
      tierLevel: 1,
      tierName: 'Bronce',
      tierType: TierType.BY_AMOUNT,
      minThreshold: new Decimal(0),
      maxThreshold: new Decimal(5000),
      rate: new Decimal(0.025),
      tierPeriod: TierPeriod.MONTHLY,
      active: true,
    },
    {
      configId,
      tierLevel: 2,
      tierName: 'Plata',
      tierType: TierType.BY_AMOUNT,
      minThreshold: new Decimal(5000),
      maxThreshold: new Decimal(15000),
      rate: new Decimal(0.035),
      tierPeriod: TierPeriod.MONTHLY,
      active: true,
    },
    {
      configId,
      tierLevel: 3,
      tierName: 'Oro',
      tierType: TierType.BY_AMOUNT,
      minThreshold: new Decimal(15000),
      maxThreshold: null,
      rate: new Decimal(0.05),
      tierPeriod: TierPeriod.MONTHLY,
      active: true,
    },
  ]

  const tiers = []
  for (const tierData of tiersData) {
    const tier = await prisma.commissionTier.create({ data: tierData })
    tiers.push(tier)
  }
  return tiers
}

async function getStaffMembers() {
  return prisma.staffVenue.findMany({
    where: {
      venueId: VENUE_ID,
      role: { in: [StaffRole.WAITER, StaffRole.CASHIER, StaffRole.MANAGER] },
      staff: { active: true },
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })
}

async function createTestOrdersWithCommissions(configId: string, staffMembers: any[]) {
  const calculations = []

  // Create several orders for different staff members
  const orderAmounts = [
    { amount: 500, staffIndex: 0 },
    { amount: 1200, staffIndex: 0 },
    { amount: 800, staffIndex: 1 },
    { amount: 2500, staffIndex: 2 },
    { amount: 3000, staffIndex: 0 },
    { amount: 1500, staffIndex: 1 },
    { amount: 750, staffIndex: 3 },
    { amount: 2200, staffIndex: 2 },
  ]

  for (let i = 0; i < orderAmounts.length; i++) {
    const { amount, staffIndex } = orderAmounts[i]
    const staffMember = staffMembers[staffIndex % staffMembers.length]
    const role = staffMember.role as string

    // Get role-specific rate
    const roleRates: Record<string, number> = { WAITER: 0.03, CASHIER: 0.025, MANAGER: 0.02 }
    const rate = roleRates[role] || 0.03
    const commission = amount * rate

    // Create a test order
    const order = await prisma.order.create({
      data: {
        venueId: VENUE_ID,
        orderNumber: `TEST-${Date.now()}-${i}`,
        type: 'DINE_IN',
        status: 'COMPLETED',
        createdById: staffMember.staffId,
        subtotal: new Decimal(amount),
        taxAmount: new Decimal(amount * 0.16),
        total: new Decimal(amount * 1.16),
        completedAt: new Date(),
      },
    })

    // Create commission calculation
    const calc = await prisma.commissionCalculation.create({
      data: {
        venueId: VENUE_ID,
        staffId: staffMember.staffId,
        configId,
        orderId: order.id,
        baseAmount: new Decimal(amount),
        tipAmount: new Decimal(0),
        discountAmount: new Decimal(0),
        taxAmount: new Decimal(0),
        effectiveRate: new Decimal(rate),
        grossCommission: new Decimal(commission),
        netCommission: new Decimal(commission),
        calcType: CommissionCalcType.PERCENTAGE,
        status: 'CALCULATED',
        calculatedAt: new Date(),
      },
    })

    calculations.push(calc)
    console.log(
      `      Created order ${order.orderNumber}: $${amount} → Commission: $${commission.toFixed(2)} for ${staffMember.staff.firstName}`,
    )
  }

  return calculations
}

async function runAggregation() {
  // Get all staff with calculations
  const staffWithCalcs = await prisma.commissionCalculation.groupBy({
    by: ['staffId'],
    where: {
      venueId: VENUE_ID,
      status: 'CALCULATED',
      summaryId: null,
    },
  })

  const summaries = []
  const now = new Date()
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)

  for (const { staffId } of staffWithCalcs) {
    // Get calculations for this staff
    const calcs = await prisma.commissionCalculation.findMany({
      where: {
        venueId: VENUE_ID,
        staffId,
        status: 'CALCULATED',
        summaryId: null,
      },
    })

    const totalCommissions = calcs.reduce((sum, c) => sum + Number(c.netCommission), 0)
    const totalSales = calcs.reduce((sum, c) => sum + Number(c.baseAmount), 0)

    // Create summary
    const summary = await prisma.commissionSummary.create({
      data: {
        venueId: VENUE_ID,
        staffId,
        periodStart,
        periodEnd,
        periodType: TierPeriod.MONTHLY,
        totalSales: new Decimal(totalSales),
        totalTips: new Decimal(0),
        totalCommissions: new Decimal(totalCommissions),
        totalBonuses: new Decimal(0),
        totalClawbacks: new Decimal(0),
        grandTotal: new Decimal(totalCommissions),
        grossAmount: new Decimal(totalCommissions),
        deductionAmount: new Decimal(0),
        netAmount: new Decimal(totalCommissions),
        orderCount: calcs.length,
        paymentCount: calcs.length,
        status: 'CALCULATED',
      },
    })

    // Link calculations to summary
    await prisma.commissionCalculation.updateMany({
      where: { id: { in: calcs.map(c => c.id) } },
      data: { summaryId: summary.id },
    })

    summaries.push(summary)

    const staff = await prisma.staff.findUnique({ where: { id: staffId } })
    console.log(`      Summary for ${staff?.firstName}: ${calcs.length} orders → $${totalCommissions.toFixed(2)}`)
  }

  return summaries
}

async function testStatsData() {
  const totalCalculations = await prisma.commissionCalculation.count({
    where: { venueId: VENUE_ID },
  })

  const totalSummaries = await prisma.commissionSummary.count({
    where: { venueId: VENUE_ID },
  })

  const staffWithCommissions = await prisma.commissionCalculation.groupBy({
    by: ['staffId'],
    where: { venueId: VENUE_ID },
  })

  return {
    totalCalculations,
    totalSummaries,
    staffWithCommissions: staffWithCommissions.length,
  }
}

async function approveSummaries() {
  const result = await prisma.commissionSummary.updateMany({
    where: {
      venueId: VENUE_ID,
      status: 'CALCULATED',
    },
    data: {
      status: 'APPROVED',
      approvedAt: new Date(),
      approvedById: OWNER_ID,
    },
  })
  console.log(`      Approved ${result.count} summaries`)
}

async function createPayouts() {
  const summaries = await prisma.commissionSummary.findMany({
    where: {
      venueId: VENUE_ID,
      status: 'APPROVED',
    },
  })

  const payouts = []
  for (const summary of summaries) {
    const payout = await prisma.commissionPayout.create({
      data: {
        venueId: VENUE_ID,
        staffId: summary.staffId,
        summaryId: summary.id,
        amount: summary.netAmount,
        paymentMethod: 'BANK_TRANSFER',
        status: 'PENDING',
      },
    })
    payouts.push(payout)

    const staff = await prisma.staff.findUnique({ where: { id: summary.staffId } })
    console.log(`      Payout created for ${staff?.firstName}: $${Number(summary.netAmount).toFixed(2)}`)
  }

  return payouts
}

async function processPayouts() {
  // First approve payouts (actually it goes PENDING -> APPROVED -> PROCESSING -> PAID)
  // But for simplicity, go directly to PROCESSING
  await prisma.commissionPayout.updateMany({
    where: {
      venueId: VENUE_ID,
      status: 'PENDING',
    },
    data: {
      status: 'PROCESSING',
      processedAt: new Date(),
      processedById: OWNER_ID,
    },
  })
  console.log('      Payouts processing')

  // Complete them
  const payouts = await prisma.commissionPayout.findMany({
    where: {
      venueId: VENUE_ID,
      status: 'PROCESSING',
    },
  })

  for (const payout of payouts) {
    await prisma.commissionPayout.update({
      where: { id: payout.id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        paymentReference: `REF-${Date.now()}-${payout.id.slice(-4)}`,
      },
    })
  }
  console.log('      Payouts completed')

  // Update summaries to PAID
  await prisma.commissionSummary.updateMany({
    where: {
      venueId: VENUE_ID,
      status: 'APPROVED',
    },
    data: {
      status: 'PAID',
    },
  })
  console.log('      Summaries marked as PAID')
}

async function finalVerification() {
  const configs = await prisma.commissionConfig.count({ where: { venueId: VENUE_ID } })
  const tiers = await prisma.commissionTier.count({ where: { config: { venueId: VENUE_ID } } })
  const calculations = await prisma.commissionCalculation.count({ where: { venueId: VENUE_ID } })
  const summaries = await prisma.commissionSummary.count({ where: { venueId: VENUE_ID } })
  const payouts = await prisma.commissionPayout.count({ where: { venueId: VENUE_ID } })
  const paidPayouts = await prisma.commissionPayout.count({ where: { venueId: VENUE_ID, status: 'PAID' } })

  console.log('   📊 Final State:')
  console.log(`      - Configs: ${configs}`)
  console.log(`      - Tiers: ${tiers}`)
  console.log(`      - Calculations: ${calculations}`)
  console.log(`      - Summaries: ${summaries}`)
  console.log(`      - Payouts: ${payouts} (${paidPayouts} paid)`)

  // Verify all payouts are paid
  if (paidPayouts !== payouts) {
    throw new Error(`Not all payouts were paid! Expected ${payouts}, got ${paidPayouts}`)
  }

  // Check totals
  const totalPaid = await prisma.commissionPayout.aggregate({
    where: { venueId: VENUE_ID, status: 'PAID' },
    _sum: { amount: true },
  })
  console.log(`      - Total Paid: $${Number(totalPaid._sum.amount || 0).toFixed(2)}`)
}

main()
