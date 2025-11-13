// ⚠️ DELETE AFTER: Testing automatic shift close calculations
// Purpose: Verify shift open/close with automatic payment/inventory/products calculation
// Created: 2025-11-11
// Delete when: Shift management FASE 1 testing complete

import prisma from '../src/utils/prismaClient'
import { openShiftForVenue, closeShiftForVenue } from '../src/services/tpv/shift.tpv.service'
import { Decimal } from '@prisma/client/runtime/library'

const VENUE_ID = 'cmhtrvsvk00ad9krx8gb9jgbq' // avoqado-full

interface TestResult {
  step: string
  success: boolean
  details?: any
  error?: string
}

const results: TestResult[] = []

function logStep(step: string, success: boolean, details?: any, error?: string) {
  const result: TestResult = { step, success, details, error }
  results.push(result)

  const emoji = success ? '✅' : '❌'
  console.log(`${emoji} ${step}`)
  if (details) console.log('   Details:', JSON.stringify(details, null, 2))
  if (error) console.log('   Error:', error)
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function testShiftAutomaticClose() {
  console.log('\n🔄 SHIFT AUTOMATIC CLOSE - TESTING\n')
  console.log('═'.repeat(70))

  let shiftId: string | null = null
  let orderId: string | null = null
  let staffId: string | null = null

  try {
    // ========================================
    // STEP 1: Find test staff member
    // ========================================
    console.log('\n👤 STEP 1: Finding staff member...')

    const staff = await prisma.staff.findFirst({
      where: {
        venues: {
          some: {
            venueId: VENUE_ID,
          },
        },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
      },
    })

    if (!staff) {
      logStep('Find Staff', false, null, 'No staff found for venue')
      return
    }

    staffId = staff.id
    logStep('Find Staff', true, { staffId, name: `${staff.firstName} ${staff.lastName}` })

    // ========================================
    // STEP 2: Open new shift
    // ========================================
    console.log('\n🚪 STEP 2: Opening shift...')

    const shift = await openShiftForVenue(VENUE_ID, staffId, 100, undefined, undefined)

    shiftId = shift.id
    logStep('Open Shift', true, {
      shiftId,
      startTime: shift.startTime,
      startingCash: shift.startingCash.toString(),
    })

    await sleep(500)

    // ========================================
    // STEP 3: Create test order with items
    // ========================================
    console.log('\n📦 STEP 3: Creating test order...')

    // Get a product to use
    const product = await prisma.product.findFirst({
      where: {
        venueId: VENUE_ID,
        active: true,
      },
      select: {
        id: true,
        name: true,
        price: true,
      },
    })

    if (!product) {
      logStep('Find Product', false, null, 'No active products found')
      return
    }

    // Create order
    const order = await prisma.order.create({
      data: {
        venueId: VENUE_ID,
        shiftId: shiftId,
        staffId: staffId,
        total: new Decimal(product.price).mul(2), // 2 items
        subtotal: new Decimal(product.price).mul(2),
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        items: {
          create: [
            {
              productId: product.id,
              productName: product.name,
              quantity: 2,
              unitPrice: product.price,
              subtotal: new Decimal(product.price).mul(2),
            },
          ],
        },
      },
    })

    orderId = order.id
    logStep('Create Order', true, {
      orderId,
      total: order.total.toString(),
      items: 2,
    })

    // ========================================
    // STEP 4: Create payments (CASH + CARD)
    // ========================================
    console.log('\n💳 STEP 4: Creating payments...')

    const cashPayment = new Decimal(product.price) // Half payment in cash
    const cardPayment = new Decimal(product.price) // Half payment in card

    // Create CASH payment
    await prisma.payment.create({
      data: {
        orderId: orderId,
        shiftId: shiftId,
        venueId: VENUE_ID,
        amount: cashPayment,
        tipAmount: new Decimal(10), // $10 tip
        method: 'CASH',
        status: 'COMPLETED',
        processedById: staffId,
      },
    })

    // Create CARD payment
    await prisma.payment.create({
      data: {
        orderId: orderId,
        shiftId: shiftId,
        venueId: VENUE_ID,
        amount: cardPayment,
        tipAmount: new Decimal(5), // $5 tip
        method: 'CARD',
        status: 'COMPLETED',
        processedById: staffId,
      },
    })

    logStep('Create Payments', true, {
      cashPayment: cashPayment.toString(),
      cardPayment: cardPayment.toString(),
      totalTips: 15,
    })

    await sleep(500)

    // ========================================
    // STEP 5: Close shift (AUTOMATIC CALCULATION)
    // ========================================
    console.log('\n🔒 STEP 5: Closing shift with AUTOMATIC calculation...')

    const closedShift = await closeShiftForVenue(VENUE_ID, shiftId, undefined, undefined)

    logStep('Close Shift', true, {
      shiftId: closedShift.id,
      duration: `${Math.floor((new Date(closedShift.endTime!).getTime() - new Date(closedShift.startTime).getTime()) / 1000 / 60)} minutes`,
    })

    // ========================================
    // STEP 6: Verify automatic calculations
    // ========================================
    console.log('\n🔍 STEP 6: Verifying automatic calculations...')

    const expectedTotalSales = cashPayment.add(cardPayment)
    const expectedTotalTips = new Decimal(15)
    const expectedProductsSold = 2

    // Verify payment method breakdown
    const cashCorrect = closedShift.totalCashPayments.equals(cashPayment)
    const cardCorrect = closedShift.totalCardPayments.equals(cardPayment)
    const salesCorrect = closedShift.totalSales.equals(expectedTotalSales)
    const tipsCorrect = closedShift.totalTips.equals(expectedTotalTips)
    const productsCorrect = closedShift.totalProductsSold === expectedProductsSold

    logStep('Verify Payment Breakdown', cashCorrect && cardCorrect, {
      cash: {
        expected: cashPayment.toString(),
        actual: closedShift.totalCashPayments.toString(),
        match: cashCorrect,
      },
      card: {
        expected: cardPayment.toString(),
        actual: closedShift.totalCardPayments.toString(),
        match: cardCorrect,
      },
    })

    logStep('Verify Sales & Tips', salesCorrect && tipsCorrect, {
      sales: {
        expected: expectedTotalSales.toString(),
        actual: closedShift.totalSales.toString(),
        match: salesCorrect,
      },
      tips: {
        expected: expectedTotalTips.toString(),
        actual: closedShift.totalTips.toString(),
        match: tipsCorrect,
      },
    })

    logStep('Verify Products Sold', productsCorrect, {
      expected: expectedProductsSold,
      actual: closedShift.totalProductsSold,
      match: productsCorrect,
    })

    // Verify report data exists
    const hasReportData = closedShift.reportData !== null && typeof closedShift.reportData === 'object'

    logStep('Verify Report Data', hasReportData, {
      hasReportData,
      reportDataKeys: hasReportData ? Object.keys(closedShift.reportData as any) : [],
    })

    // ========================================
    // CLEANUP
    // ========================================
    console.log('\n🧹 CLEANUP: Deleting test data...')

    if (orderId) {
      await prisma.payment.deleteMany({ where: { orderId } })
      await prisma.orderItem.deleteMany({ where: { orderId } })
      await prisma.order.delete({ where: { id: orderId } })
      logStep('Delete Order', true)
    }

    if (shiftId) {
      await prisma.shift.delete({ where: { id: shiftId } })
      logStep('Delete Shift', true)
    }
  } catch (error: any) {
    logStep('Test Execution', false, null, error.message)
    console.error('Error:', error)

    // Cleanup on error
    if (orderId) {
      try {
        await prisma.payment.deleteMany({ where: { orderId } })
        await prisma.orderItem.deleteMany({ where: { orderId } })
        await prisma.order.delete({ where: { id: orderId } })
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError)
      }
    }

    if (shiftId) {
      try {
        await prisma.shift.delete({ where: { id: shiftId } })
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError)
      }
    }
  } finally {
    await prisma.$disconnect()
  }

  // ========================================
  // SUMMARY
  // ========================================
  console.log('\n' + '═'.repeat(70))
  console.log('📊 TEST SUMMARY')
  console.log('═'.repeat(70))

  const passed = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length

  console.log(`✅ Passed: ${passed}`)
  console.log(`❌ Failed: ${failed}`)
  console.log(`📈 Success Rate: ${Math.round((passed / results.length) * 100)}%`)

  if (failed === 0) {
    console.log('\n🎉 ALL TESTS PASSED!')
    console.log('✅ Shift automatic close is working correctly')
    console.log('✅ Payment method breakdown calculated')
    console.log('✅ Products sold counted')
    console.log('✅ Report data generated')
  } else {
    console.log('\n⚠️  SOME TESTS FAILED - Review the results above')
  }

  console.log('\n')
}

// Run tests
testShiftAutomaticClose()
  .then(() => {
    console.log('Test completed')
    process.exit(0)
  })
  .catch(error => {
    console.error('Test failed:', error)
    process.exit(1)
  })
