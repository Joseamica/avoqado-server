const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const VENUE_ID = 'cmk4a4ieg00219k2rseuzfrbh'

async function check() {
  const configs = await prisma.commissionConfig.count({ where: { venueId: VENUE_ID } })
  const calcs = await prisma.commissionCalculation.count({ where: { venueId: VENUE_ID } })
  const summaries = await prisma.commissionSummary.count({ where: { venueId: VENUE_ID } })
  const payouts = await prisma.commissionPayout.count({ where: { venueId: VENUE_ID } })
  const paidPayouts = await prisma.commissionPayout.count({ where: { venueId: VENUE_ID, status: 'PAID' } })

  const totalPaid = await prisma.commissionPayout.aggregate({
    where: { venueId: VENUE_ID, status: 'PAID' },
    _sum: { amount: true },
  })

  console.log('✅ Commission Data in Database:')
  console.log('  Configs:', configs)
  console.log('  Calculations:', calcs)
  console.log('  Summaries:', summaries)
  console.log('  Payouts:', payouts, '(' + paidPayouts + ' paid)')
  console.log('  Total Paid: $' + (totalPaid._sum.amount || 0))

  await prisma.$disconnect()
}
check().catch(e => {
  console.error(e)
  process.exit(1)
})
