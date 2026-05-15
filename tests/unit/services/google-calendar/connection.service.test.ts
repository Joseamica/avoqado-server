/**
 * commitConnection service tests (Phase 1).
 *
 * Covers:
 *  - Re-fetches calendarList metadata + final accessRole check.
 *  - Rejects reader-only role for staff_personal intent.
 *  - Subscribes to events.watch BEFORE the transaction.
 *  - Single transaction: consumes session + creates connection + creates channel.
 *  - Session-consume contention surfaces as a ConflictError (transaction rolls back).
 *
 * Regression tests at the bottom guard the contract the controllers depend on.
 */
import { google } from 'googleapis'

import { ConflictError, ValidationError } from '@/errors/AppError'
import * as watchChannelService from '@/services/google-calendar/watch-channel.service'
import prisma from '@/utils/prismaClient'

jest.mock('googleapis', () => ({
  google: {
    calendar: jest.fn(),
  },
}))

// Spy on watch subscription so it doesn't hit googleapis at all.
jest.mock('@/services/google-calendar/watch-channel.service', () => ({
  subscribeToCalendar: jest.fn(),
}))

// buildOAuthClient is invoked but we don't care about its return value because
// the calendar module is mocked above and uses no auth state in tests.
jest.mock('@/services/google-calendar/oauth.service', () => {
  const real = jest.requireActual('@/services/google-calendar/oauth.service')
  return {
    ...real,
    buildOAuthClient: jest.fn().mockReturnValue({ setCredentials: jest.fn() }),
  }
})

// We can't depend on AES-GCM decryption working with arbitrary test bytes; mock
// the helper so any Buffer maps to a fixed plaintext.
jest.mock('@/services/google-calendar/encryption.service', () => ({
  encryptToken: (s: string) => Buffer.from(s),
  decryptToken: () => 'plaintext-token',
}))

import { commitConnection } from '@/services/google-calendar/connection.service'

const baseSession = {
  id: 'session-1',
  authUserId: 'user-1',
  intent: 'staff_personal',
  staffId: 'user-1',
  venueId: null,
  encryptedRefreshToken: Buffer.from('rt-enc'),
  encryptedAccessToken: Buffer.from('at-enc'),
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  googleAccountEmail: 'me@example.com',
  googleAccountSub: 'google-sub-1',
  expiresAt: new Date(Date.now() + 60_000),
  consumedAt: null,
}

function mockCalendarList(meta: { summary?: string; timeZone?: string; accessRole?: string } | null) {
  const calendarListGet = meta ? jest.fn().mockResolvedValue({ data: meta }) : jest.fn().mockRejectedValue(new Error('not_found'))
  ;(google.calendar as jest.Mock).mockReturnValue({
    calendarList: { get: calendarListGet },
  })
  return { calendarListGet }
}

