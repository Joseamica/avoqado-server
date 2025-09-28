const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

async function checkPayments() {
  try {
    // Get all venues
    const venues = await prisma.venue.findMany({
      select: { id: true, name: true },
    })

    console.log('Venues found:', venues.length)

    for (const venue of venues) {
      console.log(`\n=== VENUE: ${venue.name} (${venue.id}) ===`)

      // Get all payments for this venue
      const allPayments = await prisma.payment.findMany({
        where: { venueId: venue.id },
        select: {
          id: true,
          amount: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      })

      console.log(`Total payments in DB: ${allPayments.length}`)

      // Calculate totals
      const totalAmount = allPayments.reduce((sum, p) => sum + Number(p.amount), 0)
      const completedPayments = allPayments.filter(p => p.status === 'COMPLETED')
      const completedAmount = completedPayments.reduce((sum, p) => sum + Number(p.amount), 0)

      console.log(`Total amount (all): $${totalAmount.toFixed(2)}`)
      console.log(`Completed payments: ${completedPayments.length}`)
      console.log(`Completed amount: $${completedAmount.toFixed(2)}`)

      // Check last 7 days
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const recentPayments = allPayments.filter(p => p.createdAt >= sevenDaysAgo)
      const recentAmount = recentPayments.reduce((sum, p) => sum + Number(p.amount), 0)

      console.log(`\nLast 7 days:`)
      console.log(`Recent payments: ${recentPayments.length}`)
      console.log(`Recent amount: $${recentAmount.toFixed(2)}`)

      // Show payment details
      if (allPayments.length > 0) {
        console.log(`\nFirst 5 payments:`)
        allPayments.slice(0, 5).forEach(p => {
          console.log(`- ${p.id}: $${Number(p.amount).toFixed(2)} (${p.status}) - ${p.createdAt.toISOString().split('T')[0]}`)
        })
      }
    }
  } catch (error) {
    console.error('Error:', error)
  } finally {
    await prisma.$disconnect()
  }
}

checkPayments()
