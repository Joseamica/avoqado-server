import prisma from '@/utils/prismaClient'
import { grantVenueAccessBatch } from '@/services/dashboard/venue-access.service'
import * as staffSvc from '@/services/superadmin/staff.superadmin.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import AppError from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}))
jest.mock('@/services/superadmin/staff.superadmin.service')
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

const m = prisma as unknown as { $transaction: jest.Mock }
const upsert = staffSvc.upsertVenueAssignment as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  // run the interactive-transaction callback with a fake tx client
  m.$transaction.mockImplementation(async (cb: any) => cb({}))
  upsert.mockResolvedValue(undefined)
})

describe('grantVenueAccessBatch', () => {
  const actor = { staffId: 'admin-1' }

  it('grants every person and writes one audit log each', async () => {
    const res = await grantVenueAccessBatch(
      'venue-1',
      [
        { staffId: 's1', role: 'MANAGER' as any, pin: '1111' },
        { staffId: 's2', role: 'WAITER' as any, pin: '2222' },
      ],
      actor as any,
    )
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert).toHaveBeenCalledWith(expect.anything(), 's1', 'venue-1', 'MANAGER', '1111')
    expect(logAction).toHaveBeenCalledTimes(2)
    expect(res).toEqual([
      { staffId: 's1', role: 'MANAGER', pin: '1111' },
      { staffId: 's2', role: 'WAITER', pin: '2222' },
    ])
  })

  it('rejects an empty batch', async () => {
    await expect(grantVenueAccessBatch('venue-1', [], actor as any)).rejects.toThrow('al menos una persona')
  })

  it('rejects two people sharing a PIN (would collide at the unique index)', async () => {
    await expect(
      grantVenueAccessBatch(
        'venue-1',
        [
          { staffId: 's1', role: 'MANAGER' as any, pin: '1111' },
          { staffId: 's2', role: 'WAITER' as any, pin: '1111' },
        ],
        actor as any,
      ),
    ).rejects.toThrow('mismo PIN')
    expect(m.$transaction).not.toHaveBeenCalled()
  })

  // Regression: batch pre-validation failures must be AppError instances so the global
  // handler returns a 4xx + the real Spanish message instead of a generic 500.
  it('throws a 400 AppError (not a plain Error) for an empty batch', async () => {
    const err = await grantVenueAccessBatch('venue-1', [], actor as any).catch(e => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err.statusCode).toBe(400)
  })

  it('throws a 400 AppError when two people share a PIN', async () => {
    const err = await grantVenueAccessBatch(
      'venue-1',
      [
        { staffId: 's1', role: 'MANAGER' as any, pin: '1111' },
        { staffId: 's2', role: 'WAITER' as any, pin: '1111' },
      ],
      actor as any,
    ).catch(e => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err.statusCode).toBe(400)
  })

  it('rejects the same person appearing twice', async () => {
    await expect(
      grantVenueAccessBatch(
        'venue-1',
        [
          { staffId: 's1', role: 'MANAGER' as any, pin: '1111' },
          { staffId: 's1', role: 'WAITER' as any, pin: '2222' },
        ],
        actor as any,
      ),
    ).rejects.toThrow('dos veces')
    expect(m.$transaction).not.toHaveBeenCalled()
  })

  it('does NOT write any audit log when a grant fails inside the transaction (atomic)', async () => {
    upsert.mockRejectedValueOnce(new Error('boom'))
    await expect(grantVenueAccessBatch('venue-1', [{ staffId: 's1', role: 'MANAGER' as any, pin: '1111' }], actor as any)).rejects.toThrow(
      'boom',
    )
    expect(logAction).not.toHaveBeenCalled()
  })
})
