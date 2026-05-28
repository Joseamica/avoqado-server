/**
 * Tests for the `notification.service` channel-resolution logic and the
 * KYC-submission recipient list.
 *
 * Covers two regressions reported on 2026-05-27:
 *   1. Bug F — `KYC_APPROVED` notifications stored only `[IN_APP]` because the
 *      default preference object overrode the caller's requested EMAIL channel.
 *   2. Item B — `hola@avoqado.io` was only a fallback recipient for new-KYC
 *      submissions; it should always be CC'd so the admin team has a record
 *      regardless of who holds the SUPERADMIN role in the DB.
 */
import { NotificationType, NotificationChannel, NotificationPriority } from '@prisma/client'

// --- Mocks (must run before importing the SUT) ------------------------------

jest.mock('../../../../src/communication/sockets', () => ({
  __esModule: true,
  default: {
    getBroadcastingService: jest.fn(() => ({ broadcastNewNotification: jest.fn() })),
  },
}))

jest.mock('../../../../src/services/resend.service', () => ({
  __esModule: true,
  sendKycSubmissionNotification: jest.fn().mockResolvedValue(true),
  sendNotificationEmail: jest.fn().mockResolvedValue(true),
}))

jest.mock('../../../../src/services/mobile/push.mobile.service', () => ({
  __esModule: true,
  sendPushNotification: jest.fn().mockResolvedValue(true),
}))

jest.mock('../../../../src/services/whatsapp.service', () => ({
  __esModule: true,
  sendWhatsAppMessage: jest.fn().mockResolvedValue(true),
}))

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    notificationPreference: { findUnique: jest.fn() },
    notification: { create: jest.fn(), update: jest.fn() },
    staffVenue: { findMany: jest.fn(), findFirst: jest.fn() },
    staff: { findUnique: jest.fn() },
  },
}))

// --- SUT --------------------------------------------------------------------

import prisma from '../../../../src/utils/prismaClient'
import * as resendService from '../../../../src/services/resend.service'
import { getNotificationPreferences, sendNotification } from '../../../../src/services/dashboard/notification.service'

const prismaMock = prisma as any
const resendMock = resendService as jest.Mocked<typeof resendService>

beforeEach(() => {
  jest.clearAllMocks()
  // Echo the supplied `data` back so `notification.type` and `notification.channels`
  // reflect what `sendNotification` decided to persist — that's what the EMAIL
  // branch (and the test assertions) read downstream.
  prismaMock.notification.create.mockImplementation(({ data }: any) =>
    Promise.resolve({
      id: 'notif-1',
      isRead: false,
      ...data,
      recipient: { id: data.recipientId, email: 'gibran@example.com', phone: null, firstName: 'G', lastName: 'C' },
    }),
  )
})

// ---------------------------------------------------------------------------
// getNotificationPreferences — bug F regression
// ---------------------------------------------------------------------------
describe('getNotificationPreferences', () => {
  it('returns null channels when no preference row exists so caller channels survive', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(null)

    const prefs = await getNotificationPreferences('staff-1', 'venue-1', NotificationType.KYC_APPROVED)

    // null (or empty) — not the legacy hard-coded [IN_APP] that suppressed EMAIL.
    expect(prefs.channels === null || (Array.isArray(prefs.channels) && prefs.channels.length === 0)).toBe(true)
    expect(prefs.enabled).toBe(true)
  })

  it('returns the explicit preference row when it exists', async () => {
    const stored = {
      staffId: 'staff-1',
      venueId: 'venue-1',
      type: NotificationType.KYC_APPROVED,
      enabled: true,
      channels: [NotificationChannel.IN_APP],
      priority: NotificationPriority.NORMAL,
      quietStart: null,
      quietEnd: null,
    }
    prismaMock.notificationPreference.findUnique.mockResolvedValue(stored)

    const prefs = await getNotificationPreferences('staff-1', 'venue-1', NotificationType.KYC_APPROVED)

    expect(prefs.channels).toEqual([NotificationChannel.IN_APP])
  })
})

