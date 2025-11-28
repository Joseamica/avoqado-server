/**
 * Test Blumon E-commerce Checkout (Mock Service)
 *
 * Creates a checkout session for testing the direct charge flow.
 * Uses mock service for unlimited testing without consuming Blumon API limits.
 *
 * STEPS TO TEST:
 * 1. Run this script to create a checkout session
 * 2. Open the URL in your browser
 * 3. Fill in card details (use test cards from output)
 * 4. Click "Pagar" and watch the console for success/error
 * 5. Check database for completed session
 */

import prisma from '../src/utils/prismaClient'
import { CheckoutStatus, Prisma } from '@prisma/client'
import crypto from 'crypto'
import { generateAPIKeys } from '../src/middlewares/sdk-auth.middleware'

async function testCheckout() {
  try {
    console.log('🧪 Creating test checkout session...\n')

    // Step 1: Find or create test merchant
    type MerchantWithProvider = Awaited<
      ReturnType<
        typeof prisma.ecommerceMerchant.findFirst<{
          include: { provider: true }
        }>
      >
    >

    let merchant: MerchantWithProvider = await prisma.ecommerceMerchant.findFirst({
      where: {
        businessName: 'Test Merchant (Mock)',
      },
      include: {
        provider: true,
      },
    })

    if (!merchant) {
      console.log('⚠️  No test merchant found. Creating one...')

      // Find Blumon provider
      const blumonProvider = await prisma.paymentProvider.findFirst({
        where: { code: 'BLUMON' },
      })

      if (!blumonProvider) {
        throw new Error('Blumon provider not found in database. Run seed script first.')
      }

      // Find test venue
      const venue = await prisma.venue.findFirst()
      if (!venue) {
        throw new Error('No venue found. Create a venue first.')
      }

      // Generate API keys for the merchant
      const sandboxMode = true
      const { publicKey, secretKeyHash } = generateAPIKeys(sandboxMode)

      merchant = await prisma.ecommerceMerchant.create({
        data: {
          venueId: venue.id,
          providerId: blumonProvider.id,
          channelName: 'Web Test',
          businessName: 'Test Merchant (Mock)',
          contactEmail: 'test@avoqado.io',
          sandboxMode,
          active: true,
          publicKey,
          secretKeyHash,
          providerCredentials: {
            // Mock credentials (not used by mock service)
            accessToken: 'mock_token_123',
            refreshToken: 'mock_refresh_123',
            expiresIn: 3600,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            blumonMerchantId: 'MOCK_MERCHANT_123', // ← This will be used for routing
          } as Prisma.InputJsonValue,
        },
        include: {
          provider: true,
        },
      })

      console.log('✅ Test merchant created!')
    }

    if (!merchant) {
      throw new Error('Failed to find or create merchant')
    }

    console.log(`📦 Using merchant: ${merchant.businessName} (${merchant.id})`)

    // Step 2: Create checkout session
    const sessionId = `cs_test_${crypto.randomBytes(16).toString('hex')}`
    const expiresAt = new Date()
    expiresAt.setHours(expiresAt.getHours() + 24)

    const session = await prisma.checkoutSession.create({
      data: {
        sessionId,
        ecommerceMerchantId: merchant.id,
        amount: 10.0, // $10 MXN
        currency: 'MXN',
        description: 'Test payment - Blumon E-commerce',
        customerEmail: 'customer@example.com',
        customerName: 'José Antonio Test',
        customerPhone: '+525512345678',
        status: CheckoutStatus.PENDING,
        expiresAt,
        metadata: {
          test: true,
          createdBy: 'test-script',
        },
      },
    })

    console.log('\n✅ Checkout session created!\n')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('📋 SESSION DETAILS')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`Session ID:  ${session.sessionId}`)
    console.log(`Amount:      $${session.amount} ${session.currency}`)
    console.log(`Status:      ${session.status}`)
    console.log(`Expires:     ${session.expiresAt.toLocaleString()}`)
    console.log(`Merchant:    ${merchant.businessName}`)
    console.log(`Mode:        ${merchant.sandboxMode ? 'SANDBOX (Mock)' : 'PRODUCTION'}`)

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('🌐 TEST CHECKOUT URL')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(
      `http://localhost:3000/sdk/example.html?sessionId=${session.sessionId}&amount=${session.amount}&currency=${session.currency}`,
    )

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('💳 TEST CARDS (Mock Service)')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('\n✅ SUCCESS SCENARIOS:')
    console.log('   4111 1111 1111 1111  (VISA)       - Payment succeeds')
    console.log('   5555 5555 5555 4444  (Mastercard) - Payment succeeds')
    console.log('   3782 822463 10005    (AMEX)       - Payment succeeds')

    console.log('\n❌ ERROR SCENARIOS:')
    console.log('   4000 0000 0000 0002  (VISA)       - Card declined')
    console.log('   4000 0000 0099 95    (VISA)       - Insufficient funds')
    console.log('   4000 0000 0000 0069  (VISA)       - Expired card')
    console.log('   4000 0000 0000 0127  (VISA)       - Invalid CVV')
    console.log('   5100 0000 0000 0016  (Mastercard) - Monthly limit exceeded')
    console.log('   4242 4242 4242 4242  (VISA)       - Transaction limit exceeded')

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('🔧 TESTING STEPS')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('1. Make sure server is running: npm run dev')
    console.log('2. Make sure USE_BLUMON_MOCK=true in .env')
    console.log('3. Open the URL above in your browser')
    console.log('4. Click "Inicializar Checkout"')
    console.log('5. Fill card details with test card')
    console.log('6. Use any CVV (e.g., 123) and future expiry (e.g., 12/25)')
    console.log('7. Click "Pagar"')
    console.log('8. Watch console for tokenization + authorization')

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('📊 VERIFY RESULTS')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('\n// Check session status in database:')
    console.log(`psql -c "SELECT sessionId, status, amount, metadata FROM \\"CheckoutSession\\" WHERE sessionId = '${session.sessionId}';"`)

    console.log('\n// Check server logs (should show):')
    console.log('🔐 [MOCK] Tokenizing card')
    console.log('✅ [MOCK] Card tokenized successfully')
    console.log('💳 [MOCK] Authorizing payment')
    console.log('✅ [MOCK] Payment authorized successfully')

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('💡 TIP: Use mock service for unlimited testing!')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    await prisma.$disconnect()
  } catch (error: any) {
    console.error('❌ Error:', error.message)
    await prisma.$disconnect()
    process.exit(1)
  }
}

testCheckout()
