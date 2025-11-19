/**
 * Quick check: Verify Blumon EcommerceMerchant exists
 */
import prisma from '../src/utils/prismaClient'

async function checkBlumonMerchant() {
  const blumonProvider = await prisma.paymentProvider.findFirst({
    where: { code: 'BLUMON' },
  })

  if (!blumonProvider) {
    console.log('❌ Blumon provider not found')
    await prisma.$disconnect()
    return
  }

  const merchants = await prisma.ecommerceMerchant.findMany({
    where: { providerId: blumonProvider.id },
    include: {
      venue: { select: { name: true, slug: true } },
    },
  })

  console.log(`\n✅ Found ${merchants.length} Blumon EcommerceMerchant(s):\n`)

  merchants.forEach((m, i) => {
    console.log(`${i + 1}. ${m.channelName} (${m.venue.name})`)
    console.log(`   ID: ${m.id}`)
    console.log(`   Sandbox: ${m.sandboxMode}`)
    console.log(`   Active: ${m.active}`)
    console.log(`   Credentials: ${JSON.stringify(m.providerCredentials, null, 2)}`)
    console.log()
  })

  await prisma.$disconnect()
}

checkBlumonMerchant()
