import { processPosOrderEvent } from '../../../../src/services/pos-sync/posSyncOrder.service';
import prisma from '../../../../src/utils/prismaClient';
import logger from '../../../../src/config/logger';
import { syncPosStaff } from '../../../../src/services/pos-sync/posSyncStaff.service';
import { getOrCreatePosTable } from '../../../../src/services/pos-sync/posSyncTable.service';
import { getOrCreatePosShift } from '../../../../src/services/pos-sync/posSyncShift.service';
import { NotFoundError } from '../../../../src/errors/AppError';
import { RichPosPayload, PosOrderData, PosStaffPayload, PosTablePayload, PosShiftPayload } from '../../../../src/types/pos.types';
import { OrderSource, OriginSystem, OrderStatus, PaymentStatus, Prisma } from '@prisma/client';

// Mocks
jest.mock('../../../../src/utils/prismaClient', () => ({
  venue: {
    findUnique: jest.fn(),
  },
  order: {
    upsert: jest.fn(),
  },
}));
jest.mock('../../../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(), // Though not directly used in success path of processPosOrderEvent
}));
jest.mock('../../../../src/services/pos-sync/posSyncStaff.service');
jest.mock('../../../../src/services/pos-sync/posSyncTable.service');
jest.mock('../../../../src/services/pos-sync/posSyncShift.service');

