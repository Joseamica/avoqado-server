/**
 * List all active checkout sessions
 */

import prisma from '@/utils/prismaClient'

async function listSessions() {
  try {
    const sessions = await prisma.checkoutSession.findMany({
      where: {
        status: {
          in: ['PENDING', 'PROCESSING'],
        },
      },
      include: {
        ecommerceMerchant: {
          select: {
            businessName: true,
            sandboxMode: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 10,
    })

    console.log(`🔍 Found ${sessions.length} active checkout session(s):\n`)

    if (sessions.length === 0) {
      console.log('❌ No active sessions found. Run create-checkout-with-valid-merchant.ts to create one.')
      return
    }

    for (const session of sessions) {
      const isExpired = session.expiresAt < new Date()

      console.log(`📋 Session: ${session.sessionId}`)
      console.log(`   Amount: $${session.amount} ${session.currency}`)
      console.log(`   Status: ${session.status}`)
      console.log(`   Merchant: ${session.ecommerceMerchant.businessName}`)
      console.log(`   Sandbox: ${session.ecommerceMerchant.sandboxMode ? 'Yes' : 'No'}`)
      console.log(`   Created: ${session.createdAt.toISOString()}`)
      console.log(`   Expires: ${session.expiresAt.toISOString()} ${isExpired ? '❌ EXPIRED' : '✅ Valid'}`)
      console.log(
        `   Test URL: http://localhost:3000/sdk/example.html?sessionId=${session.sessionId}&amount=${session.amount}&currency=${session.currency}`,
      )
      console.log('')
    }

    console.log('💡 Copy the Test URL above and paste it in your browser!')
  } catch (error) {
    console.error('❌ Error:', error)
  } finally {
    await prisma.$disconnect()
  }
}

listSessions()
