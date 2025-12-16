/**
 * Test Script: OrderCustomer Race Conditions & Idempotency
 *
 * This script tests the fixes for:
 * 1. Race condition in addCustomerToOrder (multiple primaries)
 * 2. Race condition in createAndAddCustomerToOrder
 * 3. Partial unique index on isPrimary
 * 4. Idempotency in earnPoints (no double-earning)
 *
 * Run: npx ts-node scripts/test-order-customer-race-conditions.ts
 */

import prisma from '../src/utils/prismaClient'
import { addCustomerToOrder, createAndAddCustomerToOrder, getOrderCustomers } from '../src/services/tpv/order.tpv.service'
import { earnPoints } from '../src/services/dashboard/loyalty.dashboard.service'
import { OrderStatus, OrderType, PaymentStatus } from '@prisma/client'

// Test results tracking
interface TestResult {
  name: string
  passed: boolean
  error?: string
  details?: string
}

const results: TestResult[] = []

// Helper to create test data
async function createTestVenue() {
  // Find or create a test organization
  let org = await prisma.organization.findFirst({
    where: { name: 'Test Org - Race Conditions' },
  })

  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: 'Test Org - Race Conditions',
        email: `test-race-${Date.now()}@test.com`,
        phone: '5551234567',
      },
    })
  }

  const venue = await prisma.venue.create({
    data: {
      organizationId: org.id,
      name: `Test Venue Race ${Date.now()}`,
      slug: `test-venue-race-${Date.now()}`,
      address: 'Test Address',
      timezone: 'America/Mexico_City',
      status: 'TRIAL', // VenueStatus enum
    },
  })

  return venue
}

async function createTestCustomers(venueId: string, count: number) {
  const customers = []
  for (let i = 0; i < count; i++) {
    const customer = await prisma.customer.create({
      data: {
        venueId,
        firstName: `TestCustomer${i}`,
        lastName: `Race${Date.now()}`,
        email: `test${i}-${Date.now()}@test.com`,
      },
    })
    customers.push(customer)
  }
  return customers
}

async function createTestOrder(venueId: string) {
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: `TEST-RACE-${Date.now()}`,
      type: OrderType.DINE_IN,
      status: OrderStatus.CONFIRMED, // Using CONFIRMED as "open" order state
      paymentStatus: PaymentStatus.PENDING,
      subtotal: 100,
      taxAmount: 16,
      total: 116,
    },
  })
}

// ============================================
// TEST 1: Partial Unique Index
// ============================================
async function testPartialUniqueIndex() {
  console.log('\n🧪 TEST 1: Partial Unique Index on isPrimary')
  console.log('='.repeat(50))

  const venue = await createTestVenue()
  const customers = await createTestCustomers(venue.id, 2)
  const order = await createTestOrder(venue.id)

  try {
    // Create first customer as primary
    await prisma.orderCustomer.create({
      data: {
        orderId: order.id,
        customerId: customers[0].id,
        isPrimary: true,
      },
    })
    console.log('✅ First customer created as primary')

    // Try to create second customer as primary (should fail due to partial unique index)
    try {
      await prisma.orderCustomer.create({
        data: {
          orderId: order.id,
          customerId: customers[1].id,
          isPrimary: true, // This should violate the partial unique index
        },
      })
      // If we get here, the index didn't work
      results.push({
        name: 'Partial Unique Index',
        passed: false,
        error: 'Second primary was created - index not working!',
      })
      console.log('❌ FAILED: Second primary was created!')
    } catch (error: any) {
      if (error.code === 'P2002') {
        results.push({
          name: 'Partial Unique Index',
          passed: true,
          details: 'Correctly rejected second primary with P2002',
        })
        console.log('✅ PASSED: Database correctly rejected second primary')
      } else {
        results.push({
          name: 'Partial Unique Index',
          passed: false,
          error: `Unexpected error: ${error.message}`,
        })
        console.log(`❌ FAILED: Unexpected error: ${error.message}`)
      }
    }
  } finally {
    // Cleanup
    await prisma.orderCustomer.deleteMany({ where: { orderId: order.id } })
    await prisma.order.delete({ where: { id: order.id } })
    await prisma.customer.deleteMany({ where: { venueId: venue.id } })
    await prisma.venue.delete({ where: { id: venue.id } })
  }
}

