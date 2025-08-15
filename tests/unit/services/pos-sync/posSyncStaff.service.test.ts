import { posSyncStaffService } from '../../../../src/services/pos-sync/posSyncStaff.service'
import { PosStaffPayload } from '../../../../src/types/pos.types'
import prisma from '../../../../src/utils/prismaClient'
import logger from '../../../../src/config/logger'
import { NotFoundError } from '../../../../src/errors/AppError'

// Mock the entire prisma client and logger modules
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: {
      findUnique: jest.fn(),
    },
    // Add other prisma models and methods if they are used by the service being tested
  },
}))
jest.mock('../../../../src/config/logger')

describe('POS Sync Staff Service (posSyncStaff.service.ts)', () => {
  // Cast mocks to the correct type for type-safe mocking
  const mockedPrisma = prisma as jest.Mocked<typeof prisma>
  const mockedLogger = logger as jest.Mocked<typeof logger>
  let syncPosStaffSpy: jest.SpyInstance

  beforeEach(() => {
    // Reset mocks before each test
    jest.resetAllMocks()

    // Spy on the syncPosStaff method. We can mock its implementation for each test.
    syncPosStaffSpy = jest.spyOn(posSyncStaffService, 'syncPosStaff')
  })

  afterEach(() => {
    // Restore all mocks after each test
    syncPosStaffSpy.mockRestore()
  })

  describe('processPosStaffEvent', () => {
    const venueId = 'test-venue-id'
    const organizationId = 'test-org-id'
    const staffPayload: PosStaffPayload = {
      externalId: 'pos-staff-123',
      name: 'John POS Doe',
      pin: '1234',
    }
    const eventPayload = { venueId, staffData: staffPayload }
    const mockVenueData = { organizationId }

    it('should find venue, call syncPosStaff with correct params, and log info', async () => {
      // Arrange
      ;(mockedPrisma.venue.findUnique as jest.Mock).mockResolvedValue(mockVenueData)
      syncPosStaffSpy.mockResolvedValue('mock-staff-id') // Mock the return value

      // Act
      await posSyncStaffService.processPosStaffEvent(eventPayload)

      // Assert
      expect(mockedLogger.info).toHaveBeenCalledWith(
        `[PosSyncService] Procesando evento para Staff con externalId: ${staffPayload.externalId}`,
      )
      expect(mockedPrisma.venue.findUnique).toHaveBeenCalledWith({ where: { id: venueId }, select: { organizationId: true } })
      expect(syncPosStaffSpy).toHaveBeenCalledWith(staffPayload, venueId, organizationId)
    })

    it('should throw NotFoundError if venue is not found', async () => {
      // Arrange
      ;(mockedPrisma.venue.findUnique as jest.Mock).mockResolvedValue(null)

      // Act & Assert
      await expect(posSyncStaffService.processPosStaffEvent(eventPayload)).rejects.toThrow(NotFoundError)
      await expect(posSyncStaffService.processPosStaffEvent(eventPayload)).rejects.toThrow(
        '[PosSyncService] Venue con ID test-venue-id no encontrado.',
      )
      expect(syncPosStaffSpy).not.toHaveBeenCalled()
    })

    it('should not throw if syncPosStaff returns null (e.g. invalid payload)', async () => {
      // Arrange
      ;(mockedPrisma.venue.findUnique as jest.Mock).mockResolvedValue(mockVenueData)
      syncPosStaffSpy.mockResolvedValue(null) // Simulate syncPosStaff returning null

      // Act & Assert
      await expect(posSyncStaffService.processPosStaffEvent(eventPayload)).resolves.toBeUndefined()
      expect(syncPosStaffSpy).toHaveBeenCalledWith(staffPayload, venueId, organizationId)
    })
  })
})
