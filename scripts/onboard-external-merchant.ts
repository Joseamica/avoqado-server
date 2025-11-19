/**
 * Onboard E-commerce Merchant Script
 *
 * Creates a new e-commerce merchant for Avoqado SDK payment processing.
 * Generates API keys and connects to payment provider.
 *
 * **Usage:**
 * ```bash
 * npx ts-node -r tsconfig-paths/register scripts/onboard-external-merchant.ts
 * ```
 *
 * **What it does:**
 * 1. Prompts for merchant information
 * 2. Creates EcommerceMerchant record in database
 * 3. Generates API keys (public + secret with SHA-256 hash)
 * 4. Connects to payment provider (Blumon, Stripe, etc.)
 * 5. Prints API keys for merchant (ONLY TIME THEY'LL SEE SECRET KEY)
 *
 * **IMPORTANT (2025-01-17)**:
 * - Secret keys are hashed (SHA-256), NOT encrypted
 * - Secret key shown ONLY ONCE (cannot be retrieved)
 * - Webhook secrets stored as plaintext
 *
 * @module scripts/onboard-ecommerce-merchant
 */

import prisma from '../src/utils/prismaClient'
import { generateAPIKeys } from '../src/middlewares/sdk-auth.middleware'
import readline from 'readline'
import chalk from 'chalk'
import crypto from 'crypto'

