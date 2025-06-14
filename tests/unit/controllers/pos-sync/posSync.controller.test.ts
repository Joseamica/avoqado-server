import { Request, Response, NextFunction } from 'express'

import * as posSyncTestService from '../../services/pos-sync/posSyncTest.service'
import { handlePosOrderTest } from './posSync.controller'

// Mock the posSync service
jest.mock('../../services/pos-sync/posSyncTest.service', () => ({
  processTestPosOrder: jest.fn(),
}))

describe('PosSymc Controller Tests', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: NextFunction

  beforeEach(() => {
    req = {
      body: {
        externalId: 'test-123',
        venueId: 'clj0a1b2c3d4e5f6g7h8i9j0',
        orderNumber: 'ORDER-123',
        subtotal: 100.5,
        taxAmount: 16.08,
        total: 116.58,
        createdAt: '2023-06-13T10:15:30Z',
        posRawData: { source: 'test' },
        discountAmount: 0,
        tipAmount: 0,
      },
    }
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    }
    next = jest.fn()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  test('should process POS order test successfully', async () => {
    const mockOrder = {
      id: 'clj0a1b2c3d4e5f6g7h8i9j0',
      orderNumber: 'ORDER-123',
      externalId: 'test-123',
      venueId: 'clj0a1b2c3d4e5f6g7h8i9j0',
      subtotal: 100.5,
      taxAmount: 16.08,
      total: 116.58,
      status: 'PROCESSED',
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    ;(posSyncTestService.processTestPosOrder as jest.Mock).mockResolvedValue(mockOrder)

    await handlePosOrderTest(req as Request, res as Response, next)

    expect(posSyncTestService.processTestPosOrder).toHaveBeenCalledWith(req.body)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      message: 'Test order processed successfully',
      order: mockOrder,
    })
  })

  test('should pass error to next middleware if processing fails', async () => {
    const errorMessage = 'Processing error'
    ;(posSyncTestService.processTestPosOrder as jest.Mock).mockRejectedValue(new Error(errorMessage))

    await handlePosOrderTest(req as Request, res as Response, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })
})
