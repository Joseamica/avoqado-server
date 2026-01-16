/**
 * Test script to debug commission creation
 *
 * Run with: npx ts-node scripts/test-commission-create.ts
 */

import prisma from '../src/utils/prismaClient'
import { createCommissionForPayment } from '../src/services/dashboard/commission/commission-calculation.service'

const PAYMENT_ID = 'cmkec63qa000v9ky5aungn0fx'

async function main() {
  console.log('Testing commission creation for payment:', PAYMENT_ID)

  // 1. Check payment exists
  const payment = await prisma.payment.findUnique({
    where: { id: PAYMENT_ID },
    include: {
      order: {
        select: {
          id: true,
          createdById: true,
          servedById: true,
        },
      },
    },
  })

  if (!payment) {
    console.log('Payment not found!')
    return
  }

  console.log('Payment:', {
    id: payment.id,
    status: payment.status,
    type: payment.type,
    processedById: payment.processedById,
    venueId: payment.venueId,
    createdAt: payment.createdAt,
    order: payment.order,
  })

  // 2. Try to create commission
  console.log('\nAttempting to create commission...')
  try {
    const result = await createCommissionForPayment(PAYMENT_ID)
    if (result) {
      console.log('Commission created successfully:', result)
    } else {
      console.log('Commission was NOT created (returned null)')
    }
  } catch (error) {
    console.error('Error creating commission:', error)
  }

  // 3. Check if commission exists now
  const commission = await prisma.commissionCalculation.findFirst({
    where: { paymentId: PAYMENT_ID },
  })

  if (commission) {
    console.log('\nCommission record:', commission)
  } else {
    console.log('\nNo commission record found for this payment')
  }

  await prisma.$disconnect()
}

main().catch(console.error)