// ============================================
// TEST 2: Concurrent addCustomerToOrder
// ============================================
async function testConcurrentAddCustomerToOrder() {
  console.log('\n🧪 TEST 2: Concurrent addCustomerToOrder (Race Condition)')
  console.log('='.repeat(50))

  const venue = await createTestVenue()
  const customers = await createTestCustomers(venue.id, 5)
  const order = await createTestOrder(venue.id)

  try {
    // Launch 5 concurrent requests to add different customers
    console.log('🚀 Launching 5 concurrent addCustomerToOrder calls...')

    const promises = customers.map(customer =>
      addCustomerToOrder(venue.id, order.id, customer.id).catch(err => ({
        error: err.message,
        customerId: customer.id,
      })),
    )

    const results_concurrent = await Promise.all(promises)

    // Check how many succeeded
    const successes = results_concurrent.filter(r => !('error' in r))
    const failures = results_concurrent.filter(r => 'error' in r)

    console.log(`\n📊 Results: ${successes.length} successes, ${failures.length} failures`)

    // Verify only ONE primary exists
    const orderCustomers = await prisma.orderCustomer.findMany({
      where: { orderId: order.id },
    })

    const primaryCount = orderCustomers.filter(oc => oc.isPrimary).length

    console.log(`📊 Total customers added: ${orderCustomers.length}`)
    console.log(`📊 Primary customers: ${primaryCount}`)

    if (primaryCount === 1) {
      results.push({
        name: 'Concurrent addCustomerToOrder',
        passed: true,
        details: `${orderCustomers.length} customers added, exactly 1 primary`,
      })
      console.log('✅ PASSED: Exactly 1 primary customer')
    } else {
      results.push({
        name: 'Concurrent addCustomerToOrder',
        passed: false,
        error: `Expected 1 primary, found ${primaryCount}`,
      })
      console.log(`❌ FAILED: Expected 1 primary, found ${primaryCount}`)
    }
  } finally {
    // Cleanup
    await prisma.orderCustomer.deleteMany({ where: { orderId: order.id } })
    await prisma.order.delete({ where: { id: order.id } })
    await prisma.customer.deleteMany({ where: { venueId: venue.id } })
    await prisma.venue.delete({ where: { id: venue.id } })
  }
}

// ============================================
// TEST 3: Concurrent createAndAddCustomerToOrder
// ============================================
async function testConcurrentCreateAndAddCustomer() {
  console.log('\n🧪 TEST 3: Concurrent createAndAddCustomerToOrder (Race Condition)')
  console.log('='.repeat(50))

  const venue = await createTestVenue()
  const order = await createTestOrder(venue.id)

  try {
    // Launch 3 concurrent requests to create and add customers
    console.log('🚀 Launching 3 concurrent createAndAddCustomerToOrder calls...')

    const customerData = [
      { firstName: 'ConcurrentA', phone: `555${Date.now()}1` },
      { firstName: 'ConcurrentB', phone: `555${Date.now()}2` },
      { firstName: 'ConcurrentC', phone: `555${Date.now()}3` },
    ]

    const promises = customerData.map(data =>
      createAndAddCustomerToOrder(venue.id, order.id, data).catch(err => ({
        error: err.message,
        data,
      })),
    )

    const results_concurrent = await Promise.all(promises)

    // Check results
    const successes = results_concurrent.filter(r => !('error' in r))
    const failures = results_concurrent.filter(r => 'error' in r)

    console.log(`\n📊 Results: ${successes.length} successes, ${failures.length} failures`)

    // Verify only ONE primary exists
    const orderCustomers = await prisma.orderCustomer.findMany({
      where: { orderId: order.id },
    })

    const primaryCount = orderCustomers.filter(oc => oc.isPrimary).length

    console.log(`📊 Total customers created and added: ${orderCustomers.length}`)
    console.log(`📊 Primary customers: ${primaryCount}`)

    if (primaryCount <= 1) {
      results.push({
        name: 'Concurrent createAndAddCustomerToOrder',
        passed: true,
        details: `${orderCustomers.length} customers, ${primaryCount} primary`,
      })
      console.log('✅ PASSED: At most 1 primary customer')
    } else {
      results.push({
        name: 'Concurrent createAndAddCustomerToOrder',
        passed: false,
        error: `Expected ≤1 primary, found ${primaryCount}`,
      })
      console.log(`❌ FAILED: Expected ≤1 primary, found ${primaryCount}`)
    }
  } finally {
    // Cleanup - get customers created for this order first
    const orderCustomers = await prisma.orderCustomer.findMany({
      where: { orderId: order.id },
      select: { customerId: true },
    })
    const customerIds = orderCustomers.map(oc => oc.customerId)

    await prisma.orderCustomer.deleteMany({ where: { orderId: order.id } })
    await prisma.order.delete({ where: { id: order.id } })
    if (customerIds.length > 0) {
      await prisma.customer.deleteMany({ where: { id: { in: customerIds } } })
    }
    await prisma.venue.delete({ where: { id: venue.id } })
  }
}

