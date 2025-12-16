/**
 * Test Script: OrderCustomer Edge Cases & Stress Tests
 *
 * Additional tests for edge cases:
 * 1. Stress test with 10 concurrent adds
 * 2. Cannot add same customer twice
 * 3. Removing all customers leaves no primary
 * 4. Full payment flow with loyalty points
 * 5. Multiple removes and promotions
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/test-order-customer-edge-cases.ts
 */

import prisma from '../src/utils/prismaClient'
import { addCustomerToOrder, removeCustomerFromOrder, getOrderCustomers } from '../src/services/tpv/order.tpv.service'
import { earnPoints } from '../src/services/dashboard/loyalty.dashboard.service'
import { OrderStatus, OrderType, PaymentStatus } from '@prisma/client'

interface TestResult {
  name: string
  passed: boolean
  error?: string
  details?: string
}

const results: TestResult[] = []

// Helper functions
async function createTestVenue() {
  let org = await prisma.organization.findFirst({
    where: { name: 'Test Org - Edge Cases' },
  })

  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: 'Test Org - Edge Cases',
        email: `test-edge-${Date.now()}@test.com`,
        phone: '5559876543',
      },
    })
  }

  const venue = await prisma.venue.create({
    data: {
      organizationId: org.id,
      name: `Test Venue Edge ${Date.now()}`,
      slug: `test-venue-edge-${Date.now()}`,
      address: 'Test Address',
      timezone: 'America/Mexico_City',
      status: 'TRIAL',
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
        firstName: `EdgeCustomer${i}`,
        lastName: `Test${Date.now()}`,
        email: `edge${i}-${Date.now()}@test.com`,
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
      orderNumber: `TEST-EDGE-${Date.now()}`,
      type: OrderType.DINE_IN,
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PENDING,
      subtotal: 100,
      taxAmount: 16,
      total: 116,
    },
  })
}

async function cleanup(venueId: string, orderIds: string[], customerIds: string[]) {
  // Delete in correct order to respect foreign keys
  await prisma.loyaltyTransaction.deleteMany({ where: { customerId: { in: customerIds } } })
  await prisma.orderCustomer.deleteMany({ where: { orderId: { in: orderIds } } })
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.venue.delete({ where: { id: venueId } })
}

// ============================================
// TEST 1: Stress Test - 10 Concurrent Adds
// ============================================
async function testStressConcurrentAdds() {
  console.log('\n🧪 TEST 1: Stress Test - 10 Concurrent Adds')
  console.log('='.repeat(50))

  const venue = await createTestVenue()
  const customers = await createTestCustomers(venue.id, 10)
  const order = await createTestOrder(venue.id)

  try {
    console.log('🚀 Launching 10 concurrent addCustomerToOrder calls...')

    const promises = customers.map(customer =>
      addCustomerToOrder(venue.id, order.id, customer.id).catch(err => ({
        error: err.message,
        customerId: customer.id,
      })),
    )

    const concurrent_results = await Promise.all(promises)

    const successes = concurrent_results.filter(r => !('error' in r))
    const failures = concurrent_results.filter(r => 'error' in r)

    console.log(`\n📊 Results: ${successes.length} successes, ${failures.length} failures`)

    const orderCustomers = await prisma.orderCustomer.findMany({
      where: { orderId: order.id },
    })

    const primaryCount = orderCustomers.filter(oc => oc.isPrimary).length

    console.log(`📊 Total customers added: ${orderCustomers.length}`)
    console.log(`📊 Primary customers: ${primaryCount}`)

    if (primaryCount === 1) {
      results.push({
        name: 'Stress Test - 10 Concurrent Adds',
        passed: true,
        details: `${orderCustomers.length} customers added, exactly 1 primary`,
      })
      console.log('✅ PASSED: Exactly 1 primary customer')
    } else {
      results.push({
        name: 'Stress Test - 10 Concurrent Adds',
        passed: false,
        error: `Expected 1 primary, found ${primaryCount}`,
      })
      console.log(`❌ FAILED: Expected 1 primary, found ${primaryCount}`)
    }
  } finally {
    await cleanup(
      venue.id,
      [order.id],
      customers.map(c => c.id),
    )
  }
}