describe('commitConnection (Phase 1)', () => {
  beforeEach(() => {
    process.env.GOOGLE_CALENDAR_WEBHOOK_BASE = 'http://localhost:4000'
    ;(prisma.googleOAuthSession.findUnique as jest.Mock).mockResolvedValue(baseSession)
    // updateMany count = 1 → consumeSession succeeds
    ;(prisma.googleOAuthSession.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.googleCalendarConnection.create as jest.Mock).mockResolvedValue({
      id: 'conn-1',
      scope: 'STAFF_PERSONAL',
      venueId: null,
      staffId: 'user-1',
      googleAccountEmail: 'me@example.com',
      selectedCalendarId: 'cal-1',
      selectedCalendarSummary: 'My calendar',
      selectedCalendarTimeZone: 'America/Mexico_City',
      status: 'CONNECTED',
    })
    ;(prisma.googleCalendarChannel.create as jest.Mock).mockResolvedValue({
      id: 'ch-1',
      connectionId: 'conn-1',
    })

    // $transaction(cb) calls the callback with the prisma client as the tx client
    ;(prisma.$transaction as jest.Mock).mockImplementation((cb: any) => cb(prisma))
    ;(watchChannelService.subscribeToCalendar as jest.Mock).mockResolvedValue({
      channelId: 'channel-uuid-1',
      resourceId: 'resource-1',
      token: 'secret-token',
      expiresAt: new Date(Date.now() + 7 * 86400_000),
    })
  })

  // ============================================================
  // NEW FEATURE TESTS
  // ============================================================
  it('fetches calendar metadata and inserts a connection + channel atomically', async () => {
    mockCalendarList({ summary: 'My calendar', timeZone: 'America/Mexico_City', accessRole: 'owner' })

    const conn = await commitConnection({
      sessionId: 'session-1',
      selectedCalendarId: 'cal-1',
      createdByStaffId: 'user-1',
    })

    expect(conn.id).toBe('conn-1')

    // events.watch subscription was called BEFORE the transaction (so the
    // channel data is atomic-insertable).
    expect(watchChannelService.subscribeToCalendar).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'cal-1',
        webhookUrl: 'http://localhost:4000/api/v1/webhooks/google-calendar',
      }),
    )
    const watchCallOrder = (watchChannelService.subscribeToCalendar as jest.Mock).mock.invocationCallOrder[0]
    const txCallOrder = (prisma.$transaction as jest.Mock).mock.invocationCallOrder[0]
    expect(watchCallOrder).toBeLessThan(txCallOrder)

    // Connection was created with the right shape.
    const connData = (prisma.googleCalendarConnection.create as jest.Mock).mock.calls[0][0].data
    expect(connData.scope).toBe('STAFF_PERSONAL')
    expect(connData.staffId).toBe('user-1')
    expect(connData.venueId).toBeNull()
    expect(connData.selectedCalendarId).toBe('cal-1')
    expect(connData.selectedCalendarTimeZone).toBe('America/Mexico_City')
    expect(connData.createdByStaffId).toBe('user-1')

    // Channel was created with the watch response data.
    const chData = (prisma.googleCalendarChannel.create as jest.Mock).mock.calls[0][0].data
    expect(chData.connectionId).toBe('conn-1')
    expect(chData.channelId).toBe('channel-uuid-1')
    expect(chData.status).toBe('ACTIVE')

    // Session was consumed via updateMany({ consumedAt: null }) guard.
    const consumeCall = (prisma.googleOAuthSession.updateMany as jest.Mock).mock.calls[0][0]
    expect(consumeCall.where).toEqual({ id: 'session-1', consumedAt: null })
  })

  it('venue_master intent maps scope=VENUE and propagates venueId', async () => {
    ;(prisma.googleOAuthSession.findUnique as jest.Mock).mockResolvedValue({
      ...baseSession,
      intent: 'venue_master',
      venueId: 'venue-1',
      staffId: null,
    })
    ;(prisma.googleCalendarConnection.create as jest.Mock).mockResolvedValue({
      id: 'conn-2',
      scope: 'VENUE',
      venueId: 'venue-1',
      staffId: null,
      googleAccountEmail: 'me@example.com',
      selectedCalendarId: 'cal-2',
      selectedCalendarSummary: 'Venue master',
      selectedCalendarTimeZone: 'America/Mexico_City',
      status: 'CONNECTED',
    })

    mockCalendarList({ summary: 'Venue master', timeZone: 'America/Mexico_City', accessRole: 'owner' })

    await commitConnection({ sessionId: 'session-1', selectedCalendarId: 'cal-2', createdByStaffId: 'admin-1' })

    const connData = (prisma.googleCalendarConnection.create as jest.Mock).mock.calls[0][0].data
    expect(connData.scope).toBe('VENUE')
    expect(connData.venueId).toBe('venue-1')
    expect(connData.staffId).toBeNull()
  })

  it('rejects reader-only access role for staff_personal intent (cannot push events to read-only calendar)', async () => {
    mockCalendarList({ summary: 'Shared (read-only)', timeZone: 'America/Mexico_City', accessRole: 'reader' })

    await expect(
      commitConnection({ sessionId: 'session-1', selectedCalendarId: 'cal-1', createdByStaffId: 'user-1' }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Critical: no DB write happened and no watch subscription was created.
    expect(watchChannelService.subscribeToCalendar).not.toHaveBeenCalled()
    expect(prisma.googleCalendarConnection.create).not.toHaveBeenCalled()
    expect(prisma.googleCalendarChannel.create).not.toHaveBeenCalled()
  })

  it('allows reader access role for venue_master intent', async () => {
    ;(prisma.googleOAuthSession.findUnique as jest.Mock).mockResolvedValue({
      ...baseSession,
      intent: 'venue_master',
      venueId: 'venue-1',
      staffId: null,
    })
    mockCalendarList({ summary: 'Venue blocker', timeZone: 'America/Mexico_City', accessRole: 'reader' })

    await expect(
      commitConnection({ sessionId: 'session-1', selectedCalendarId: 'cal-3', createdByStaffId: 'admin-1' }),
    ).resolves.toBeDefined()
  })

  it('surfaces a ConflictError when consumeSession returns count=0 (concurrent commit won)', async () => {
    mockCalendarList({ summary: 'My calendar', timeZone: 'America/Mexico_City', accessRole: 'owner' })
    ;(prisma.googleOAuthSession.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

    await expect(
      commitConnection({ sessionId: 'session-1', selectedCalendarId: 'cal-1', createdByStaffId: 'user-1' }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  // ============================================================
  // REGRESSION TESTS
  // ============================================================
  it('REGRESSION: ciphertext from session is copied verbatim onto the connection (no double-encryption)', async () => {
    mockCalendarList({ summary: 'My calendar', timeZone: 'America/Mexico_City', accessRole: 'owner' })
    await commitConnection({ sessionId: 'session-1', selectedCalendarId: 'cal-1', createdByStaffId: 'user-1' })
    const data = (prisma.googleCalendarConnection.create as jest.Mock).mock.calls[0][0].data
    expect(data.refreshTokenCiphertext).toEqual(baseSession.encryptedRefreshToken)
    expect(data.accessTokenCiphertext).toEqual(baseSession.encryptedAccessToken)
  })

  it('REGRESSION: events.watch failure prevents any DB write (the transaction never runs)', async () => {
    mockCalendarList({ summary: 'My calendar', timeZone: 'America/Mexico_City', accessRole: 'owner' })
    ;(watchChannelService.subscribeToCalendar as jest.Mock).mockRejectedValue(new Error('watch_failed'))

    await expect(commitConnection({ sessionId: 'session-1', selectedCalendarId: 'cal-1', createdByStaffId: 'user-1' })).rejects.toThrow(
      'watch_failed',
    )

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.googleCalendarConnection.create).not.toHaveBeenCalled()
  })
})
