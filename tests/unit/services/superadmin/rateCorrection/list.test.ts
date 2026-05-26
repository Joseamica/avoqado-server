jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { rateCorrectionBatch: { findMany: jest.fn().mockResolvedValue([]) } },
}))
import prisma from '@/utils/prismaClient'
import { listRateCorrections } from '@/services/superadmin/rateCorrection/rateCorrectionList'

describe('listRateCorrections', () => {
  beforeEach(() => jest.clearAllMocks())
  it('filters by venueId when provided', async () => {
    await listRateCorrections({ venueId: 'v1' })
    expect(prisma.rateCorrectionBatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1' }, orderBy: { createdAt: 'desc' } }),
    )
  })
  it('omits where filter when no venueId', async () => {
    await listRateCorrections({})
    expect(prisma.rateCorrectionBatch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {}, orderBy: { createdAt: 'desc' } }))
  })
})
