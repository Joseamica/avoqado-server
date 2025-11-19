/**
 * List Active E-commerce Merchants
 */

import prisma from '../src/utils/prismaClient'

async function listMerchants() {
  try {
    const merchants = await prisma.ecommerceMerchant.findMany({
      include: {
        provider: true,
        venue: true,
      },
    })

    console.log(`\n📋 E-commerce Merchants (${merchants.length} total):\n`)

    merchants.forEach((merchant, index) => {
      console.log(`${index + 1}. ${merchant.channelName}`)
      console.log(`   ID: ${merchant.id}`)
      console.log(`   Venue: ${merchant.venue.name}`)
      console.log(`   Provider: ${merchant.provider.name}`)
      console.log(`   Sandbox: ${merchant.sandboxMode}`)
      console.log(`   Credentials: ${merchant.providerCredentials ? 'Yes' : 'No'}`)
      console.log('')
    })

    await prisma.$disconnect()
  } catch (error: any) {
    console.error('❌ Error:', error.message)
    await prisma.$disconnect()
    process.exit(1)
  }
}

listMerchants()