// ============================================
// TEST 4: earnPoints Idempotency
// ============================================
async function testEarnPointsIdempotency() {
  console.log('\n🧪 TEST 4: earnPoints Idempotency (No Double-Earning)')
  console.log('='.repeat(50))

  const venue = await createTestVenue()
  const customers = await createTestCustomers(venue.id, 1)
  const customer = customers[0]
  const order = await createTestOrder(venue.id)

  // Create loyalty config for venue
  await prisma.loyaltyConfig.create({
    data: {
      venueId: venue.id,
      pointsPerDollar: 1,
      pointsPerVisit: 0,
      redemptionRate: 0.01,
      minPointsRedeem: 100,
      active: true,
    },
  })

  try {
    const orderTotal = 100 // Should earn 100 points

    // First call - should earn points
    console.log('📞 First earnPoints call...')
    const result1 = await earnPoints(venue.id, customer.id, orderTotal, order.id)
    console.log(`   Points earned: ${result1.pointsEarned}, Balance: ${result1.newBalance}`)

    // Second call (simulating retry) - should be idempotent
    console.log('📞 Second earnPoints call (simulating retry)...')
    const result2 = await earnPoints(venue.id, customer.id, orderTotal, order.id)
    console.log(`   Points earned: ${result2.pointsEarned}, Balance: ${result2.newBalance}`)

    // Third call - triple check
    console.log('📞 Third earnPoints call (triple check)...')
    const result3 = await earnPoints(venue.id, customer.id, orderTotal, order.id)
    console.log(`   Points earned: ${result3.pointsEarned}, Balance: ${result3.newBalance}`)

    // Verify only one transaction was created
    const transactions = await prisma.loyaltyTransaction.findMany({
      where: {
        customerId: customer.id,
        orderId: order.id,
        type: 'EARN',
      },
    })

    console.log(`\n📊 Total EARN transactions for this order: ${transactions.length}`)

    // Verify customer balance
    const updatedCustomer = await prisma.customer.findUnique({
      where: { id: customer.id },
      select: { loyaltyPoints: true },
    })

    console.log(`📊 Customer final balance: ${updatedCustomer?.loyaltyPoints}`)

    if (transactions.length === 1 && updatedCustomer?.loyaltyPoints === 100) {
      results.push({
        name: 'earnPoints Idempotency',
        passed: true,
        details: '3 calls resulted in exactly 1 transaction and 100 points',
      })
      console.log('✅ PASSED: Idempotency working correctly')
    } else {
      results.push({
        name: 'earnPoints Idempotency',
        passed: false,
        error: `Expected 1 transaction/100 points, got ${transactions.length} transactions/${updatedCustomer?.loyaltyPoints} points`,
      })
      console.log(`❌ FAILED: Expected 1 transaction, got ${transactions.length}`)
    }
  } finally {
    // Cleanup
    await prisma.loyaltyTransaction.deleteMany({ where: { customerId: customer.id } })
    await prisma.loyaltyConfig.deleteMany({ where: { venueId: venue.id } })
    await prisma.orderCustomer.deleteMany({ where: { orderId: order.id } })
    await prisma.order.delete({ where: { id: order.id } })
    await prisma.customer.deleteMany({ where: { venueId: venue.id } })
    await prisma.venue.delete({ where: { id: venue.id } })
  }
}

