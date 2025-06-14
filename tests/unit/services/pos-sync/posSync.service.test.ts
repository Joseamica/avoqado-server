import { posSyncService } from '../../../../src/services/pos-sync/posSync.service';
import { processPosAreaEvent as mockProcessPosAreaEvent } from '../../../../src/services/pos-sync/posSyncArea.service';
import { processPosOrderEvent as mockProcessPosOrderEvent } from '../../../../src/services/pos-sync/posSyncOrder.service';
import { processPosShiftEvent as mockProcessPosShiftEvent } from '../../../../src/services/pos-sync/posSyncShift.service';
import { posSyncStaffService } from '../../../../src/services/pos-sync/posSyncStaff.service';
const mockProcessPosStaffEvent = posSyncStaffService.processPosStaffEvent;

// Mock the individual service modules
jest.mock('../../../../src/services/pos-sync/posSyncArea.service');
jest.mock('../../../../src/services/pos-sync/posSyncOrder.service');
jest.mock('../../../../src/services/pos-sync/posSyncShift.service');
jest.mock('../../../../src/services/pos-sync/posSyncStaff.service');

describe('POS Sync Service (posSync.service.ts)', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    (mockProcessPosAreaEvent as jest.Mock).mockClear();
    (mockProcessPosOrderEvent as jest.Mock).mockClear();
    (mockProcessPosShiftEvent as jest.Mock).mockClear();
    (mockProcessPosStaffEvent as jest.Mock).mockClear();
  });

  it('should export posSyncService object', () => {
    expect(posSyncService).toBeDefined();
  });

  it('should have processPosAreaEvent property and it should be the mocked function', () => {
    expect(posSyncService).toHaveProperty('processPosAreaEvent');
    expect(posSyncService.processPosAreaEvent).toBe(mockProcessPosAreaEvent);
  });

  it('should have processPosOrderEvent property and it should be the mocked function', () => {
    expect(posSyncService).toHaveProperty('processPosOrderEvent');
    expect(posSyncService.processPosOrderEvent).toBe(mockProcessPosOrderEvent);
  });

  it('should have processPosShiftEvent property and it should be the mocked function', () => {
    expect(posSyncService).toHaveProperty('processPosShiftEvent');
    expect(posSyncService.processPosShiftEvent).toBe(mockProcessPosShiftEvent);
  });

  it('should have processPosStaffEvent property and it should be the mocked function', () => {
    expect(posSyncService).toHaveProperty('processPosStaffEvent');
    expect(typeof posSyncService.processPosStaffEvent).toBe('function');
  });

  it('should call the underlying mockProcessPosAreaEvent when invoked via posSyncService', async () => {
    const mockArgs = { data: 'area_data', orgId: 'org1', venueId: 'venue1' };
    // @ts-ignore - We are testing the call, mock implementation is not crucial here
    await posSyncService.processPosAreaEvent(mockArgs.data, mockArgs.orgId, mockArgs.venueId);
    expect(mockProcessPosAreaEvent).toHaveBeenCalledTimes(1);
    expect(mockProcessPosAreaEvent).toHaveBeenCalledWith(mockArgs.data, mockArgs.orgId, mockArgs.venueId);
  });

  it('should call the underlying mockProcessPosOrderEvent when invoked via posSyncService', async () => {
    const mockArgs = { data: 'order_data', orgId: 'org1', venueId: 'venue1' };
    // @ts-ignore - We are testing the call, mock implementation is not crucial here
    await posSyncService.processPosOrderEvent(mockArgs.data, mockArgs.orgId, mockArgs.venueId);
    expect(mockProcessPosOrderEvent).toHaveBeenCalledTimes(1);
    expect(mockProcessPosOrderEvent).toHaveBeenCalledWith(mockArgs.data, mockArgs.orgId, mockArgs.venueId);
  });

  it('should call the underlying mockProcessPosShiftEvent when invoked via posSyncService', async () => {
    const mockArgs = { data: 'shift_data', orgId: 'org1', venueId: 'venue1' };
    // @ts-ignore - We are testing the call, mock implementation is not crucial here
    await posSyncService.processPosShiftEvent(mockArgs.data, mockArgs.orgId, mockArgs.venueId);
    expect(mockProcessPosShiftEvent).toHaveBeenCalledTimes(1);
    expect(mockProcessPosShiftEvent).toHaveBeenCalledWith(mockArgs.data, mockArgs.orgId, mockArgs.venueId);
  });

  it('should call the underlying mockProcessPosStaffEvent when invoked via posSyncService', async () => {
    const mockArgs = { data: 'staff_data', orgId: 'org1', venueId: 'venue1' };
    // @ts-ignore - We are testing the call, mock implementation is not crucial here
    await posSyncService.processPosStaffEvent(mockArgs.data, mockArgs.orgId, mockArgs.venueId);
    expect(mockProcessPosStaffEvent).toHaveBeenCalledTimes(1);
    expect(mockProcessPosStaffEvent).toHaveBeenCalledWith(mockArgs.data, mockArgs.orgId, mockArgs.venueId);
  });
})
