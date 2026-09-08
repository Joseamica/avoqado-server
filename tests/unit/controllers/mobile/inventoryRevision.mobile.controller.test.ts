import type { NextFunction, Request, Response } from 'express'

const mockUpdate = jest.fn(async () => ({ success: true, revision: 5 }))
const mockConfirm = jest.fn(async () => ({ success: true, revision: 5 }))
const mockCancel = jest.fn(async () => ({ id: 'c1', status: 'CANCELLED', cancelledAt: '2026-09-08T01:00:00.000Z', revision: 5 }))

jest.mock('@/services/mobile/inventory.mobile.service', () => ({
  updateStockCount: (...args: unknown[]) => mockUpdate(...(args as [])),
  confirmStockCount: (...args: unknown[]) => mockConfirm(...(args as [])),
  cancelStockCount: (...args: unknown[]) => mockCancel(...(args as [])),
}))

import { cancelStockCount, confirmStockCount, updateStockCount } from '@/controllers/mobile/inventory.mobile.controller'

function http(body: Record<string, unknown>) {
  const req = {
    params: { venueId: 'v1', countId: 'c1' },
    body,
    authContext: { userId: 'staff-1' },
  } as unknown as Request
  const res = { json: jest.fn(value => value) } as unknown as Response
  const next = jest.fn() as NextFunction
  return { req, res, next }
}

describe('mobile stock count revision wire contract', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('new revision behavior', () => {
    it('passes expectedRevision through PUT and returns the service revision', async () => {
      const { req, res, next } = http({ items: [{ id: 'line-1', counted: 8 }], note: 'A', expectedRevision: 4 })
      await updateStockCount(req, res, next)

      expect(mockUpdate).toHaveBeenCalledWith('c1', 'v1', [{ id: 'line-1', counted: 8 }], 'A', 4)
      expect(res.json).toHaveBeenCalledWith({ success: true, revision: 5 })
      expect(next).not.toHaveBeenCalled()
    })

    it('passes expectedRevision through confirm', async () => {
      const { req, res, next } = http({ expectedRevision: 4 })
      await confirmStockCount(req, res, next)

      expect(mockConfirm).toHaveBeenCalledWith('c1', 'v1', 'staff-1', 4)
      expect(res.json).toHaveBeenCalledWith({ success: true, revision: 5 })
    })

    it('passes expectedRevision through cancel while preserving its response envelope', async () => {
      const { req, res, next } = http({ expectedRevision: 4 })
      await cancelStockCount(req, res, next)

      expect(mockCancel).toHaveBeenCalledWith('c1', 'v1', 'staff-1', 4)
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        count: { id: 'c1', status: 'CANCELLED', cancelledAt: '2026-09-08T01:00:00.000Z', revision: 5 },
      })
    })
  })

  describe('regression behavior', () => {
    it('keeps expectedRevision optional for legacy PUT clients', async () => {
      const { req, res, next } = http({ items: [{ id: 'line-1', counted: 8 }] })
      await updateStockCount(req, res, next)
      expect(mockUpdate).toHaveBeenCalledWith('c1', 'v1', [{ id: 'line-1', counted: 8 }], undefined, undefined)
    })
  })
})