// ============================================
// TEST 5: Concurrent earnPoints
// ============================================
async function testConcurrentEarnPoints() {
  console.log('\n🧪 TEST 5: Concurrent earnPoints (Race Condition)')
  console.log('='.repeat(50))

  const venue = await createTestVenue()
  const customers = await createTestCustomers(venue.id, 1)
  const customer = customers[0]
  const order = await createTestOrder(venue.id)

  // Create loyalty config for venue
  await prisma.loyaltyConfig.create({
    data: {
      venueId: venue.id,
      pointsPerDollar: 1,
      pointsPerVisit: 0,
      redemptionRate: 0.01,
      minPointsRedeem: 100,
      active: true,
    },
  })

  try {
    const orderTotal = 100

    // Launch 5 concurrent earnPoints calls for the same order
    console.log('🚀 Launching 5 concurrent earnPoints calls for same order...')

    const promises = Array(5)
      .fill(null)
      .map(() =>
        earnPoints(venue.id, customer.id, orderTotal, order.id).catch(err => ({
          error: err.message,
        })),
      )

    const results_concurrent = await Promise.all(promises)

    // Check how many succeeded vs returned cached result
    console.log('\n📊 Concurrent call results:')
    results_concurrent.forEach((r, i) => {
      if ('error' in r) {
        console.log(`   Call ${i + 1}: ERROR - ${r.error}`)
      } else {
        console.log(`   Call ${i + 1}: Points=${r.pointsEarned}, Balance=${r.newBalance}`)
      }
    })

    // Verify only one transaction was created
    const transactions = await prisma.loyaltyTransaction.findMany({
      where: {
        customerId: customer.id,
        orderId: order.id,
        type: 'EARN',
      },
    })

    const updatedCustomer = await prisma.customer.findUnique({
      where: { id: customer.id },
      select: { loyaltyPoints: true },
    })

    console.log(`\n📊 Total EARN transactions: ${transactions.length}`)
    console.log(`📊 Customer final balance: ${updatedCustomer?.loyaltyPoints}`)

    if (transactions.length === 1 && updatedCustomer?.loyaltyPoints === 100) {
      results.push({
        name: 'Concurrent earnPoints',
        passed: true,
        details: '5 concurrent calls resulted in exactly 1 transaction',
      })
      console.log('✅ PASSED: Only 1 transaction created despite 5 concurrent calls')
    } else {
      results.push({
        name: 'Concurrent earnPoints',
        passed: false,
        error: `Expected 1 transaction/100 points, got ${transactions.length}/${updatedCustomer?.loyaltyPoints}`,
      })
      console.log(`❌ FAILED: Got ${transactions.length} transactions`)
    }
  } finally {
    // Cleanup
    await prisma.loyaltyTransaction.deleteMany({ where: { customerId: customer.id } })
    await prisma.loyaltyConfig.deleteMany({ where: { venueId: venue.id } })
    await prisma.orderCustomer.deleteMany({ where: { orderId: order.id } })
    await prisma.order.delete({ where: { id: order.id } })
    await prisma.customer.deleteMany({ where: { venueId: venue.id } })
    await prisma.venue.delete({ where: { id: venue.id } })
  }
}

