/**
 * Check Checkout Session Status
 * Quick diagnostic script to see current session state
 */

import prisma from '../src/utils/prismaClient'

async function checkSessionStatus() {
  const sessionId = 'cs_test_125bb0f3e2323b3e73abc5641fecc9b0'

  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
    select: {
      sessionId: true,
      status: true,
      amount: true,
      currency: true,
      createdAt: true,
      errorMessage: true,
      ecommerceMerchant: {
        select: {
          channelName: true,
          sandboxMode: true,
        },
      },
    },
  })

  if (!session) {
    console.log('❌ Session not found:', sessionId)
    return
  }

  console.log('📋 Session Status:')
  console.log('   Session ID:', session.sessionId)
  console.log('   Status:', session.status)
  console.log('   Amount:', `$${session.amount} ${session.currency}`)
  console.log('   Created:', session.createdAt)
  console.log('   Merchant:', session.ecommerceMerchant.channelName)
  console.log('   Sandbox:', session.ecommerceMerchant.sandboxMode)

  if (session.errorMessage) {
    console.log('   ⚠️ Error:', session.errorMessage)
  }

  await prisma.$disconnect()
}

checkSessionStatus()
