// The global setup mocks prismaClient, but this test must use the real client
// to assert that the Prisma-generated delegates actually exist in the schema.
jest.unmock('@/utils/prismaClient')

import prisma from '@/utils/prismaClient'

describe('RateCorrection models', () => {
  it('exposes rateCorrectionBatch and rateCorrectionEntry delegates', () => {
    expect(prisma.rateCorrectionBatch).toBeDefined()
    expect(prisma.rateCorrectionEntry).toBeDefined()
  })
})