// ============================================
// TEST 2: Cannot Add Same Customer Twice
// ============================================
async function testCannotAddSameCustomerTwice() {
  console.log('\n🧪 TEST 2: Cannot Add Same Customer Twice')
  console.log('='.repeat(50))

  const venue = await createTestVenue()
  const customers = await createTestCustomers(venue.id, 1)
  const order = await createTestOrder(venue.id)
  const customer = customers[0]

  try {
    // First add should succeed
    console.log('📞 First add...')
    await addCustomerToOrder(venue.id, order.id, customer.id)
    console.log('   ✅ First add succeeded')

    // Second add should fail
    console.log('📞 Second add (should fail)...')
    try {
      await addCustomerToOrder(venue.id, order.id, customer.id)
      results.push({
        name: 'Cannot Add Same Customer Twice',
        passed: false,
        error: 'Second add succeeded when it should have failed',
      })
      console.log('   ❌ Second add succeeded (BAD!)')
    } catch (error: any) {
      if (error.message.includes('already added')) {
        results.push({
          name: 'Cannot Add Same Customer Twice',
          passed: true,
          details: 'Correctly rejected duplicate customer',
        })
        console.log('   ✅ Correctly rejected with: ' + error.message)
      } else {
        results.push({
          name: 'Cannot Add Same Customer Twice',
          passed: false,
          error: `Unexpected error: ${error.message}`,
        })
        console.log('   ❌ Unexpected error: ' + error.message)
      }
    }
  } finally {
    await cleanup(venue.id, [order.id], [customer.id])
  }
}

// ============================================
// TEST 3: Remove All Customers - No Primary Left
// ============================================
async function testRemoveAllCustomers() {
  console.log('\n🧪 TEST 3: Remove All Customers - No Primary Left')
  console.log('='.repeat(50))

  const venue = await createTestVenue()
  const customers = await createTestCustomers(venue.id, 3)
  const order = await createTestOrder(venue.id)

  try {
    // Add all customers
    console.log('Adding 3 customers...')
    for (const customer of customers) {
      await addCustomerToOrder(venue.id, order.id, customer.id)
    }

    const orderCustomers = await getOrderCustomers(venue.id, order.id)
    console.log(`Added ${orderCustomers.length} customers`)

    // Remove all one by one
    console.log('\nRemoving all customers one by one...')
    for (let i = 0; i < customers.length; i++) {
      const remaining = await prisma.orderCustomer.findMany({
        where: { orderId: order.id },
        orderBy: { addedAt: 'asc' },
      })

      if (remaining.length === 0) break

      const toRemove = remaining[0]
      console.log(`   Removing customer ${i + 1} (isPrimary: ${toRemove.isPrimary})...`)
      await removeCustomerFromOrder(venue.id, order.id, toRemove.customerId)

      const afterRemove = await prisma.orderCustomer.findMany({
        where: { orderId: order.id },
      })

      const primaryCount = afterRemove.filter(oc => oc.isPrimary).length
      console.log(`   Remaining: ${afterRemove.length}, Primary count: ${primaryCount}`)

      // After each removal, should have at most 1 primary (or 0 if empty)
      if (primaryCount > 1) {
        results.push({
          name: 'Remove All Customers',
          passed: false,
          error: `Multiple primaries after removal: ${primaryCount}`,
        })
        console.log('❌ FAILED: Multiple primaries')
        return
      }
    }

    // Final check - should be empty
    const finalCustomers = await prisma.orderCustomer.findMany({
      where: { orderId: order.id },
    })

    if (finalCustomers.length === 0) {
      results.push({
        name: 'Remove All Customers',
        passed: true,
        details: 'All customers removed successfully, promotions worked correctly',
      })
      console.log('✅ PASSED: All customers removed, promotions correct')
    } else {
      results.push({
        name: 'Remove All Customers',
        passed: false,
        error: `Expected 0 customers, found ${finalCustomers.length}`,
      })
      console.log(`❌ FAILED: Expected 0 customers, found ${finalCustomers.length}`)
    }
  } finally {
    await cleanup(
      venue.id,
      [order.id],
      customers.map(c => c.id),
    )
  }
}

