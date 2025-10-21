import { updateVenue } from '../../../../src/services/dashboard/venue.dashboard.service'
import { NotFoundError } from '../../../../src/errors/AppError'

// Mock Prisma Client
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}))

import prisma from '../../../../src/utils/prismaClient'

describe('Venue Dashboard Service', () => {
  const mockPrismaVenueFindFirst = prisma.venue.findFirst as jest.Mock
  const mockPrismaVenueUpdate = prisma.venue.update as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('updateVenue', () => {
    const orgId = 'org-123'
    const venueId = 'venue-456'

    const mockExistingVenue = {
      id: venueId,
      organizationId: orgId,
      name: 'Original Venue',
      timezone: 'America/Mexico_City',
      address: 'Original Address',
      city: 'Original City',
      phone: 'Original Phone',
    }

    it('should update timezone field correctly (bug fix)', async () => {
      // Arrange
      const newTimezone = 'America/Los_Angeles'
      const updateData = { timezone: newTimezone }

      mockPrismaVenueFindFirst.mockResolvedValue(mockExistingVenue)
      mockPrismaVenueUpdate.mockResolvedValue({
        ...mockExistingVenue,
        timezone: newTimezone,
      })

      // Act
      const result = await updateVenue(orgId, venueId, updateData)

      // Assert
      expect(result.timezone).toBe(newTimezone)
      expect(mockPrismaVenueUpdate).toHaveBeenCalledWith({
        where: { id: venueId },
        data: expect.objectContaining({
          timezone: newTimezone,
        }),
        include: {
          features: true,
        },
      })
    })

    it('should update name field correctly (regression)', async () => {
      // Arrange
      const newName = 'Updated Venue Name'
      const updateData = { name: newName }

      mockPrismaVenueFindFirst.mockResolvedValue(mockExistingVenue)
      mockPrismaVenueUpdate.mockResolvedValue({
        ...mockExistingVenue,
        name: newName,
      })

      // Act
      const result = await updateVenue(orgId, venueId, updateData)

      // Assert
      expect(result.name).toBe(newName)
      expect(mockPrismaVenueUpdate).toHaveBeenCalledWith({
        where: { id: venueId },
        data: expect.objectContaining({
          name: newName,
        }),
        include: {
          features: true,
        },
      })
    })

    it('should update address field correctly (regression)', async () => {
      // Arrange
      const newAddress = '123 New Street'
      const updateData = { address: newAddress }

      mockPrismaVenueFindFirst.mockResolvedValue(mockExistingVenue)
      mockPrismaVenueUpdate.mockResolvedValue({
        ...mockExistingVenue,
        address: newAddress,
      })

      // Act
      const result = await updateVenue(orgId, venueId, updateData)

      // Assert
      expect(result.address).toBe(newAddress)
      expect(mockPrismaVenueUpdate).toHaveBeenCalledWith({
        where: { id: venueId },
        data: expect.objectContaining({
          address: newAddress,
        }),
        include: {
          features: true,
        },
      })
    })

    it('should update multiple fields together (regression)', async () => {
      // Arrange
      const updateData = {
        phone: '+52 123 456 7890',
        email: 'test@venue.com',
        website: 'https://testvenue.com',
      }

      mockPrismaVenueFindFirst.mockResolvedValue(mockExistingVenue)
      mockPrismaVenueUpdate.mockResolvedValue({
        ...mockExistingVenue,
        ...updateData,
      })

      // Act
      const result = await updateVenue(orgId, venueId, updateData)

      // Assert
      expect(result.phone).toBe(updateData.phone)
      expect(result.email).toBe(updateData.email)
      expect(result.website).toBe(updateData.website)
      expect(mockPrismaVenueUpdate).toHaveBeenCalledWith({
        where: { id: venueId },
        data: expect.objectContaining({
          phone: updateData.phone,
          email: updateData.email,
          website: updateData.website,
        }),
        include: {
          features: true,
        },
      })
    })

    it('should throw NotFoundError if venue does not exist', async () => {
      // Arrange
      mockPrismaVenueFindFirst.mockResolvedValue(null)

      // Act & Assert
      await expect(updateVenue(orgId, venueId, { name: 'Test' })).rejects.toThrow(NotFoundError)
      await expect(updateVenue(orgId, venueId, { name: 'Test' })).rejects.toThrow(`Venue with ID ${venueId} not found in organization`)
    })

    it('should throw NotFoundError if venue belongs to different organization', async () => {
      // Arrange
      const differentOrgId = 'different-org-789'
      mockPrismaVenueFindFirst.mockResolvedValue(null)

      // Act & Assert
      await expect(updateVenue(differentOrgId, venueId, { name: 'Test' })).rejects.toThrow(NotFoundError)
    })

    it('should remove null/undefined values before updating', async () => {
      // Arrange
      const updateData = {
        name: 'New Name',
        address: null,
        city: undefined,
        phone: '+52 123',
      }

      mockPrismaVenueFindFirst.mockResolvedValue(mockExistingVenue)
      mockPrismaVenueUpdate.mockResolvedValue({
        ...mockExistingVenue,
        name: updateData.name,
        phone: updateData.phone,
      })

      // Act
      await updateVenue(orgId, venueId, updateData)

      // Assert
      expect(mockPrismaVenueUpdate).toHaveBeenCalledWith({
        where: { id: venueId },
        data: expect.not.objectContaining({
          address: null,
          city: undefined,
        }),
        include: {
          features: true,
        },
      })

      // Verify only non-null values are in the update
      const updateCall = mockPrismaVenueUpdate.mock.calls[0][0]
      expect(updateCall.data).toHaveProperty('name')
      expect(updateCall.data).toHaveProperty('phone')
      expect(updateCall.data).not.toHaveProperty('address')
      expect(updateCall.data).not.toHaveProperty('city')
    })
  })
})
