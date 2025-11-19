/**
 * Inspect Blumon merchant credentials (safely)
 */

import prisma from '@/utils/prismaClient'
import { blumonAuthService } from '@/services/blumon/blumonAuth.service'

async function inspectCredentials() {
  try {
    const merchantId = 'cmhyzw34a00hp9km6e4g22ppf'

    const merchant = await prisma.ecommerceMerchant.findUnique({
      where: { id: merchantId },
      include: {
        provider: true,
        venue: true,
      },
    })

    if (!merchant) {
      console.log('❌ Merchant not found')
      return
    }

    console.log('🔍 Merchant Credentials Inspection\n')
    console.log(`Merchant: ${merchant.businessName}`)
    console.log(`Venue: ${merchant.venue.name}`)
    console.log(`Sandbox: ${merchant.sandboxMode}`)
    console.log(`Provider: ${merchant.provider.name}`)
    console.log('')

    const credentials = merchant.providerCredentials as any

    if (!credentials) {
      console.log('❌ No credentials found')
      return
    }

    // Check what fields exist
    console.log('📋 Credential Fields:')
    console.log(`   - accessToken: ${credentials.accessToken ? '✅ Present' : '❌ Missing'}`)
    console.log(`   - refreshToken: ${credentials.refreshToken ? '✅ Present' : '❌ Missing'}`)
    console.log(`   - expiresIn: ${credentials.expiresIn || 'N/A'}`)
    console.log(`   - expiresAt: ${credentials.expiresAt || 'N/A'}`)
    console.log('')

    // Check token expiration
    if (credentials.expiresAt) {
      const expiresAt = new Date(credentials.expiresAt)
      const now = new Date()
      const isExpired = expiresAt < now
      const timeRemaining = Math.round((expiresAt.getTime() - now.getTime()) / 1000 / 60) // minutes

      console.log('⏰ Token Status:')
      console.log(`   Expires: ${expiresAt.toISOString()}`)
      console.log(`   Current: ${now.toISOString()}`)
      console.log(`   Status: ${isExpired ? '❌ EXPIRED' : '✅ Valid'}`)

      if (isExpired) {
        console.log(`   Expired ${Math.abs(timeRemaining)} minutes ago`)
      } else {
        console.log(`   Expires in ${timeRemaining} minutes`)
      }

      console.log('')

      // Check if can be refreshed
      if (isExpired && credentials.refreshToken) {
        console.log('🔄 Token is expired but refresh token available')
        console.log('   The system should automatically refresh on next tokenization request')
      } else if (isExpired && !credentials.refreshToken) {
        console.log('❌ Token is expired and NO refresh token available')
        console.log('   You need to re-authenticate with Blumon OAuth flow')
      }
    }

    // Show partial tokens (for debugging)
    console.log('')
    console.log('🔑 Token Preview (partial):')
    if (credentials.accessToken) {
      console.log(`   Access: ${credentials.accessToken.substring(0, 20)}...${credentials.accessToken.slice(-10)}`)
    }
    if (credentials.refreshToken) {
      console.log(`   Refresh: ${credentials.refreshToken.substring(0, 20)}...${credentials.refreshToken.slice(-10)}`)
    }
  } catch (error) {
    console.error('❌ Error:', error)
  } finally {
    await prisma.$disconnect()
  }
}

inspectCredentials()