// ═══════════════════════════════════════════════════════════════════════════
// READLINE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function question(prompt: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      resolve(answer.trim())
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SCRIPT
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(chalk.blue.bold('\n🚀 Avoqado SDK - E-commerce Merchant Onboarding\n'))

  try {
    // Step 1: Gather merchant information
    console.log(chalk.yellow('Step 1: Merchant Information\n'))

    const businessName = await question('Business Name: ')
    if (!businessName) {
      throw new Error('Business name is required')
    }

    const rfc = await question('RFC (optional): ')
    const contactEmail = await question('Contact Email: ')
    if (!contactEmail || !contactEmail.includes('@')) {
      throw new Error('Valid contact email is required')
    }

    const contactPhone = await question('Contact Phone (optional): ')
    const website = await question('Website (optional): ')

    // Step 2: Select payment provider
    console.log(chalk.yellow('\nStep 2: Payment Provider\n'))

    const providers = await prisma.paymentProvider.findMany({
      where: {
        active: true,
      },
    })

    if (providers.length === 0) {
      throw new Error('No active payment providers found. Create a PaymentProvider first.')
    }

    console.log('Available Payment Providers:')
    providers.forEach((provider, index) => {
      console.log(`  ${index + 1}. ${provider.name} (${provider.code})`)
    })

    const providerIndexStr = await question('\nSelect Payment Provider (number): ')
    const providerIndex = parseInt(providerIndexStr, 10) - 1

    if (isNaN(providerIndex) || providerIndex < 0 || providerIndex >= providers.length) {
      throw new Error('Invalid payment provider selection')
    }

    const selectedProvider = providers[providerIndex]

    // Step 3: Configure provider-specific credentials
    console.log(chalk.yellow(`\nStep 3: ${selectedProvider.name} Credentials\n`))

    let providerCredentials: any = {}

    if (selectedProvider.code === 'BLUMON') {
      console.log('Blumon E-commerce OAuth 2.0 Configuration:')
      console.log(chalk.gray('  (These are your Blumon account credentials, NOT the Android SDK credentials)'))
      const blumonUsername = await question('  Blumon Username (email): ')
      const blumonPassword = await question('  Blumon Password: ')
      const blumonWebhookSecret = await question('  Blumon Webhook Secret (optional): ')

      providerCredentials = {
        blumonUsername,
        blumonPassword, // Note: Will be hashed with SHA-256 before sending to Blumon
        ...(blumonWebhookSecret && { webhookSecret: blumonWebhookSecret }),
      }
    } else if (selectedProvider.code === 'STRIPE') {
      console.log('Stripe Connect Configuration:')
      const stripeAccountId = await question('  Stripe Account ID: ')
      const stripeSecretKey = await question('  Stripe Secret Key: ')

      providerCredentials = {
        stripeAccountId,
        stripeSecretKey,
      }
    } else {
      console.log(
        chalk.yellow(
          `⚠️  Manual credential configuration required for ${selectedProvider.name}.\nYou'll need to update the merchant record after creation.`,
        ),
      )
      providerCredentials = {
        note: `Manual configuration required for ${selectedProvider.name}`,
      }
    }

    // Step 4: Webhook configuration (optional)
    console.log(chalk.yellow('\nStep 4: Webhook Configuration (Optional)\n'))

    const webhookUrl = await question('Webhook URL (leave empty to skip): ')
    let webhookSecret: string | undefined

    if (webhookUrl) {
      const inputSecret = await question('Webhook Secret (leave empty to auto-generate): ')

      if (inputSecret) {
        webhookSecret = inputSecret
      } else {
        // Auto-generate webhook secret
        const generatedSecret = crypto.randomBytes(32).toString('hex')
        webhookSecret = generatedSecret
        console.log(chalk.green(`\n⚠️  Auto-generated webhook secret (SAVE THIS!):`))
        console.log(chalk.cyan(`   ${generatedSecret}\n`))
      }
    }

    // Step 5: Sandbox or production mode
    console.log(chalk.yellow('\nStep 5: Environment\n'))
    const modeStr = await question('Mode (1=Sandbox, 2=Production): ')
    const sandboxMode = modeStr !== '2'

    console.log(chalk.cyan(`\n  Mode: ${sandboxMode ? 'Sandbox (Test)' : 'Production (Live)'}\n`))

    // Step 6: Get venue ID
    console.log(chalk.yellow('\nStep 6: Select Venue\n'))

    const venues = await prisma.venue.findMany({
      select: {
        id: true,
        name: true,
      },
    })

    if (venues.length === 0) {
      throw new Error('No venues found. Create a venue first.')
    }

    console.log('Available Venues:')
    venues.forEach((venue, index) => {
      console.log(`  ${index + 1}. ${venue.name}`)
    })

    const venueIndexStr = await question('\nSelect Venue (number): ')
    const venueIndex = parseInt(venueIndexStr, 10) - 1

    if (isNaN(venueIndex) || venueIndex < 0 || venueIndex >= venues.length) {
      throw new Error('Invalid venue selection')
    }

    const selectedVenue = venues[venueIndex]

    // Step 7: Channel name
    const channelName = (await question('\nChannel Name (e.g., "Web Principal", "App Móvil"): ')) || 'Web Principal'

    // Step 8: Generate API keys
    console.log(chalk.yellow('\nStep 8: Generating API Keys...\n'))

    const { publicKey, secretKey, secretKeyHash } = generateAPIKeys(sandboxMode)

    console.log(chalk.green('✓ API keys generated'))

    // Step 9: Create e-commerce merchant
    console.log(chalk.yellow('\nStep 9: Creating E-commerce Merchant Record...\n'))

    const merchant = await prisma.ecommerceMerchant.create({
      data: {
        venueId: selectedVenue.id,
        channelName,
        businessName,
        rfc: rfc || null,
        contactEmail,
        contactPhone: contactPhone || null,
        website: website || null,
        publicKey,
        secretKeyHash,
        providerId: selectedProvider.id,
        providerCredentials,
        webhookUrl: webhookUrl || null,
        webhookSecret: webhookSecret || null,
        webhookEvents: ['payment.completed', 'payment.failed'],
        active: true,
        sandboxMode,
      },
    })

    console.log(chalk.green('✓ E-commerce merchant created successfully!\n'))

    // Step 10: Print summary
    console.log(chalk.blue.bold('═══════════════════════════════════════════════════════════'))
    console.log(chalk.green.bold('✅ E-COMMERCE MERCHANT ONBOARDING COMPLETE'))
    console.log(chalk.blue.bold('═══════════════════════════════════════════════════════════\n'))

    console.log(chalk.white.bold('Merchant Details:'))
    console.log(`  Business Name:    ${chalk.cyan(merchant.businessName)}`)
    console.log(`  Contact Email:    ${chalk.cyan(merchant.contactEmail)}`)
    console.log(`  Merchant ID:      ${chalk.cyan(merchant.id)}`)
    console.log(`  Environment:      ${chalk.cyan(sandboxMode ? 'Sandbox (Test)' : 'Production (Live)')}`)
    console.log(`  Payment Provider: ${chalk.cyan(selectedProvider.name)}`)

    console.log(chalk.red.bold('\n⚠️  API KEYS (SAVE THESE NOW - SECRET KEY WILL NEVER BE SHOWN AGAIN!):\n'))

    console.log(chalk.yellow('Public Key (use in frontend):'))
    console.log(chalk.white(`  ${publicKey}\n`))

    console.log(chalk.yellow('Secret Key (use in backend - KEEP SECURE):'))
    console.log(chalk.white(`  ${secretKey}\n`))

    if (selectedProvider.code === 'BLUMON') {
      console.log(chalk.yellow('Blumon Configuration:'))
      console.log(chalk.white(`  Merchant ID: ${providerCredentials.blumonMerchantId}`))
      console.log(chalk.white(`  POS ID:      ${providerCredentials.blumonPosId}\n`))
    }

    if (webhookUrl) {
      console.log(chalk.yellow('Webhook Configuration:'))
      console.log(chalk.white(`  URL:    ${webhookUrl}`))
      console.log(chalk.white(`  Events: payment.completed, payment.failed\n`))
    }

    console.log(chalk.blue.bold('═══════════════════════════════════════════════════════════\n'))

    console.log(chalk.white('Next Steps for Merchant:\n'))
    console.log('1. Install the SDK in their website:')
    console.log(chalk.cyan('   <script src="https://sdk.avoqado.com/v1/avoqado-v1.js"></script>\n'))

    console.log('2. Initialize with public key:')
    console.log(chalk.cyan(`   const avoqado = Avoqado('${publicKey}')\n`))

    console.log('3. Create checkout sessions:')
    console.log(chalk.cyan('   await avoqado.checkout.redirectToCheckout({ ... })\n'))

    console.log('4. Use secret key for backend operations (list sessions, refunds, etc.)\n')

    console.log(chalk.green('✓ Onboarding complete!\n'))
  } catch (error: any) {
    console.error(chalk.red('\n❌ Error:'), error.message)
    process.exit(1)
  } finally {
    rl.close()
    await prisma.$disconnect()
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN SCRIPT
// ═══════════════════════════════════════════════════════════════════════════

main()
  .catch(error => {
    console.error(chalk.red('\n❌ Fatal error:'), error)
    process.exit(1)
  })
  .finally(() => {
    process.exit(0)
  })
