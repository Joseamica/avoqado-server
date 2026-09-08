import { prismaMock } from '../../../__helpers__/setup'
import { cancelStockCount, confirmStockCount, updateStockCount } from '@/services/mobile/inventory.mobile.service'

const COUNT_ID = 'count-revision-1'
const VENUE_ID = 'venue-revision-1'
const STAFF_ID = 'staff-revision-1'

type LockedCount = {
  id: string
  status: 'IN_PROGRESS' | 'APPLYING' | 'COMPLETED' | 'CANCELLED'
  revision: number
  applyingAt: Date | null
}

function lockedCount(overrides: Partial<LockedCount> = {}): LockedCount {
  return {
    id: COUNT_ID,
    status: 'IN_PROGRESS',
    revision: 4,
    applyingAt: null,
    ...overrides,
  }
}

function countSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: COUNT_ID,
    venueId: VENUE_ID,
    status: 'IN_PROGRESS',
    revision: 4,
    items: [],
    ...overrides,
  }
}

describe('stock count revision contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([lockedCount()])
    prismaMock.stockCount.findFirst.mockResolvedValue(countSnapshot() as never)
    prismaMock.stockCountItem.findMany.mockResolvedValue([{ id: 'line-1' }] as never)
    prismaMock.stockCountItem.update.mockResolvedValue({} as never)
    prismaMock.stockCount.update.mockResolvedValue({ revision: 5 } as never)
    prismaMock.stockCount.updateMany.mockResolvedValue({ count: 1 })
  })

  describe('new revision behavior', () => {
    it('serializes PUT behind the parent row lock and returns the incremented revision', async () => {
      await expect(updateStockCount(COUNT_ID, VENUE_ID, [{ id: 'line-1', counted: 8 }], 'Conteo A', 4)).resolves.toEqual({
        success: true,
        revision: 5,
      })

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
      expect(Array.from(prismaMock.$queryRaw.mock.calls[0][0] as string[]).join('?')).toContain('FOR UPDATE')
      expect(prismaMock.stockCount.update).toHaveBeenCalledWith({
        where: { id: COUNT_ID },
        data: { note: 'Conteo A', revision: { increment: 1 } },
        select: { revision: true },
      })
    })

    it('rejects a stale PUT with the bounded machine-readable conflict', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([lockedCount({ revision: 5 })])

      await expect(updateStockCount(COUNT_ID, VENUE_ID, [{ id: 'line-1', counted: 5 }], undefined, 4)).rejects.toMatchObject({
        statusCode: 409,
        code: 'INVENTORY_COUNT_REVISION_CONFLICT',
        details: {
          venueId: VENUE_ID,
          countId: COUNT_ID,
          expectedRevision: 4,
          currentRevision: 5,
          status: 'IN_PROGRESS',
        },
      })

      expect(prismaMock.stockCountItem.update).not.toHaveBeenCalled()
    })

    it('increments a legacy PUT even when expectedRevision is omitted', async () => {
      await expect(updateStockCount(COUNT_ID, VENUE_ID, [{ id: 'line-1', counted: 8 }])).resolves.toEqual({
        success: true,
        revision: 5,
      })
      expect(prismaMock.stockCount.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ revision: { increment: 1 } }) }),
      )
    })

    it('claims and snapshots confirm under the same parent lock, then increments only at COMPLETED', async () => {
      prismaMock.stockCount.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })

      await expect(confirmStockCount(COUNT_ID, VENUE_ID, STAFF_ID, 4)).resolves.toEqual({ success: true, revision: 5 })

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
      const calls = prismaMock.stockCount.updateMany.mock.calls
      expect(calls[0][0].data).toMatchObject({ status: 'APPLYING' })
      expect(calls[0][0].data.revision).toBeUndefined()
      expect(calls[1][0]).toMatchObject({
        where: { id: COUNT_ID, venueId: VENUE_ID, status: 'APPLYING', applyingAt: expect.any(Date), revision: 4 },
        data: { status: 'COMPLETED', completedAt: expect.any(Date), applyingAt: null, revision: { increment: 1 } },
      })
    })

    it('treats an exactly +1 COMPLETED retry with a known base as idempotent success', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([lockedCount({ status: 'COMPLETED', revision: 5 })])

      await expect(confirmStockCount(COUNT_ID, VENUE_ID, STAFF_ID, 4)).resolves.toEqual({ success: true, revision: 5 })
      expect(prismaMock.stockCount.updateMany).not.toHaveBeenCalled()
    })

    it('never accepts +2 as the same lost confirm response', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([lockedCount({ status: 'COMPLETED', revision: 6 })])

      await expect(confirmStockCount(COUNT_ID, VENUE_ID, STAFF_ID, 4)).rejects.toMatchObject({
        statusCode: 409,
        code: 'INVENTORY_COUNT_REVISION_CONFLICT',
        details: expect.objectContaining({ expectedRevision: 4, currentRevision: 6, status: 'COMPLETED' }),
      })
    })

    it.each([
      ['PUT', () => updateStockCount(COUNT_ID, VENUE_ID, [], undefined, 4)],
      ['confirm', () => confirmStockCount(COUNT_ID, VENUE_ID, STAFF_ID, 4)],
      ['cancel', () => cancelStockCount(COUNT_ID, VENUE_ID, STAFF_ID, 4)],
    ])('reports active APPLYING as a retryable machine-readable conflict for known-revision %s', async (_operation, run) => {
      prismaMock.$queryRaw.mockResolvedValueOnce([lockedCount({ status: 'APPLYING', applyingAt: new Date() })])

      await expect(run()).rejects.toMatchObject({
        statusCode: 409,
        code: 'STOCK_COUNT_APPLYING',
        details: {
          venueId: VENUE_ID,
          countId: COUNT_ID,
          currentRevision: 4,
          status: 'APPLYING',
        },
      })
    })

    it('still reports revision conflict before APPLYING when the known revision is stale', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([lockedCount({ status: 'APPLYING', revision: 5, applyingAt: new Date() })])

      await expect(confirmStockCount(COUNT_ID, VENUE_ID, STAFF_ID, 4)).rejects.toMatchObject({
        statusCode: 409,
        code: 'INVENTORY_COUNT_REVISION_CONFLICT',
        details: expect.objectContaining({ expectedRevision: 4, currentRevision: 5, status: 'APPLYING' }),
      })
    })

    it('serializes cancel and increments its revision while preserving response fields', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([lockedCount({ revision: 2 })])

      await expect(cancelStockCount(COUNT_ID, VENUE_ID, STAFF_ID, 2)).resolves.toEqual({
        id: COUNT_ID,
        status: 'CANCELLED',
        cancelledAt: expect.any(String),
        revision: 3,
      })
      expect(prismaMock.stockCount.updateMany).toHaveBeenCalledWith({
        where: { id: COUNT_ID, venueId: VENUE_ID, status: 'IN_PROGRESS', revision: 2 },
        data: { status: 'CANCELLED', cancelledAt: expect.any(Date), revision: { increment: 1 } },
      })
    })

    it('reports revision conflict before treating a stale cancel as already cancelled', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([lockedCount({ status: 'CANCELLED', revision: 3 })])

      await expect(cancelStockCount(COUNT_ID, VENUE_ID, STAFF_ID, 2)).rejects.toMatchObject({
        statusCode: 409,
        code: 'INVENTORY_COUNT_REVISION_CONFLICT',
        details: expect.objectContaining({ expectedRevision: 2, currentRevision: 3, status: 'CANCELLED' }),
      })
    })
  })

  describe('regression behavior', () => {
    it.each([-1, 1.5, Number.NaN])('rejects invalid expectedRevision %s before writing', async expectedRevision => {
      await expect(updateStockCount(COUNT_ID, VENUE_ID, [{ id: 'line-1', counted: 8 }], undefined, expectedRevision)).rejects.toMatchObject(
        {
          statusCode: 400,
        },
      )
      expect(prismaMock.stockCountItem.update).not.toHaveBeenCalled()
    })

    it('keeps unknown counts tenant-scoped', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([])
      await expect(updateStockCount(COUNT_ID, VENUE_ID, [{ id: 'line-1', counted: 8 }], undefined, 0)).rejects.toThrow(/no encontrado/i)
      expect(prismaMock.stockCountItem.update).not.toHaveBeenCalled()
    })

    it('keeps legacy APPLYING responses unchanged', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([lockedCount({ status: 'APPLYING', applyingAt: new Date() })])
      await expect(updateStockCount(COUNT_ID, VENUE_ID, [])).rejects.toMatchObject({ statusCode: 404, code: undefined })

      prismaMock.$queryRaw.mockResolvedValueOnce([lockedCount({ status: 'APPLYING', applyingAt: new Date() })])
      await expect(confirmStockCount(COUNT_ID, VENUE_ID, STAFF_ID)).rejects.toMatchObject({ statusCode: 404, code: undefined })

      prismaMock.$queryRaw.mockResolvedValueOnce([lockedCount({ status: 'APPLYING', applyingAt: new Date() })])
      await expect(cancelStockCount(COUNT_ID, VENUE_ID, STAFF_ID)).rejects.toMatchObject({ statusCode: 409, code: undefined })
    })
  })
})