// ============================================
// TEST 4: Full Payment Flow with Loyalty Points
// ============================================
async function testFullPaymentFlow() {
  console.log('\n🧪 TEST 4: Full Payment Flow with Loyalty Points')
  console.log('='.repeat(50))

  const venue = await createTestVenue()
  const customers = await createTestCustomers(venue.id, 2)
  const order = await createTestOrder(venue.id)

  // Create loyalty config
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
    // Step 1: Add customers (first is primary)
    console.log('Step 1: Adding 2 customers...')
    await addCustomerToOrder(venue.id, order.id, customers[0].id)
    await addCustomerToOrder(venue.id, order.id, customers[1].id)

    const orderCustomers = await getOrderCustomers(venue.id, order.id)
    const primary = orderCustomers.find((oc: any) => oc.isPrimary)
    console.log(`   Primary customer: ${primary?.customer.firstName}`)

    // Step 2: Simulate payment completion - award points to primary
    console.log('\nStep 2: Completing payment and awarding points...')
    const orderTotal = 100
    const loyaltyResult = await earnPoints(venue.id, customers[0].id, orderTotal, order.id)
    console.log(`   Points awarded to primary: ${loyaltyResult.pointsEarned}`)
    console.log(`   Primary new balance: ${loyaltyResult.newBalance}`)

    // Verify secondary didn't get points
    const secondaryCustomer = await prisma.customer.findUnique({
      where: { id: customers[1].id },
      select: { loyaltyPoints: true },
    })
    console.log(`   Secondary balance: ${secondaryCustomer?.loyaltyPoints}`)

    // Verify only primary got points
    if (loyaltyResult.pointsEarned === 100 && secondaryCustomer?.loyaltyPoints === 0) {
      results.push({
        name: 'Full Payment Flow',
        passed: true,
        details: 'Primary received 100 points, secondary received 0',
      })
      console.log('✅ PASSED: Loyalty points awarded correctly')
    } else {
      results.push({
        name: 'Full Payment Flow',
        passed: false,
        error: `Primary: ${loyaltyResult.pointsEarned}, Secondary: ${secondaryCustomer?.loyaltyPoints}`,
      })
      console.log('❌ FAILED: Unexpected point distribution')
    }
  } finally {
    await cleanup(
      venue.id,
      [order.id],
      customers.map(c => c.id),
    )
  }
}

// ============================================
// TEST 5: Multiple Concurrent Orders Same Customer
// ============================================
async function testMultipleConcurrentOrdersSameCustomer() {
  console.log('\n🧪 TEST 5: Same Customer Added to Multiple Orders Concurrently')
  console.log('='.repeat(50))

  const venue = await createTestVenue()
  const customers = await createTestCustomers(venue.id, 1)
  const customer = customers[0]

  // Create 5 orders
  const orders = []
  for (let i = 0; i < 5; i++) {
    const order = await prisma.order.create({
      data: {
        venueId: venue.id,
        orderNumber: `TEST-MULTI-${Date.now()}-${i}`,
        type: OrderType.DINE_IN,
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PENDING,
        subtotal: 100,
        taxAmount: 16,
        total: 116,
      },
    })
    orders.push(order)
  }

  try {
    // Add same customer to all 5 orders concurrently
    console.log('🚀 Adding same customer to 5 different orders concurrently...')

    const promises = orders.map(order =>
      addCustomerToOrder(venue.id, order.id, customer.id).catch(err => ({
        error: err.message,
        orderId: order.id,
      })),
    )

    const concurrent_results = await Promise.all(promises)

    const successes = concurrent_results.filter(r => !('error' in r))
    const failures = concurrent_results.filter(r => 'error' in r)

    console.log(`\n📊 Results: ${successes.length} successes, ${failures.length} failures`)

    // All should succeed - same customer can be in multiple orders
    if (successes.length === 5) {
      // Verify customer is primary in all orders
      let allPrimary = true
      for (const order of orders) {
        const oc = await prisma.orderCustomer.findFirst({
          where: { orderId: order.id, customerId: customer.id },
        })
        if (!oc?.isPrimary) {
          allPrimary = false
          console.log(`   Order ${order.orderNumber}: isPrimary=${oc?.isPrimary}`)
        }
      }

      if (allPrimary) {
        results.push({
          name: 'Same Customer Multiple Orders',
          passed: true,
          details: 'Customer is primary in all 5 orders',
        })
        console.log('✅ PASSED: Customer is primary in all orders')
      } else {
        results.push({
          name: 'Same Customer Multiple Orders',
          passed: false,
          error: 'Customer not primary in all orders',
        })
        console.log('❌ FAILED: Customer not primary in all orders')
      }
    } else {
      results.push({
        name: 'Same Customer Multiple Orders',
        passed: false,
        error: `Expected 5 successes, got ${successes.length}`,
      })
      console.log(`❌ FAILED: Some adds failed`)
    }
  } finally {
    await cleanup(
      venue.id,
      orders.map(o => o.id),
      [customer.id],
    )
  }
}

