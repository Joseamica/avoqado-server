import { unsubscribeFromEmailCategory, getUnsubscribeContext } from '../../../../src/services/notifications/emailUnsubscribe.service'
import { NotificationChannel, NotificationType } from '@prisma/client'

// Mock Prisma. $transaction runs the callback with the same mock so writes are observable.
jest.mock('../../../../src/utils/prismaClient', () => {
  const notificationPreference = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  }
  return {
    __esModule: true,
    default: {
      notificationPreference,
      staff: { findUnique: jest.fn() },
      venue: { findUnique: jest.fn() },
      $transaction: jest.fn(async (cb: any) => cb({ notificationPreference })),
    },
  }
})

import prisma from '../../../../src/utils/prismaClient'

const mockFindMany = prisma.notificationPreference.findMany as jest.Mock
const mockFindFirst = prisma.notificationPreference.findFirst as jest.Mock
const mockCreate = prisma.notificationPreference.create as jest.Mock
const mockUpdate = prisma.notificationPreference.update as jest.Mock
const mockStaff = prisma.staff.findUnique as jest.Mock
const mockVenue = prisma.venue.findUnique as jest.Mock

const STAFF = 'staff_1'
const VENUE = 'venue_1'

beforeEach(() => jest.clearAllMocks())

describe('unsubscribeFromEmailCategory (INVENTORY)', () => {
  it('CREATES an email-suppressed row when none exists (missing row = email on by default)', async () => {
    mockFindMany.mockResolvedValue([]) // no rows → default [IN_APP, EMAIL]
    mockFindFirst.mockResolvedValue(null)
    mockCreate.mockImplementation(async ({ data }: any) => ({ id: 'x', ...data }))

    const res = await unsubscribeFromEmailCategory(STAFF, VENUE, 'INVENTORY')

    expect(mockCreate).toHaveBeenCalledTimes(1)
    // keeps IN_APP, drops EMAIL, scoped to staff+venue
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({
      staffId: STAFF,
      venueId: VENUE,
      type: NotificationType.LOW_INVENTORY,
      channels: [NotificationChannel.IN_APP],
    })
    expect(res).toEqual({ affectedTypes: 1, alreadyUnsubscribed: false })
  })

  it('UPDATES an existing row to drop EMAIL while keeping other channels', async () => {
    mockFindMany.mockResolvedValue([
      { type: NotificationType.LOW_INVENTORY, channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.EMAIL] },
    ])
    mockFindFirst.mockResolvedValue({ id: 'row1', type: NotificationType.LOW_INVENTORY })
    mockUpdate.mockImplementation(async ({ data }: any) => ({ id: 'row1', ...data }))

    const res = await unsubscribeFromEmailCategory(STAFF, VENUE, 'INVENTORY')

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate.mock.calls[0][0].data.channels).toEqual([NotificationChannel.IN_APP, NotificationChannel.PUSH])
    expect(res.affectedTypes).toBe(1)
  })

  it('is idempotent: no write when EMAIL is already absent from the existing row', async () => {
    mockFindMany.mockResolvedValue([{ type: NotificationType.LOW_INVENTORY, channels: [NotificationChannel.IN_APP] }])

    const res = await unsubscribeFromEmailCategory(STAFF, VENUE, 'INVENTORY')

    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(res).toEqual({ affectedTypes: 0, alreadyUnsubscribed: true })
  })

  it('scopes the preference lookup by staffId + venueId (tenant isolation)', async () => {
    mockFindMany.mockResolvedValue([])
    mockCreate.mockImplementation(async ({ data }: any) => ({ id: 'x', ...data }))

    await unsubscribeFromEmailCategory(STAFF, VENUE, 'INVENTORY')

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { staffId: STAFF, venueId: VENUE, type: { in: [NotificationType.LOW_INVENTORY] } },
      select: { type: true, channels: true },
    })
  })
})

describe('getUnsubscribeContext', () => {
  it('returns staff email + venue name for the confirm page', async () => {
    mockStaff.mockResolvedValue({ email: 'jose@example.com', firstName: 'Jose' })
    mockVenue.mockResolvedValue({ name: 'Mindform' })

    const ctx = await getUnsubscribeContext(STAFF, VENUE, 'INVENTORY')

    expect(ctx).toEqual({
      staffEmail: 'jose@example.com',
      staffFirstName: 'Jose',
      venueName: 'Mindform',
      categoryLabel: 'alertas de inventario',
    })
  })

  it('returns null when the staff no longer exists', async () => {
    mockStaff.mockResolvedValue(null)
    mockVenue.mockResolvedValue({ name: 'Mindform' })
    expect(await getUnsubscribeContext(STAFF, VENUE, 'INVENTORY')).toBeNull()
  })
})
