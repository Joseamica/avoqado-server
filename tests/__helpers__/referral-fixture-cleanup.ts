import type { PrismaClient } from '@prisma/client'

export type ReferralFixtureIds = {
  venueId: string | undefined
  organizationId: string | undefined
  staffIds: string[]
}

export async function cleanupReferralFixtureData(client: PrismaClient, venueId: string | undefined): Promise<void> {
  if (!venueId) {
    return
  }

  // Order matters: child tables first. Every delete remains scoped to the
  // initialized fixture venue and, where relevant, referral-tier data.
  await client.couponRedemption.deleteMany({
    where: { couponCode: { discount: { venueId, source: 'REFERRAL_TIER' } } },
  })
  await client.couponCode.deleteMany({
    where: { discount: { venueId, source: 'REFERRAL_TIER' } },
  })
  await client.customerDiscount.deleteMany({
    where: { discount: { venueId, source: 'REFERRAL_TIER' } },
  })
  await client.discount.deleteMany({ where: { venueId, source: 'REFERRAL_TIER' } })
  await client.referral.deleteMany({ where: { venueId } })
  await client.activityLog.deleteMany({
    where: { venueId, action: { startsWith: 'REFERRAL_' } },
  })
  await client.order.deleteMany({
    where: { venueId, orderNumber: { startsWith: 'TEST-REF-' } },
  })
  await client.customer.deleteMany({
    where: { venueId, referralCode: { startsWith: 'TESTSMOKE-' } },
  })
  await client.customer.deleteMany({
    where: { venueId, phone: { startsWith: '5599999' } },
  })
  await client.referralProgramConfig.deleteMany({ where: { venueId } })
}

export async function teardownReferralFixture(client: PrismaClient, fixture: ReferralFixtureIds): Promise<void> {
  try {
    if (fixture.venueId) {
      await cleanupReferralFixtureData(client, fixture.venueId)
      await client.venue.delete({ where: { id: fixture.venueId } })
    }
    if (fixture.staffIds.length > 0) {
      await client.staff.deleteMany({ where: { id: { in: fixture.staffIds } } })
    }
    if (fixture.organizationId) {
      await client.organization.delete({ where: { id: fixture.organizationId } })
    }
  } finally {
    await client.$disconnect()
  }
}