// ============================================
// TEST 6: Verify No Orphan Records After Cascade Delete
// ============================================
async function testCascadeDelete() {
  console.log('\n🧪 TEST 6: Cascade Delete - No Orphan Records')
  console.log('='.repeat(50))

  const venue = await createTestVenue()
  const customers = await createTestCustomers(venue.id, 2)
  const order = await createTestOrder(venue.id)

  try {
    // Add customers to order
    console.log('Adding customers to order...')
    await addCustomerToOrder(venue.id, order.id, customers[0].id)
    await addCustomerToOrder(venue.id, order.id, customers[1].id)

    const beforeDelete = await prisma.orderCustomer.count({
      where: { orderId: order.id },
    })
    console.log(`OrderCustomer records before delete: ${beforeDelete}`)

    // Delete the order (should cascade to OrderCustomer)
    console.log('Deleting order...')
    await prisma.order.delete({ where: { id: order.id } })

    // Verify OrderCustomer records are also deleted
    const afterDelete = await prisma.orderCustomer.count({
      where: { orderId: order.id },
    })
    console.log(`OrderCustomer records after delete: ${afterDelete}`)

    if (afterDelete === 0) {
      results.push({
        name: 'Cascade Delete',
        passed: true,
        details: 'OrderCustomer records deleted with Order',
      })
      console.log('✅ PASSED: Cascade delete worked correctly')
    } else {
      results.push({
        name: 'Cascade Delete',
        passed: false,
        error: `Found ${afterDelete} orphan OrderCustomer records`,
      })
      console.log('❌ FAILED: Orphan records exist')
    }
  } finally {
    // Cleanup (order already deleted)
    await prisma.customer.deleteMany({ where: { id: { in: customers.map(c => c.id) } } })
    await prisma.venue.delete({ where: { id: venue.id } })
  }
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('🧪 OrderCustomer Edge Cases & Stress Tests')
  console.log('='.repeat(60))
  console.log('Testing edge cases:')
  console.log('  1. Stress test with 10 concurrent adds')
  console.log('  2. Cannot add same customer twice')
  console.log('  3. Remove all customers - promotions work')
  console.log('  4. Full payment flow with loyalty points')
  console.log('  5. Same customer in multiple orders')
  console.log('  6. Cascade delete - no orphans')
  console.log('='.repeat(60))

  try {
    await testStressConcurrentAdds()
    await testCannotAddSameCustomerTwice()
    await testRemoveAllCustomers()
    await testFullPaymentFlow()
    await testMultipleConcurrentOrdersSameCustomer()
    await testCascadeDelete()
  } catch (error) {
    console.error('\n❌ Test suite failed with error:', error)
  }

  // Print summary
  console.log('\n')
  console.log('='.repeat(60))
  console.log('📊 EDGE CASE TEST SUMMARY')
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

  if (failed > 0) {
    process.exit(1)
  }
}

main()
