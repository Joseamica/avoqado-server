import prisma from '../../../../src/utils/prismaClient';
import logger from '../../../../src/config/logger';
import { PosStaffPayload } from '../../../../src/types/pos.types';
import { OriginSystem, StaffRole } from '@prisma/client';

// Import the actual function to be tested
import { posSyncStaffService } from '../../../../src/services/pos-sync/posSyncStaff.service';

// Mocks for external dependencies
jest.mock('../../../../src/utils/prismaClient', () => ({
  staffVenue: {
    findUnique: jest.fn(),
  },
  staff: {
    update: jest.fn(),
    create: jest.fn(),
  },
  // venue mock is not strictly needed for syncPosStaff directly, but keeping for consistency if other utils are called internally
  // If syncPosStaff were to evolve and use prisma.venue, this would be ready.
  venue: {
    findUnique: jest.fn(), // Though not directly used by syncPosStaff, good to have for completeness
  },
}));
jest.mock('../../../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('syncPosStaff (Actual Implementation Tests)', () => {
  const mockPrismaStaffVenueFindUnique = prisma.staffVenue.findUnique as jest.Mock;
  const mockPrismaStaffUpdate = prisma.staff.update as jest.Mock;
  const mockPrismaStaffCreate = prisma.staff.create as jest.Mock;
  // mockPrismaVenueFindUnique is not used by syncPosStaff directly
  const mockLoggerInfo = logger.info as jest.Mock;
  const mockLoggerWarn = logger.warn as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const venueId = 'test-venue-id';
  const organizationId = 'test-org-id';
  const staffPayload: PosStaffPayload = {
    externalId: 'pos-staff-123',
    name: 'John POS Doe',
    pin: '1234',
  };

  // Tests for syncPosStaff (lines 52-186 from original file)
  it('should return null and log a warning if staffPayload is null', async () => {
    const result = await posSyncStaffService.syncPosStaff(null as any, venueId, organizationId);
    expect(result).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith('[PosSyncService] Payload de Staff inválido o sin externalId. No se puede sincronizar.');
    expect(mockPrismaStaffVenueFindUnique).not.toHaveBeenCalled();
  });

  it('should return null and log a warning if staffPayload.externalId is null', async () => {
    const result = await posSyncStaffService.syncPosStaff({ ...staffPayload, externalId: null }, venueId, organizationId);
    expect(result).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith('[PosSyncService] Payload de Staff inválido o sin externalId. No se puede sincronizar.');
    expect(mockPrismaStaffVenueFindUnique).not.toHaveBeenCalled();
  });

  describe('When staff already exists (update path)', () => {
    const existingStaffVenue = {
      staffId: 'existing-staff-prisma-id',
      venueId: venueId,
      posStaffId: staffPayload.externalId as string,
      role: StaffRole.WAITER, // Existing role
    };
    const updatedStaffData = {
      id: existingStaffVenue.staffId,
      firstName: staffPayload.name,
      pin: staffPayload.pin,
    };

    beforeEach(() => {
      mockPrismaStaffVenueFindUnique.mockResolvedValue(existingStaffVenue);
      mockPrismaStaffUpdate.mockResolvedValue(updatedStaffData);
    });

    it('should find existing StaffVenue and update staff details', async () => {
      const result = await posSyncStaffService.syncPosStaff(staffPayload, venueId, organizationId);

      expect(mockPrismaStaffVenueFindUnique).toHaveBeenCalledWith({
        where: { venueId_posStaffId: { venueId, posStaffId: staffPayload.externalId as string } },
      });
      expect(mockPrismaStaffUpdate).toHaveBeenCalledWith({
        where: { id: existingStaffVenue.staffId },
        data: {
          firstName: staffPayload.name,
          pin: staffPayload.pin,
        },
      });
      expect(mockLoggerInfo).toHaveBeenCalledWith(`[PosSyncService] Actualizando Staff existente con externalId: ${staffPayload.externalId}`);
      expect(mockPrismaStaffCreate).not.toHaveBeenCalled();
      expect(result).toBe(existingStaffVenue.staffId);
    });

    it('should use default name if staffPayload.name is null', async () => {
      const payloadWithoutName = { ...staffPayload, name: null };
      mockPrismaStaffUpdate.mockResolvedValueOnce({ ...updatedStaffData, firstName: `Mesero ${payloadWithoutName.externalId}` });
      await posSyncStaffService.syncPosStaff(payloadWithoutName, venueId, organizationId);
      expect(mockPrismaStaffUpdate).toHaveBeenCalledWith(expect.objectContaining({
        data: { firstName: `Mesero ${payloadWithoutName.externalId}`, pin: payloadWithoutName.pin },
      }));
    });

    it('should set pin to null if staffPayload.pin is null', async () => {
      const payloadWithoutPin = { ...staffPayload, pin: null };
      mockPrismaStaffUpdate.mockResolvedValueOnce({ ...updatedStaffData, pin: null });
      await posSyncStaffService.syncPosStaff(payloadWithoutPin, venueId, organizationId);
      expect(mockPrismaStaffUpdate).toHaveBeenCalledWith(expect.objectContaining({
        data: { firstName: payloadWithoutPin.name, pin: null },
      }));
    });
  });

  describe('When staff is new (create path)', () => {
    const newStaffId = 'new-staff-prisma-id';
    const createdStaffData = {
      id: newStaffId,
      organizationId,
      email: `pos-${venueId}-${staffPayload.externalId}@avoqado.app`,
      firstName: staffPayload.name,
      lastName: '(POS)',
      pin: staffPayload.pin,
      originSystem: OriginSystem.POS_SOFTRESTAURANT,
    };

    beforeEach(() => {
      mockPrismaStaffVenueFindUnique.mockResolvedValue(null); // Simulate staff not found
      mockPrismaStaffCreate.mockResolvedValue(createdStaffData);
    });

    it('should create a new staff and staffVenue record', async () => {
      const result = await posSyncStaffService.syncPosStaff(staffPayload, venueId, organizationId);

      expect(mockPrismaStaffVenueFindUnique).toHaveBeenCalledWith({
        where: { venueId_posStaffId: { venueId, posStaffId: staffPayload.externalId as string } },
      });
      expect(mockPrismaStaffCreate).toHaveBeenCalledWith({
        data: {
          organizationId: organizationId,
          email: `pos-${venueId}-${staffPayload.externalId}@avoqado.app`,
          firstName: staffPayload.name,
          lastName: '(POS)',
          pin: staffPayload.pin,
          originSystem: OriginSystem.POS_SOFTRESTAURANT,
          venues: {
            create: {
              venueId: venueId,
              posStaffId: staffPayload.externalId,
              role: StaffRole.WAITER,
            },
          },
        },
      });
      expect(mockLoggerInfo).toHaveBeenCalledWith(`[PosSyncService] Creando nuevo Staff para posStaffId: ${staffPayload.externalId}`);
      expect(mockPrismaStaffUpdate).not.toHaveBeenCalled();
      expect(result).toBe(newStaffId);
    });

    it('should use default name if staffPayload.name is null during creation', async () => {
      const payloadWithoutName = { ...staffPayload, name: null };
      mockPrismaStaffCreate.mockResolvedValueOnce({ ...createdStaffData, firstName: `Mesero ${payloadWithoutName.externalId}` });
      await posSyncStaffService.syncPosStaff(payloadWithoutName, venueId, organizationId);
      expect(mockPrismaStaffCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ firstName: `Mesero ${payloadWithoutName.externalId}` }),
      }));
    });

    it('should set pin to null if staffPayload.pin is null during creation', async () => {
      const payloadWithoutPin = { ...staffPayload, pin: null };
      mockPrismaStaffCreate.mockResolvedValueOnce({ ...createdStaffData, pin: null });
      await posSyncStaffService.syncPosStaff(payloadWithoutPin, venueId, organizationId);
      expect(mockPrismaStaffCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ pin: null }),
      }));
    });
  });
});
