jest.mock('@/services/launchCampaigns/hybridPrices', () => ({
  ensureHybridPublicationPrices: jest.fn(async () => {
    throw new Error('Stripe no contestó')
  }),
}))
import prisma from '@/utils/prismaClient'
import { retryListPrice } from '@/services/launchCampaigns/hybridListPrice.service'

const db = prisma as any

it('a failed Stripe preparation still answers HYBRID_LIST_PREPARING when the row cannot be read back', async () => {
  db.hybridCampaign = {
    findFirst: jest.fn(async () => ({ id: 'list1', revision: 2, pendingPublicationId: 'pub1' })),
    findMany: jest.fn(async () => {
      throw new Error('connection lost')
    }),
  }
  // The Stripe failure is what the caller must see; the board row is only a convenience (undefined when unreadable).
  await expect(retryListPrice('FEATURE:CFDI', 'staff1')).rejects.toMatchObject({
    statusCode: 409,
    code: 'HYBRID_LIST_PREPARING',
    details: undefined,
  })
})

// Codex C3: «Reintentar» finishes the pending price the admin saw (its revision), never a newer one saved meanwhile.
it('a retry for a revision that is no longer the list one fails as superseded, before preparing anything', async () => {
  const prepare = jest.requireMock('@/services/launchCampaigns/hybridPrices').ensureHybridPublicationPrices as jest.Mock
  prepare.mockClear()
  db.hybridCampaign = { findFirst: jest.fn(async () => ({ id: 'list1', revision: 5, pendingPublicationId: 'pub_newer' })) }
  await expect(retryListPrice('FEATURE:CFDI', 'staff1', 4)).rejects.toMatchObject({
    statusCode: 409,
    code: 'HYBRID_LIST_SUPERSEDED',
    message: 'Hay un cambio de precio más reciente.',
  })
  expect(prepare).not.toHaveBeenCalled()
})
