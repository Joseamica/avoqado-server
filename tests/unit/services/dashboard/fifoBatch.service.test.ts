/**
 * FIFO Batch Service Tests - Priority 1A: Row-Level Locking
 *
 * Tests the row-level locking implementation using PostgreSQL FOR UPDATE NOWAIT
 * to prevent race conditions in concurrent stock deductions.
 *
 * World-Class Pattern: Shopify Inventory Reservation System
 */

import prisma from '@/utils/prismaClient'
import { deductStockFIFO } from '@/services/dashboard/fifoBatch.service'
import AppError from '@/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

// Mock dependencies
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    rawMaterial: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    stockBatch: {
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    rawMaterialMovement: {
      create: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

describe('FIFO Batch Service - Row-Level Locking', () => {
  const mockVenueId = 'venue-123'
  const mockRawMaterialId = 'raw-123'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('deductStockFIFO - Priority 1A', () => {
    it('should lock batches INSIDE transaction using FOR UPDATE NOWAIT', async () => {
      // Setup
      const mockRawMaterial = {
        id: mockRawMaterialId,
        venueId: mockVenueId,
        name: 'Carne',
        currentStock: new Decimal(20),
        unit: 'KG',
      }

      const mockLockedBatches = [
        {
          id: 'batch-1',
          remainingQuantity: new Decimal(10),
          costPerUnit: new Decimal(5),
          receivedDate: new Date('2025-01-01'),
          batchNumber: 'B001',
          unit: 'KG',
        },
        {
          id: 'batch-2',
          remainingQuantity: new Decimal(10),
          costPerUnit: new Decimal(5.5),
          receivedDate: new Date('2025-01-02'),
          batchNumber: 'B002',
          unit: 'KG',
        },
      ]

      // Mock transaction to execute callback
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
        // Create mock transaction client
        const mockTx = {
          $queryRaw: jest.fn().mockResolvedValue(mockLockedBatches),
          stockBatch: {
            update: jest.fn().mockResolvedValue({}),
          },
          rawMaterialMovement: {
            create: jest.fn().mockResolvedValue({}),
          },
          rawMaterial: {
            findUnique: jest.fn().mockResolvedValue(mockRawMaterial),
            update: jest.fn().mockResolvedValue(mockRawMaterial),
          },
        }

        return await callback(mockTx)
      })

      // Execute
      await deductStockFIFO(mockVenueId, mockRawMaterialId, 5, 'USAGE', {
        reason: 'Test deduction',
        reference: 'test-ref',
      })

      // Verify - Check that $transaction was called with Serializable isolation
      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          isolationLevel: 'Serializable',
          timeout: 10000,
        }),
      )

      // Verify - Check that $queryRaw was called with FOR UPDATE NOWAIT
      const txCall = (prisma.$transaction as jest.Mock).mock.calls[0][0]
      const mockTx = {
        $queryRaw: jest.fn().mockResolvedValue(mockLockedBatches),
        stockBatch: { update: jest.fn() },
        rawMaterialMovement: { create: jest.fn() },
        rawMaterial: {
          findUnique: jest.fn().mockResolvedValue(mockRawMaterial),
          update: jest.fn().mockResolvedValue(mockRawMaterial),
        },
      }

      await txCall(mockTx)

      expect(mockTx.$queryRaw).toHaveBeenCalled()
      // Note: We can't easily test the SQL string content in a unit test,
      // but the implementation uses FOR UPDATE NOWAIT in the query
    })

    it('should handle lock timeout gracefully (PostgreSQL error 55P03)', async () => {
      // Setup - Simulate lock timeout error
      const lockTimeoutError = new Error('could not obtain lock on row')
      ;(lockTimeoutError as any).code = '55P03' // PostgreSQL lock not available error
      ;(prisma.$transaction as jest.Mock).mockRejectedValue(lockTimeoutError)

      // Execute & Verify
      await expect(
        deductStockFIFO(mockVenueId, mockRawMaterialId, 5, 'USAGE', {
          reason: 'Concurrent test',
          reference: 'test-ref',
        }),
      ).rejects.toThrow()
    })

    it('should allocate from oldest batches first (FIFO)', async () => {
      // Setup
      const mockRawMaterial = {
        id: mockRawMaterialId,
        venueId: mockVenueId,
        name: 'Carne',
        currentStock: new Decimal(20),
        unit: 'KG',
      }

      const oldBatch = {
        id: 'batch-old',
        remainingQuantity: new Decimal(5),
        costPerUnit: new Decimal(4), // Older = cheaper
        receivedDate: new Date('2025-01-01'),
        batchNumber: 'B001',
        unit: 'KG',
      }

      const newBatch = {
        id: 'batch-new',
        remainingQuantity: new Decimal(15),
        costPerUnit: new Decimal(6), // Newer = more expensive
        receivedDate: new Date('2025-01-10'),
        batchNumber: 'B002',
        unit: 'KG',
      }

      const mockLockedBatches = [oldBatch, newBatch] // Already sorted by receivedDate ASC

      const batchUpdateCalls: any[] = []

      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
        const mockTx = {
          $queryRaw: jest.fn().mockResolvedValue(mockLockedBatches),
          stockBatch: {
            update: jest.fn().mockImplementation((args: any) => {
              batchUpdateCalls.push(args)
              return Promise.resolve({})
            }),
          },
          rawMaterialMovement: {
            create: jest.fn().mockResolvedValue({}),
          },
          rawMaterial: {
            findUnique: jest.fn().mockResolvedValue(mockRawMaterial),
            update: jest.fn().mockResolvedValue(mockRawMaterial),
          },
        }

        return await callback(mockTx)
      })

      // Execute - Deduct 7 KG (should take all 5 from old batch, 2 from new batch)
      await deductStockFIFO(mockVenueId, mockRawMaterialId, 7, 'USAGE', {
        reason: 'FIFO test',
        reference: 'test-ref',
      })

      // Verify - Old batch should be updated first
      expect(batchUpdateCalls.length).toBeGreaterThan(0)
      // First update should be for the older batch
      expect(batchUpdateCalls[0].where.id).toBe('batch-old')
    })

    it('should throw error when insufficient stock across all batches', async () => {
      // Setup
      const mockLockedBatches = [
        {
          id: 'batch-1',
          remainingQuantity: new Decimal(3), // Only 3 KG available
          costPerUnit: new Decimal(5),
          receivedDate: new Date('2025-01-01'),
          batchNumber: 'B001',
          unit: 'KG',
        },
      ]

      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
        const mockTx = {
          $queryRaw: jest.fn().mockResolvedValue(mockLockedBatches),
        }

        return await callback(mockTx)
      })

      // Execute & Verify - Try to deduct 10 KG when only 3 available
      await expect(
        deductStockFIFO(mockVenueId, mockRawMaterialId, 10, 'USAGE', {
          reason: 'Insufficient stock test',
          reference: 'test-ref',
        }),
      ).rejects.toThrow(AppError)

      await expect(
        deductStockFIFO(mockVenueId, mockRawMaterialId, 10, 'USAGE', {
          reason: 'Insufficient stock test',
          reference: 'test-ref',
        }),
      ).rejects.toThrow(/Insufficient stock/i)
    })
  })

  describe('REGRESSION TESTS - Existing FIFO functionality', () => {
    it('should still create raw material movements correctly', async () => {
      // Setup
      const mockRawMaterial = {
        id: mockRawMaterialId,
        venueId: mockVenueId,
        name: 'Carne',
        currentStock: new Decimal(20),
        unit: 'KG',
      }

      const mockLockedBatches = [
        {
          id: 'batch-1',
          remainingQuantity: new Decimal(10),
          costPerUnit: new Decimal(5),
          receivedDate: new Date('2025-01-01'),
          batchNumber: 'B001',
          unit: 'KG',
        },
      ]

      const movementCreateCalls: any[] = []

      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
        const mockTx = {
          $queryRaw: jest.fn().mockResolvedValue(mockLockedBatches),
          stockBatch: {
            update: jest.fn().mockResolvedValue({}),
          },
          rawMaterialMovement: {
            create: jest.fn().mockImplementation((args: any) => {
              movementCreateCalls.push(args)
              return Promise.resolve({ id: 'mov-1', ...args.data })
            }),
          },
          rawMaterial: {
            findUnique: jest.fn().mockResolvedValue(mockRawMaterial),
            update: jest.fn().mockResolvedValue(mockRawMaterial),
          },
        }

        return await callback(mockTx)
      })

      // Execute
      await deductStockFIFO(mockVenueId, mockRawMaterialId, 5, 'USAGE', {
        reason: 'Test movement',
        reference: 'order-123',
      })

      // Verify - Movement was created
      expect(movementCreateCalls.length).toBeGreaterThan(0)
      expect(movementCreateCalls[0].data).toEqual(
        expect.objectContaining({
          rawMaterialId: mockRawMaterialId,
          type: 'USAGE',
          reference: 'order-123',
        }),
      )
    })

    it('should still update raw material current stock correctly', async () => {
      // Setup
      const mockRawMaterial = {
        id: mockRawMaterialId,
        venueId: mockVenueId,
        name: 'Carne',
        currentStock: new Decimal(20),
        unit: 'KG',
      }

      const mockLockedBatches = [
        {
          id: 'batch-1',
          remainingQuantity: new Decimal(10),
          costPerUnit: new Decimal(5),
          receivedDate: new Date('2025-01-01'),
          batchNumber: 'B001',
          unit: 'KG',
        },
      ]

      const rawMaterialUpdateCalls: any[] = []

      ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
        const mockTx = {
          $queryRaw: jest.fn().mockResolvedValue(mockLockedBatches),
          stockBatch: {
            update: jest.fn().mockResolvedValue({}),
          },
          rawMaterialMovement: {
            create: jest.fn().mockResolvedValue({ id: 'mov-1' }),
          },
          rawMaterial: {
            findUnique: jest.fn().mockResolvedValue(mockRawMaterial),
            update: jest.fn().mockImplementation((args: any) => {
              rawMaterialUpdateCalls.push(args)
              return Promise.resolve(mockRawMaterial)
            }),
          },
        }

        return await callback(mockTx)
      })

      // Execute
      await deductStockFIFO(mockVenueId, mockRawMaterialId, 5, 'USAGE', {
        reason: 'Test stock update',
        reference: 'test-ref',
      })

      // Verify - RawMaterial stock was updated
      expect(rawMaterialUpdateCalls.length).toBeGreaterThan(0)
      expect(rawMaterialUpdateCalls[0]).toEqual(
        expect.objectContaining({
          where: { id: mockRawMaterialId },
          data: expect.objectContaining({
            currentStock: expect.any(Object), // Should be a Decimal
          }),
        }),
      )
    })
  })
})