describe('POS Sync Order Service (posSyncOrder.service.ts)', () => {
  const mockPrismaVenueFindUnique = prisma.venue.findUnique as jest.Mock;
  const mockPrismaOrderUpsert = prisma.order.upsert as jest.Mock;
  const mockSyncPosStaff = syncPosStaff as jest.Mock;
  const mockGetOrCreatePosTable = getOrCreatePosTable as jest.Mock;
  const mockGetOrCreatePosShift = getOrCreatePosShift as jest.Mock;
  const mockLoggerInfo = logger.info as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const venueId = 'test-venue-id';
  const organizationId = 'test-org-id';
  const mockVenue = { id: venueId, organizationId, name: 'Test Venue' };

  const orderData: PosOrderData = {
    externalId: 'ext-order-1',
    orderNumber: 'ORDER-001',
    status: OrderStatus.COMPLETED,
    paymentStatus: PaymentStatus.PAID,
    subtotal: 100,
    taxAmount: 10,
    discountAmount: 5,
    tipAmount: 15,
    total: 120,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    posRawData: { detail: 'raw_order_data' },
  };
  const staffData: PosStaffPayload = { externalId: 'ext-staff-1', name: 'John Doe', pin: '1234' };
  const tableData: PosTablePayload = { externalId: 'ext-table-1' };
  const shiftData: PosShiftPayload = { externalId: 'ext-shift-1', startTime: new Date().toISOString() };

  const fullPayload: RichPosPayload = {
    venueId,
    orderData,
    staffData,
    tableData,
    shiftData,
  };

  const mockStaffId = 'staff-prisma-id';
  const mockTableId = 'table-prisma-id';
  const mockShiftId = 'shift-prisma-id';
  const mockUpsertedOrder = {
    id: 'order-prisma-id',
    ...orderData,
    venueId,
    source: OrderSource.POS,
    originSystem: OriginSystem.POS_SOFTRESTAURANT,
    createdAt: new Date(orderData.createdAt),
    syncedAt: new Date(), // Will be a new Date()
    updatedAt: new Date(), // Will be a new Date()
    kitchenStatus: 'PENDING',
    type: 'DINE_IN',
  };

  describe('processPosOrderEvent', () => {
    it('should successfully process and upsert an order with all related entities', async () => {
      mockPrismaVenueFindUnique.mockResolvedValue(mockVenue);
      mockSyncPosStaff.mockResolvedValue(mockStaffId);
      mockGetOrCreatePosTable.mockResolvedValue(mockTableId);
      mockGetOrCreatePosShift.mockResolvedValue(mockShiftId);
      mockPrismaOrderUpsert.mockResolvedValue(mockUpsertedOrder);

      const result = await processPosOrderEvent(fullPayload);

      expect(mockPrismaVenueFindUnique).toHaveBeenCalledWith({ where: { id: venueId } });
      expect(mockSyncPosStaff).toHaveBeenCalledWith(staffData, venueId, organizationId);
      expect(mockGetOrCreatePosTable).toHaveBeenCalledWith(tableData, venueId);
      expect(mockGetOrCreatePosShift).toHaveBeenCalledWith(shiftData, venueId, mockStaffId);
      expect(mockPrismaOrderUpsert).toHaveBeenCalledTimes(1);
      expect(mockPrismaOrderUpsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { venueId_externalId: { venueId, externalId: orderData.externalId } },
        update: expect.objectContaining({
          total: orderData.total,
          posRawData: orderData.posRawData as Prisma.InputJsonValue,
        }),
        create: expect.objectContaining({
          externalId: orderData.externalId,
          total: orderData.total,
          venue: { connect: { id: venueId } },
          servedBy: { connect: { id: mockStaffId } },
          createdBy: { connect: { id: mockStaffId } },
          table: { connect: { id: mockTableId } },
          shift: { connect: { id: mockShiftId } },
        }),
      }));
      expect(mockLoggerInfo).toHaveBeenCalledWith(`[PosSyncOrderService] Processing order with externalId: ${orderData.externalId} for venue ${venueId}`);
      expect(mockLoggerInfo).toHaveBeenCalledWith(`[PosSyncOrderService] Order ${mockUpsertedOrder.id} (externalId: ${mockUpsertedOrder.externalId}) saved/updated successfully for venue ${venueId}.`);
      expect(result).toEqual(mockUpsertedOrder);
    });

    it('should throw NotFoundError if venue is not found', async () => {
      mockPrismaVenueFindUnique.mockResolvedValue(null);

      await expect(processPosOrderEvent(fullPayload)).rejects.toThrow(NotFoundError);
      await expect(processPosOrderEvent(fullPayload)).rejects.toThrow(
        `[PosSyncOrderService] Venue with ID ${venueId} not found in Avoqado database.`
      );

      expect(mockSyncPosStaff).not.toHaveBeenCalled();
      expect(mockPrismaOrderUpsert).not.toHaveBeenCalled();
    });

    it('should correctly form create object when some related entities are not present (e.g., no tableId)', async () => {
      mockPrismaVenueFindUnique.mockResolvedValue(mockVenue);
      mockSyncPosStaff.mockResolvedValue(mockStaffId);
      mockGetOrCreatePosTable.mockResolvedValue(null); // Simulate no table
      mockGetOrCreatePosShift.mockResolvedValue(mockShiftId);
      mockPrismaOrderUpsert.mockResolvedValue(mockUpsertedOrder); // Return value doesn't strictly matter here

      await processPosOrderEvent(fullPayload);

      expect(mockPrismaOrderUpsert).toHaveBeenCalledTimes(1);
      const upsertArgs = mockPrismaOrderUpsert.mock.calls[0][0];
      
      expect(upsertArgs.create).toBeDefined();
      expect(upsertArgs.create.table).toBeUndefined(); // Key check: table should not be in create
      expect(upsertArgs.create.servedBy).toEqual({ connect: { id: mockStaffId } });
      expect(upsertArgs.create.shift).toEqual({ connect: { id: mockShiftId } });
    });

    describe('Error Propagation from Dependent Services', () => {
      const dependentServices = [
        { name: 'syncPosStaff', mock: mockSyncPosStaff },
        { name: 'getOrCreatePosTable', mock: mockGetOrCreatePosTable },
        { name: 'getOrCreatePosShift', mock: mockGetOrCreatePosShift },
      ];

      dependentServices.forEach(service => {
        it(`should propagate error if ${service.name} fails`, async () => {
          mockPrismaVenueFindUnique.mockResolvedValue(mockVenue);
          const errorMessage = `${service.name} failed`;
          
          // Make the current service in iteration fail, others succeed
          mockSyncPosStaff.mockImplementation(() => 
            service.name === 'syncPosStaff' ? Promise.reject(new Error(errorMessage)) : Promise.resolve(mockStaffId)
          );
          mockGetOrCreatePosTable.mockImplementation(() => 
            service.name === 'getOrCreatePosTable' ? Promise.reject(new Error(errorMessage)) : Promise.resolve(mockTableId)
          );
          mockGetOrCreatePosShift.mockImplementation(() => 
            service.name === 'getOrCreatePosShift' ? Promise.reject(new Error(errorMessage)) : Promise.resolve(mockShiftId)
          );
          
          // If the failing service is not the first one, ensure previous ones are reset to success for next iteration if needed
          // This setup ensures only one service fails per test run.
          if (service.name !== 'syncPosStaff') mockSyncPosStaff.mockResolvedValue(mockStaffId);
          if (service.name !== 'getOrCreatePosTable') mockGetOrCreatePosTable.mockResolvedValue(mockTableId);
          // getOrCreatePosShift is last, so no need to reset for it in this loop structure

          await expect(processPosOrderEvent(fullPayload)).rejects.toThrow(errorMessage);
          expect(mockPrismaOrderUpsert).not.toHaveBeenCalled();
        });
      });

      it('should propagate error if prisma.order.upsert fails', async () => {
        mockPrismaVenueFindUnique.mockResolvedValue(mockVenue);
        mockSyncPosStaff.mockResolvedValue(mockStaffId);
        mockGetOrCreatePosTable.mockResolvedValue(mockTableId);
        mockGetOrCreatePosShift.mockResolvedValue(mockShiftId);
        
        const prismaErrorMessage = 'Prisma order upsert failed';
        mockPrismaOrderUpsert.mockRejectedValueOnce(new Error(prismaErrorMessage));

        await expect(processPosOrderEvent(fullPayload)).rejects.toThrow(prismaErrorMessage);
      });
    });

    // TODO: Add tests for upsert's update path (if distinguishable by mock setup)
  });
});
