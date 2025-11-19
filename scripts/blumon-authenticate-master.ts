/**
 * Blumon Master Authentication Script
 *
 * Authenticates with Blumon using master credentials and updates EcommerceMerchant
 * with the obtained OAuth tokens.
 *
 * **Usage**:
 * ```bash
 * npx ts-node -r tsconfig-paths/register scripts/blumon-authenticate-master.ts
 * ```
 *
 * **What it does**:
 * 1. Authenticates with Blumon using master credentials
 * 2. Receives access token (valid 3 hours) and refresh token
 * 3. Updates EcommerceMerchant with tokens in providerCredentials
 * 4. Displays tokens for manual use if needed
 */

import prisma from '../src/utils/prismaClient'
import { blumonAuthService } from '../src/services/blumon/blumonAuth.service'
import logger from '../src/config/logger'

// ═══════════════════════════════════════════════════════════════════════════
// MASTER CREDENTIALS (Sandbox)
// ═══════════════════════════════════════════════════════════════════════════

const BLUMON_MASTER_CREDENTIALS = {
  username: 'jose@avoqado.io',
  password: 'U!Sr{9DHN4-wKH|',
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SCRIPT
// ═══════════════════════════════════════════════════════════════════════════

async function authenticateBlumonMaster() {
  try {
    logger.info('🔐 Starting Blumon Master Authentication...')

    // ========================================================================
    // STEP 1: Authenticate with Blumon
    // ========================================================================
    logger.info('\n📝 STEP 1: Authenticating with Blumon...')
    logger.info(`   Username: ${BLUMON_MASTER_CREDENTIALS.username}`)

    const authResult = await blumonAuthService.authenticate(BLUMON_MASTER_CREDENTIALS, true) // true = sandbox

    logger.info('✅ Authentication successful!')
    logger.info(`   Access Token: ${authResult.accessToken.substring(0, 50)}...`)
    logger.info(`   Token Type: ${authResult.tokenType}`)
    logger.info(`   Expires In: ${authResult.expiresIn} seconds (${authResult.expiresIn / 3600} hours)`)
    logger.info(`   Expires At: ${authResult.expiresAt.toISOString()}`)
    if (authResult.refreshToken) {
      logger.info(`   Refresh Token: ${authResult.refreshToken.substring(0, 50)}...`)
    }

    // ========================================================================
    // STEP 2: Find Blumon EcommerceMerchants
    // ========================================================================
    logger.info('\n📝 STEP 2: Finding Blumon EcommerceMerchants...')

    const blumonProvider = await prisma.paymentProvider.findFirst({
      where: { code: 'BLUMON' },
    })

    if (!blumonProvider) {
      logger.warn('⚠️ No Blumon provider found in database')
      logger.info('\n💡 You can still use the tokens manually:')
      displayTokens(authResult)
      return
    }

    const ecommerceMerchants = await prisma.ecommerceMerchant.findMany({
      where: {
        providerId: blumonProvider.id,
        sandboxMode: true, // Only update sandbox merchants
        active: true,
      },
      include: {
        venue: {
          select: {
            name: true,
            slug: true,
          },
        },
      },
    })

    if (ecommerceMerchants.length === 0) {
      logger.warn('⚠️ No active Blumon EcommerceMerchants found')
      logger.info('\n💡 Create an EcommerceMerchant first, then run this script again')
      logger.info('\n💡 Or use the tokens manually:')
      displayTokens(authResult)
      return
    }

    logger.info(`✅ Found ${ecommerceMerchants.length} Blumon merchant(s)`)

    // ========================================================================
    // STEP 3: Update EcommerceMerchants with tokens
    // ========================================================================
    logger.info('\n📝 STEP 3: Updating EcommerceMerchants with OAuth tokens...')

    for (const merchant of ecommerceMerchants) {
      logger.info(`\n   Updating: ${merchant.channelName} (${merchant.venue.name})`)

      // Get existing credentials
      const existingCredentials = (merchant.providerCredentials as any) || {}

      // Merge with new tokens
      const updatedCredentials = {
        ...existingCredentials,
        accessToken: authResult.accessToken,
        refreshToken: authResult.refreshToken,
        tokenType: authResult.tokenType,
        expiresIn: authResult.expiresIn,
        expiresAt: authResult.expiresAt.toISOString(),
        authenticatedAt: new Date().toISOString(),
        authenticatedBy: BLUMON_MASTER_CREDENTIALS.username,
      }

      await prisma.ecommerceMerchant.update({
        where: { id: merchant.id },
        data: {
          providerCredentials: updatedCredentials,
        },
      })

      logger.info(`   ✅ Updated: ${merchant.channelName}`)
    }

    logger.info('\n✅ All EcommerceMerchants updated successfully!')

    // ========================================================================
    // STEP 4: Display summary
    // ========================================================================
    logger.info('\n' + '='.repeat(80))
    logger.info('📊 AUTHENTICATION SUMMARY')
    logger.info('='.repeat(80))

    logger.info('\n🔑 OAuth Tokens:')
    logger.info(`   Access Token: ${authResult.accessToken}`)
    if (authResult.refreshToken) {
      logger.info(`   Refresh Token: ${authResult.refreshToken}`)
    }
    logger.info(`   Expires At: ${authResult.expiresAt.toISOString()}`)
    logger.info(`   Valid For: ${authResult.expiresIn / 3600} hours`)

    logger.info('\n✅ Updated Merchants:')
    ecommerceMerchants.forEach((merchant, index) => {
      logger.info(`   ${index + 1}. ${merchant.channelName} (${merchant.venue.name})`)
      logger.info(`      - Venue: ${merchant.venue.slug}`)
      logger.info(`      - Channel: ${merchant.channelName}`)
      logger.info(`      - ID: ${merchant.id}`)
    })

    logger.info('\n💡 Next Steps:')
    logger.info('   1. Test checkout session creation with the updated credentials')
    logger.info('   2. Token will expire in 3 hours - set up refresh logic')
    logger.info('   3. Update production merchants when ready')

    logger.info('\n' + '='.repeat(80))
  } catch (error: any) {
    logger.error('❌ Authentication failed:', {
      error: error.message,
      stack: error.stack,
    })
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * Display tokens for manual use
 */
function displayTokens(authResult: any) {
  logger.info('\n' + '='.repeat(80))
  logger.info('🔑 BLUMON OAUTH TOKENS')
  logger.info('='.repeat(80))
  logger.info('\n📋 Copy these tokens:')
  logger.info('\nAccess Token:')
  logger.info(authResult.accessToken)
  if (authResult.refreshToken) {
    logger.info('\nRefresh Token:')
    logger.info(authResult.refreshToken)
  }
  logger.info(`\nExpires At: ${authResult.expiresAt.toISOString()}`)
  logger.info(`Valid For: ${authResult.expiresIn / 3600} hours`)
  logger.info('\n💡 Use in Authorization header: Bearer <access_token>')
  logger.info('='.repeat(80))
}

// Run the script
authenticateBlumonMaster()
