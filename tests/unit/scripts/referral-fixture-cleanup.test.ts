import type { PrismaClient } from '@prisma/client'
import { cleanupReferralFixtureData, teardownReferralFixture } from '../../__helpers__/referral-fixture-cleanup'

function makeClient() {
  const deleteMany = () => jest.fn().mockResolvedValue({ count: 0 })
  const client = {
    couponRedemption: { deleteMany: deleteMany() },
    couponCode: { deleteMany: deleteMany() },
    customerDiscount: { deleteMany: deleteMany() },
    discount: { deleteMany: deleteMany() },
    referral: { deleteMany: deleteMany() },
    activityLog: { deleteMany: deleteMany() },
    order: { deleteMany: deleteMany() },
    customer: { deleteMany: deleteMany() },
    referralProgramConfig: { deleteMany: deleteMany() },
    venue: { delete: jest.fn().mockResolvedValue({}) },
    staff: { deleteMany: deleteMany() },
    organization: { delete: jest.fn().mockResolvedValue({}) },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  }

  return client
}

function tenantDeleteMocks(client: ReturnType<typeof makeClient>): jest.Mock[] {
  return [
    client.couponRedemption.deleteMany,
    client.couponCode.deleteMany,
    client.customerDiscount.deleteMany,
    client.discount.deleteMany,
    client.referral.deleteMany,
    client.activityLog.deleteMany,
    client.order.deleteMany,
    client.customer.deleteMany,
    client.referralProgramConfig.deleteMany,
  ]
}

describe('referral integration fixture cleanup safety', () => {
  it('does not issue tenant deletes before a venue fixture exists', async () => {
    const client = makeClient()

    await cleanupReferralFixtureData(client as unknown as PrismaClient, undefined)

    for (const deleteMock of tenantDeleteMocks(client)) {
      expect(deleteMock).not.toHaveBeenCalled()
    }
  })

  it('tears down a partially-created organization without undefined tenant filters', async () => {
    const client = makeClient()

    await teardownReferralFixture(client as unknown as PrismaClient, {
      venueId: undefined,
      organizationId: 'initialized-organization',
      staffIds: [],
    })

    for (const deleteMock of tenantDeleteMocks(client)) {
      expect(deleteMock).not.toHaveBeenCalled()
    }
    expect(client.venue.delete).not.toHaveBeenCalled()
    expect(client.staff.deleteMany).not.toHaveBeenCalled()
    expect(client.organization.delete).toHaveBeenCalledWith({ where: { id: 'initialized-organization' } })
    expect(client.$disconnect).toHaveBeenCalledTimes(1)
  })

  it('disconnects even when initialized fixture teardown fails', async () => {
    const client = makeClient()
    client.organization.delete.mockRejectedValueOnce(new Error('teardown failed'))

    await expect(
      teardownReferralFixture(client as unknown as PrismaClient, {
        venueId: undefined,
        organizationId: 'initialized-organization',
        staffIds: [],
      }),
    ).rejects.toThrow('teardown failed')
    expect(client.$disconnect).toHaveBeenCalledTimes(1)
  })
})