// ============================================
// TEST 6: Primary Promotion on Remove
// ============================================
async function testPrimaryPromotionOnRemove() {
  console.log('\n🧪 TEST 6: Primary Promotion When Removing Primary Customer')
  console.log('='.repeat(50))

  const venue = await createTestVenue()
  const customers = await createTestCustomers(venue.id, 3)
  const order = await createTestOrder(venue.id)

  try {
    // Add customers sequentially (first is primary)
    console.log('Adding 3 customers sequentially...')
    await addCustomerToOrder(venue.id, order.id, customers[0].id)
    await addCustomerToOrder(venue.id, order.id, customers[1].id)
    await addCustomerToOrder(venue.id, order.id, customers[2].id)

    // Verify first is primary
    let orderCustomers = await prisma.orderCustomer.findMany({
      where: { orderId: order.id },
      orderBy: { addedAt: 'asc' },
    })

    console.log('\nBefore removal:')
    orderCustomers.forEach((oc, i) => {
      const customer = customers.find(c => c.id === oc.customerId)
      console.log(`   ${i + 1}. ${customer?.firstName} - isPrimary: ${oc.isPrimary}`)
    })

    // Import removeCustomerFromOrder
    const { removeCustomerFromOrder } = await import('../src/services/tpv/order.tpv.service')

    // Remove the primary customer
    console.log('\nRemoving primary customer...')
    await removeCustomerFromOrder(venue.id, order.id, customers[0].id)

    // Verify next customer is now primary
    orderCustomers = await prisma.orderCustomer.findMany({
      where: { orderId: order.id },
      orderBy: { addedAt: 'asc' },
    })

    console.log('\nAfter removal:')
    orderCustomers.forEach((oc, i) => {
      const customer = customers.find(c => c.id === oc.customerId)
      console.log(`   ${i + 1}. ${customer?.firstName} - isPrimary: ${oc.isPrimary}`)
    })

    const primaryCount = orderCustomers.filter(oc => oc.isPrimary).length
    const newPrimary = orderCustomers.find(oc => oc.isPrimary)
    const expectedPrimaryId = customers[1].id // Second customer should be promoted

    if (primaryCount === 1 && newPrimary?.customerId === expectedPrimaryId) {
      results.push({
        name: 'Primary Promotion on Remove',
        passed: true,
        details: 'Second customer correctly promoted to primary',
      })
      console.log('✅ PASSED: Primary correctly promoted')
    } else {
      results.push({
        name: 'Primary Promotion on Remove',
        passed: false,
        error: `Primary count: ${primaryCount}, New primary: ${newPrimary?.customerId}`,
      })
      console.log(`❌ FAILED: Unexpected primary state`)
    }
  } finally {
    // Cleanup
    await prisma.orderCustomer.deleteMany({ where: { orderId: order.id } })
    await prisma.order.delete({ where: { id: order.id } })
    await prisma.customer.deleteMany({ where: { venueId: venue.id } })
    await prisma.venue.delete({ where: { id: venue.id } })
  }
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('🧪 OrderCustomer & Loyalty Race Condition Tests')
  console.log('='.repeat(60))
  console.log('Testing fixes for:')
  console.log('  1. Partial unique index on isPrimary')
  console.log('  2. Serializable transactions in addCustomerToOrder')
  console.log('  3. Serializable transactions in createAndAddCustomerToOrder')
  console.log('  4. Idempotency in earnPoints')
  console.log('  5. Concurrent earnPoints calls')
  console.log('  6. Primary promotion on customer removal')
  console.log('='.repeat(60))

  try {
    await testPartialUniqueIndex()
    await testConcurrentAddCustomerToOrder()
    await testConcurrentCreateAndAddCustomer()
    await testEarnPointsIdempotency()
    await testConcurrentEarnPoints()
    await testPrimaryPromotionOnRemove()
  } catch (error) {
    console.error('\n❌ Test suite failed with error:', error)
  }

  // Print summary
  console.log('\n')
  console.log('='.repeat(60))
  console.log('📊 TEST SUMMARY')
  console.log('='.repeat(60))

  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length

  results.forEach(r => {
    const icon = r.passed ? '✅' : '❌'
    console.log(`${icon} ${r.name}`)
    if (r.details) console.log(`   Details: ${r.details}`)
    if (r.error) console.log(`   Error: ${r.error}`)
  })

  console.log('\n' + '='.repeat(60))
  console.log(`TOTAL: ${passed} passed, ${failed} failed`)
  console.log('='.repeat(60))

  await prisma.$disconnect()

  // Exit with error code if any test failed
  if (failed > 0) {
    process.exit(1)
  }
}

main()
