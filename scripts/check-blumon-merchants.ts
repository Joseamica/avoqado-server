/**
 * Check for existing Blumon e-commerce merchants with valid credentials
 */

import prisma from '@/utils/prismaClient'

async function checkBlumonMerchants() {
  try {
    console.log('🔍 Checking for Blumon e-commerce merchants...\n')

    const merchants = await prisma.ecommerceMerchant.findMany({
      where: {
        provider: {
          code: 'BLUMON',
        },
      },
      include: {
        provider: true,
        venue: true,
      },
    })

    if (merchants.length === 0) {
      console.log('❌ No Blumon merchants found.')
      console.log('\n💡 You need to create a merchant with valid Blumon OAuth credentials.')
      console.log('   Options:')
      console.log('   1. Use the Blumon OAuth flow to get real credentials')
      console.log('   2. Get credentials from Blumon support team')
      return
    }

    console.log(`✅ Found ${merchants.length} Blumon merchant(s):\n`)

    for (const merchant of merchants) {
      const credentials = merchant.providerCredentials as any
      const hasValidToken = credentials?.accessToken && credentials.accessToken !== 'test_token'

      console.log(`📦 ${merchant.businessName}`)
      console.log(`   ID: ${merchant.id}`)
      console.log(`   Venue: ${merchant.venue.name}`)
      console.log(`   Sandbox: ${merchant.sandboxMode ? 'Yes' : 'No'}`)
      console.log(`   Active: ${merchant.active ? 'Yes' : 'No'}`)
      console.log(`   Has Valid Token: ${hasValidToken ? '✅' : '❌'}`)

      if (hasValidToken) {
        console.log(`   Token Expires: ${credentials.expiresAt || 'Unknown'}`)
      }

      console.log('')
    }

    // Find best merchant for testing
    const validMerchant = merchants.find(m => {
      const creds = m.providerCredentials as any
      return creds?.accessToken && creds.accessToken !== 'test_token'
    })

    if (validMerchant) {
      console.log('✅ Found merchant with valid credentials!')
      console.log(`   Use this merchant ID: ${validMerchant.id}`)
      console.log('\n💡 Run create-test-checkout-session.ts and modify it to use this merchant.')
    } else {
      console.log('❌ No merchants have valid OAuth credentials.')
      console.log('\n📖 To get Blumon OAuth credentials:')
      console.log('   1. Contact Blumon support: support@blumonpay.com')
      console.log('   2. Or use the OAuth flow in the dashboard')
      console.log('   3. Credentials should include:')
      console.log('      - accessToken')
      console.log('      - refreshToken')
      console.log('      - expiresIn')
      console.log('      - expiresAt')
    }
  } catch (error) {
    console.error('❌ Error:', error)
  } finally {
    await prisma.$disconnect()
  }
}

checkBlumonMerchants()
