const prismaMock = {
  staffVenue: { findFirst: jest.fn() },
  staffSchedule: { findUnique: jest.fn() },
  staffScheduleException: { findMany: jest.fn() },
  $transaction: jest.fn(),
}

const logAction = jest.fn().mockResolvedValue(undefined)

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: prismaMock }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction }))

import { getStaffSchedule, replaceStaffSchedule } from '@/services/dashboard/staffSchedule.service'
import { BadRequestError } from '@/errors/AppError'

const weekly = {
  monday: { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] },
  tuesday: { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] },
  wednesday: { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] },
  thursday: { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] },
  friday: { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] },
  saturday: { enabled: false, ranges: [] },
  sunday: { enabled: false, ranges: [] },
}

describe('staffSchedule service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', venueId: 'venue-1', staff: { active: true } })
    prismaMock.staffSchedule.findUnique.mockResolvedValue(null)
    prismaMock.staffScheduleException.findMany.mockResolvedValue([])
  })

  it('tenant-scopes the parent and returns the default GET shape', async () => {
    await expect(getStaffSchedule('venue-1', 'sv-1')).resolves.toEqual({ staffVenueId: 'sv-1', weekly: null, exceptions: [] })
    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith({
      where: { id: 'sv-1', venueId: 'venue-1' },
      include: { staff: { select: { active: true } } },
    })
  })

  it('rejects missing or foreign parents before opening a transaction', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    await expect(replaceStaffSchedule('venue-1', 'foreign', { weekly, exceptions: [] }, 'actor')).rejects.toBeInstanceOf(BadRequestError)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('upserts weekly, replaces exceptions in order, then logs after settlement', async () => {
    const order: string[] = []
    const tx = {
      staffSchedule: { upsert: jest.fn(async () => order.push('weekly')), deleteMany: jest.fn() },
      staffScheduleException: {
        deleteMany: jest.fn(async () => order.push('delete-exceptions')),
        createMany: jest.fn(async () => order.push('create-exceptions')),
      },
    }
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      const result = await callback(tx)
      order.push('commit')
      return result
    })
    logAction.mockImplementation(async () => order.push('log'))
    const exceptions = [{ startDate: '2026-07-21', endDate: '2026-07-21', kind: 'OFF' as const, note: 'holiday' }]

    await expect(replaceStaffSchedule('venue-1', 'sv-1', { weekly, exceptions }, 'actor')).resolves.toEqual({
      staffVenueId: 'sv-1',
      weekly,
      exceptions,
    })

    expect(order).toEqual(['weekly', 'delete-exceptions', 'create-exceptions', 'commit', 'log'])
    expect(tx.staffSchedule.upsert).toHaveBeenCalledWith({
      where: { staffVenueId: 'sv-1' },
      create: { staffVenueId: 'sv-1', venueId: 'venue-1', weekly },
      update: { venueId: 'venue-1', weekly },
    })
    expect(tx.staffScheduleException.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ staffVenueId: 'sv-1', venueId: 'venue-1', note: 'holiday' })],
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'actor', venueId: 'venue-1', action: 'STAFF_SCHEDULE_UPDATED' }),
    )
  })

  it('deletes weekly independently when weekly is null', async () => {
    const tx = {
      staffSchedule: { upsert: jest.fn(), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      staffScheduleException: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), createMany: jest.fn() },
    }
    prismaMock.$transaction.mockImplementation((callback: any) => callback(tx))

    await replaceStaffSchedule('venue-1', 'sv-1', { weekly: null, exceptions: [] }, 'actor')

    expect(tx.staffSchedule.deleteMany).toHaveBeenCalledWith({ where: { staffVenueId: 'sv-1', venueId: 'venue-1' } })
    expect(tx.staffSchedule.upsert).not.toHaveBeenCalled()
    expect(tx.staffScheduleException.deleteMany).toHaveBeenCalled()
    expect(tx.staffScheduleException.createMany).not.toHaveBeenCalled()
  })

  it('does not log when the transactional exception replacement rejects', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('insert failed'))
    await expect(
      replaceStaffSchedule(
        'venue-1',
        'sv-1',
        { weekly, exceptions: [{ startDate: '2026-07-21', endDate: '2026-07-21', kind: 'OFF' }] },
        'actor',
      ),
    ).rejects.toThrow('insert failed')
    expect(logAction).not.toHaveBeenCalled()
  })
})
