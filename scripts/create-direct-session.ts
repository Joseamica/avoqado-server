/**
 * Create Checkout Session Directly (No Hosted Checkout)
 * Bypasses Blumon hosted checkout creation for direct tokenization flow
 */

import prisma from '../src/utils/prismaClient'
import { CheckoutStatus } from '@prisma/client'
import crypto from 'crypto'

async function createDirectSession() {
  try {
    const sessionId = `cs_test_${crypto.randomBytes(16).toString('hex')}`
    const expiresAt = new Date()
    expiresAt.setHours(expiresAt.getHours() + 24)

    const session = await prisma.checkoutSession.create({
      data: {
        sessionId,
        ecommerceMerchantId: 'cmi0s3u6l00hp9k2jc9alnocr', // Tienda Web (Blumon)
        amount: 0.5, // Tiny amount to avoid monthly limit
        currency: 'MXN',
        description: 'Test payment - $0.50 MXN',
        customerEmail: 'test@avoqado.io',
        customerName: 'José Antonio Test',
        status: CheckoutStatus.PENDING,
        expiresAt,
      },
    })

    console.log('✅ Checkout session created!')
    console.log(`\n📋 Session Details:`)
    console.log(`   Session ID: ${session.sessionId}`)
    console.log(`   Amount: $${session.amount} ${session.currency}`)
    console.log(`   Status: ${session.status}`)
    console.log(`   Expires: ${session.expiresAt}`)

    console.log(`\n🔗 Test URL:`)
    console.log(`   http://localhost:3000/sdk/example.html?sessionId=${session.sessionId}&amount=0.50&currency=MXN`)

    console.log(`\n💳 Test Card (Pre-filled):`)
    console.log(`   Number: 3782 822463 10005 (AMEX)`)
    console.log(`   CVV: 1234`)
    console.log(`   Expiry: 12/25`)
    console.log(`   Name: José Antonio Test`)

    console.log(`\n⚡ Just click "Pagar $0.50" - 50 centavos para evitar el límite!`)

    await prisma.$disconnect()
  } catch (error: any) {
    console.error('❌ Error:', error.message)
    await prisma.$disconnect()
    process.exit(1)
  }
}

createDirectSession()
