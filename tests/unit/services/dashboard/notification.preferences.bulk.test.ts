import { updateManyNotificationPreferences } from '../../../../src/services/dashboard/notification.dashboard.service'
import { NotificationChannel, NotificationType } from '@prisma/client'

// Mock Prisma Client. $transaction runs the callback with the same mock client
// so every notificationPreference.* call inside the transaction is observable.
jest.mock('../../../../src/utils/prismaClient', () => {
  const notificationPreference = {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  }
  return {
    __esModule: true,
    default: {
      notificationPreference,
      $transaction: jest.fn(async (cb: any) => cb({ notificationPreference })),
    },
  }
})

import prisma from '../../../../src/utils/prismaClient'

const mockFindFirst = prisma.notificationPreference.findFirst as jest.Mock
const mockCreate = prisma.notificationPreference.create as jest.Mock
const mockUpdate = prisma.notificationPreference.update as jest.Mock
const mockTransaction = (prisma as any).$transaction as jest.Mock

const STAFF = 'staff_1'
const VENUE = 'venue_1'

describe('updateManyNotificationPreferences (atomic master-channel toggle)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('applies every change inside a single transaction', async () => {
    // NEW_ORDER already has a row (update path); PAYMENT_FAILED has none (create path)
    mockFindFirst.mockImplementation(async ({ where }: any) => {
      if (where.type === NotificationType.NEW_ORDER) {
        return { id: 'pref_neworder', staffId: STAFF, venueId: VENUE, type: NotificationType.NEW_ORDER }
      }
      return null
    })
    mockUpdate.mockImplementation(async ({ data }: any) => ({ id: 'pref_neworder', type: NotificationType.NEW_ORDER, ...data }))
    mockCreate.mockImplementation(async ({ data }: any) => ({ id: 'pref_paymentfailed', ...data }))

    const result = await updateManyNotificationPreferences(STAFF, VENUE, [
      { type: NotificationType.NEW_ORDER, channels: [NotificationChannel.IN_APP] },
      { type: NotificationType.PAYMENT_FAILED, channels: [NotificationChannel.IN_APP] },
    ])

    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(result).toHaveLength(2)
    // channels persisted verbatim (EMAIL removed by caller)
    expect(mockUpdate.mock.calls[0][0].data.channels).toEqual([NotificationChannel.IN_APP])
    expect(mockCreate.mock.calls[0][0].data.channels).toEqual([NotificationChannel.IN_APP])
  })

  it('scopes every lookup by staffId + venueId (tenant isolation)', async () => {
    mockFindFirst.mockResolvedValue(null)
    mockCreate.mockImplementation(async ({ data }: any) => ({ id: 'x', ...data }))

    await updateManyNotificationPreferences(STAFF, VENUE, [
      { type: NotificationType.LOW_INVENTORY, channels: [NotificationChannel.IN_APP] },
    ])

    expect(mockFindFirst).toHaveBeenCalledWith({ where: { staffId: STAFF, venueId: VENUE, type: NotificationType.LOW_INVENTORY } })
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({ staffId: STAFF, venueId: VENUE })
  })

  it('rolls back the whole batch if any single write fails (all-or-nothing)', async () => {
    // First item persists, second throws → transaction must reject and nothing is "committed"
    mockFindFirst.mockResolvedValue(null)
    mockCreate
      .mockImplementationOnce(async ({ data }: any) => ({ id: 'ok', ...data }))
      .mockImplementationOnce(async () => {
        throw new Error('DB connection pool timeout (P2024)')
      })

    await expect(
      updateManyNotificationPreferences(STAFF, VENUE, [
        { type: NotificationType.NEW_ORDER, channels: [NotificationChannel.IN_APP] },
        { type: NotificationType.PAYMENT_FAILED, channels: [NotificationChannel.IN_APP] },
      ]),
    ).rejects.toThrow(/P2024/)

    // The transaction wrapper was invoked exactly once; the rejection propagates
    // so the real Prisma $transaction would roll back the first create.
    expect(mockTransaction).toHaveBeenCalledTimes(1)
  })

  it('is a no-op that hits no DB when given an empty change set', async () => {
    const result = await updateManyNotificationPreferences(STAFF, VENUE, [])
    expect(result).toEqual([])
    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockFindFirst).not.toHaveBeenCalled()
  })
})