// ---------------------------------------------------------------------------
// sendNotification — bug F regression
// ---------------------------------------------------------------------------
describe('sendNotification channel resolution', () => {
  it('respects payload.channels when no preference row exists (was silently dropping EMAIL)', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(null)

    await sendNotification({
      recipientId: 'staff-1',
      venueId: 'venue-1',
      type: NotificationType.KYC_APPROVED,
      title: '✅ Approved',
      message: 'KYC approved',
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    })

    // The persisted Notification row must include EMAIL — that's the bug we fixed.
    const created = prismaMock.notification.create.mock.calls[0][0].data
    expect(created.channels).toEqual([NotificationChannel.IN_APP, NotificationChannel.EMAIL])
  })

  it('honors explicit user preference even when payload asks for more channels', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue({
      staffId: 'staff-1',
      venueId: 'venue-1',
      type: NotificationType.KYC_APPROVED,
      enabled: true,
      channels: [NotificationChannel.IN_APP], // user opted out of email
      priority: NotificationPriority.NORMAL,
      quietStart: null,
      quietEnd: null,
    })

    await sendNotification({
      recipientId: 'staff-1',
      venueId: 'venue-1',
      type: NotificationType.KYC_APPROVED,
      title: 'x',
      message: 'y',
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    })

    const created = prismaMock.notification.create.mock.calls[0][0].data
    expect(created.channels).toEqual([NotificationChannel.IN_APP])
  })

  it('falls back to IN_APP when neither preference nor payload specifies channels', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(null)

    await sendNotification({
      recipientId: 'staff-1',
      venueId: 'venue-1',
      type: NotificationType.KYC_APPROVED,
      title: 'x',
      message: 'y',
    })

    const created = prismaMock.notification.create.mock.calls[0][0].data
    expect(created.channels).toEqual([NotificationChannel.IN_APP])
  })
})

// ---------------------------------------------------------------------------
// NEW_KYC_SUBMISSION email recipients — item B
// ---------------------------------------------------------------------------
describe('NEW_KYC_SUBMISSION email recipients', () => {
  it('always includes onboarding@avoqado.io alongside superadmins and venue owner', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(null)
    prismaMock.staffVenue.findMany.mockResolvedValue([{ staff: { email: 'super@avoqado.io' } }])
    prismaMock.staffVenue.findFirst.mockResolvedValue({ staff: { email: 'owner@negocio.mx' } })

    await sendNotification({
      recipientId: 'staff-1',
      venueId: 'venue-1',
      type: NotificationType.NEW_KYC_SUBMISSION,
      title: '🆕 New KYC Submission',
      message: 'Negocio X enviado KYC',
      entityId: 'venue-1',
      metadata: { venueName: 'Negocio X', venueId: 'venue-1' },
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    })

    expect(resendMock.sendKycSubmissionNotification).toHaveBeenCalledTimes(1)
    const passed = resendMock.sendKycSubmissionNotification.mock.calls[0][0]
    expect(passed.recipients).toContain('onboarding@avoqado.io')
    expect(passed.recipients).toContain('super@avoqado.io')
    expect(passed.recipients).toContain('owner@negocio.mx')
  })

  it('still emails onboarding@avoqado.io when no SUPERADMIN exists and there is no owner', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(null)
    prismaMock.staffVenue.findMany.mockResolvedValue([])
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)

    await sendNotification({
      recipientId: 'staff-1',
      venueId: 'venue-1',
      type: NotificationType.NEW_KYC_SUBMISSION,
      title: '🆕',
      message: 'x',
      entityId: 'venue-1',
      metadata: { venueName: 'Negocio Y', venueId: 'venue-1' },
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    })

    const passed = resendMock.sendKycSubmissionNotification.mock.calls[0][0]
    expect(passed.recipients).toEqual(['onboarding@avoqado.io'])
  })

  it('respects ONBOARDING_NOTIFICATIONS_EMAIL env override for KYC submissions too', async () => {
    const prev = process.env.ONBOARDING_NOTIFICATIONS_EMAIL
    process.env.ONBOARDING_NOTIFICATIONS_EMAIL = 'leads@avoqado.io'
    try {
      prismaMock.notificationPreference.findUnique.mockResolvedValue(null)
      prismaMock.staffVenue.findMany.mockResolvedValue([])
      prismaMock.staffVenue.findFirst.mockResolvedValue(null)

      await sendNotification({
        recipientId: 'staff-1',
        venueId: 'venue-1',
        type: NotificationType.NEW_KYC_SUBMISSION,
        title: '🆕',
        message: 'x',
        entityId: 'venue-1',
        metadata: { venueName: 'Negocio Z', venueId: 'venue-1' },
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
      })

      const passed = resendMock.sendKycSubmissionNotification.mock.calls[0][0]
      expect(passed.recipients).toContain('leads@avoqado.io')
    } finally {
      // Restore so we don't leak state into sibling tests.
      if (prev === undefined) delete process.env.ONBOARDING_NOTIFICATIONS_EMAIL
      else process.env.ONBOARDING_NOTIFICATIONS_EMAIL = prev
    }
  })
})
