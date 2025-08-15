import { processPosAreaEvent } from '../../../../src/services/pos-sync/posSyncArea.service'
import prisma from '../../../../src/utils/prismaClient'
import logger from '../../../../src/config/logger'
import { PosAreaData } from '../../../../src/types/pos.types'
import { OriginSystem, Prisma } from '@prisma/client'

// Mock Prisma client and logger
jest.mock('../../../../src/utils/prismaClient', () => ({
  area: {
    upsert: jest.fn(),
  },
}))
jest.mock('../../../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}))

describe('POS Sync Area Service (posSyncArea.service.ts)', () => {
  const mockPrismaUpsert = prisma.area.upsert as jest.Mock
  const mockLoggerInfo = logger.info as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
  })

  const venueId = 'test-venue-id'
  const areaData: PosAreaData = {
    externalId: 'ext-area-123',
    name: 'Main Dining Room',
    posRawData: { someKey: 'someValue' },
  }

  const payload = {
    venueId,
    areaData,
  }

  it('should call prisma.area.upsert with correct parameters for creating/updating an area', async () => {
    mockPrismaUpsert.mockResolvedValueOnce({ id: 'new-area-id', ...areaData })

    await processPosAreaEvent(payload)

    expect(mockPrismaUpsert).toHaveBeenCalledTimes(1)
    expect(mockPrismaUpsert).toHaveBeenCalledWith({
      where: {
        venueId_externalId: {
          venueId: venueId,
          externalId: areaData.externalId,
        },
      },
      update: {
        name: areaData.name,
        posRawData: areaData.posRawData as Prisma.InputJsonValue,
      },
      create: {
        venueId: venueId,
        externalId: areaData.externalId,
        name: areaData.name,
        originSystem: OriginSystem.POS_SOFTRESTAURANT,
        posRawData: areaData.posRawData as Prisma.InputJsonValue,
      },
    })
  })

  it('should log info messages at the start and end of processing', async () => {
    mockPrismaUpsert.mockResolvedValueOnce({ id: 'area-id', ...areaData })

    await processPosAreaEvent(payload)

    expect(mockLoggerInfo).toHaveBeenCalledTimes(2)
    expect(mockLoggerInfo).toHaveBeenNthCalledWith(
      1,
      `[PosSyncAreaService] Processing event for Area with externalId: ${areaData.externalId} for venue ${venueId}`,
    )
    expect(mockLoggerInfo).toHaveBeenNthCalledWith(
      2,
      `[PosSyncAreaService] Area with externalId ${areaData.externalId} for venue ${venueId} synchronized successfully.`,
    )
  })

  it('should propagate errors if prisma.area.upsert fails', async () => {
    const errorMessage = 'Prisma upsert failed'
    mockPrismaUpsert.mockRejectedValueOnce(new Error(errorMessage))

    await expect(processPosAreaEvent(payload)).rejects.toThrow(errorMessage)

    // Ensure error log is not called by this service, as it doesn't catch the error itself
    expect(logger.error).not.toHaveBeenCalled()
  })
})
