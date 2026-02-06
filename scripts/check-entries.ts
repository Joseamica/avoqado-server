import prisma from '../src/utils/prismaClient'

async function main() {
  const entries = await prisma.timeEntry.findMany({
    where: { venue: { organizationId: 'cmko8m8vn00009kcxl0ycqov8' } },
    include: { staff: { select: { firstName: true, lastName: true } }, venue: { select: { name: true } } },
    orderBy: { clockInTime: 'desc' },
  })

  for (const e of entries) {
    const hasCheckInPhoto = e.checkInPhotoUrl ? 'SI' : 'NO'
    const hasCheckOutPhoto = e.checkOutPhotoUrl ? 'SI' : 'NO'
    console.log('---')
    console.log(`Staff: ${e.staff.firstName} ${e.staff.lastName} | ${e.venue.name}`)
    console.log(`ClockIn: ${e.clockInTime} | ClockOut: ${e.clockOutTime}`)
    console.log(`Foto CheckIn: ${hasCheckInPhoto} | Foto CheckOut (recibo bancario): ${hasCheckOutPhoto}`)
    console.log(`Validation: ${e.validationStatus}`)
  }

  await prisma.$disconnect()
}

main().catch(console.error)
