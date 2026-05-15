/**
 * pull.service unit tests (Phase 1 — Tasks 15, 16, 17, 18).
 *
 * Covers:
 *   - Phase A (`runBackfill`): events.list shape, pagination, syncToken-only-on-last-page,
 *     event filtering (self-echo / transparent / self-declined / no id),
 *     atomic wipe+reinsert + state commit, early-return for non-CONNECTED.
 *   - Phase B (`runIncrementalPull`): syncToken (no timeMin/timeMax), showDeleted,
 *     per-event handling table from spec §8.1, horizon filter, 410 GONE recovery,
 *     401 hand-off, fallback to backfill when no syncToken yet.
 *   - `pullConnection`: Postgres advisory lock single-flight (not Redis SETNX —
 *     the implementation diverged from the spec; we test the real code).
 *   - `handleAuthError`: refresh success path, invalid_grant → TOKEN_REVOKED + wipe,
 *     other errors rethrow.
 */
import { Prisma } from '@prisma/client'
import { google } from 'googleapis'

import * as externalBusyBlockService from '@/services/google-calendar/external-busy-block.service'
import * as oauthService from '@/services/google-calendar/oauth.service'
import * as rabbitmqConnection from '@/communication/rabbitmq/connection'
import prisma from '@/utils/prismaClient'

// ---- googleapis ----
const eventsListMock = jest.fn()
jest.mock('googleapis', () => ({
  google: {
    calendar: jest.fn(() => ({ events: { list: (...args: any[]) => eventsListMock(...args) } })),
  },
}))

// ---- oauth.service ----
jest.mock('@/services/google-calendar/oauth.service', () => ({
  buildOAuthClient: jest.fn(() => ({ setCredentials: jest.fn() })),
  refreshAccessToken: jest.fn(),
}))

// ---- encryption.service ----
jest.mock('@/services/google-calendar/encryption.service', () => ({
  encryptToken: (s: string) => Buffer.from(`enc:${s}`),
  decryptToken: () => 'plaintext-token',
}))

// ---- external-busy-block.service.upsertBlock ----
// We spy on upsertBlock so the test can verify which events were kept (passed through filters).
jest.mock('@/services/google-calendar/external-busy-block.service', () => ({
  upsertBlock: jest.fn().mockResolvedValue(undefined),
}))

// ---- RabbitMQ ----
const rabbitPublishMock = jest.fn()
jest.mock('@/communication/rabbitmq/connection', () => ({
  getRabbitMQChannel: jest.fn(() => ({ publish: rabbitPublishMock })),
  POS_COMMANDS_EXCHANGE: 'pos_commands_exchange',
}))

import {
  enqueuePullForConnection,
  GCAL_PULL_ROUTING_KEY,
  handleAuthError,
  pullConnection,
  runBackfill,
  runIncrementalPull,
} from '@/services/google-calendar/pull.service'

// ============================================================
// Test fixtures
// ============================================================

const baseConnection: any = {
  id: 'conn-1',
  status: 'CONNECTED',
  scope: 'STAFF_PERSONAL',
  venueId: null,
  staffId: 'staff-1',
  selectedCalendarId: 'cal-1',
  selectedCalendarTimeZone: 'America/Mexico_City',
  syncToken: null,
  accessTokenCiphertext: Buffer.from('at-enc'),
  refreshTokenCiphertext: Buffer.from('rt-enc'),
  venue: null,
}

function makeEvent(overrides: any = {}): any {
  return {
    id: overrides.id ?? 'ev-1',
    start: { dateTime: '2026-05-20T10:00:00Z' },
    end: { dateTime: '2026-05-20T11:00:00Z' },
    ...overrides,
  }
}

function setupConnectionWithSyncToken(token: string | null) {
  ;(prisma.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValue({
    ...baseConnection,
    syncToken: token,
  })
}

// $transaction(cb) calls the callback with the prisma mock as the tx client.
// $transaction([ops...]) just resolves the array of promises.
function setupTransaction() {
  ;(prisma.$transaction as jest.Mock).mockImplementation((arg: any) => {
    if (typeof arg === 'function') return arg(prisma)
    return Promise.all(arg)
  })
}

beforeEach(() => {
  eventsListMock.mockReset()
  rabbitPublishMock.mockReset()
  ;(externalBusyBlockService.upsertBlock as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(oauthService.refreshAccessToken as jest.Mock).mockReset()
  setupTransaction()
  ;(prisma.$queryRaw as jest.Mock).mockReset()
})

// ============================================================
// Phase A — runBackfill
// ============================================================
describe('runBackfill', () => {
  it('sends events.list with timeMin/timeMax/singleEvents:true/showDeleted:false and NO syncToken', async () => {
    setupConnectionWithSyncToken(null)
    eventsListMock.mockResolvedValueOnce({
      data: { items: [makeEvent()], nextPageToken: null, nextSyncToken: 'st-1' },
    })

    await runBackfill('conn-1')

    expect(eventsListMock).toHaveBeenCalledTimes(1)
    const arg = eventsListMock.mock.calls[0][0]
    expect(arg.calendarId).toBe('cal-1')
    expect(arg.singleEvents).toBe(true)
    expect(arg.showDeleted).toBe(false)
    expect(arg.timeMin).toBeDefined()
    expect(arg.timeMax).toBeDefined()
    expect(arg.syncToken).toBeUndefined()
  })

  it('paginates via nextPageToken and only stores the syncToken from the LAST page', async () => {
    setupConnectionWithSyncToken(null)
    eventsListMock
      .mockResolvedValueOnce({
        data: {
          items: [makeEvent({ id: 'p1' })],
          nextPageToken: 'page2',
          // nextSyncToken on a non-last page should be IGNORED.
          nextSyncToken: 'IGNORE-ME',
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [makeEvent({ id: 'p2' })],
          nextPageToken: null,
          nextSyncToken: 'st-final',
        },
      })

    await runBackfill('conn-1')

    expect(eventsListMock).toHaveBeenCalledTimes(2)

    // The connection update must use the LAST-page syncToken.
    const updateCall = (prisma.googleCalendarConnection.update as jest.Mock).mock.calls[0][0]
    expect(updateCall.where).toEqual({ id: 'conn-1' })
    expect(updateCall.data.syncToken).toBe('st-final')
  })

  it('atomically writes syncToken + lastSyncedAt + lastHorizonEnd in ONE transaction after upserts/deletes', async () => {
    setupConnectionWithSyncToken(null)
    eventsListMock.mockResolvedValueOnce({
      data: { items: [makeEvent()], nextPageToken: null, nextSyncToken: 'st-1' },
    })

    await runBackfill('conn-1')

    // ONE $transaction call wraps everything.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)

    // deleteMany pre-existing blocks for the connection happened.
    expect(prisma.externalBusyBlock.deleteMany).toHaveBeenCalledWith({
      where: { googleConnectionId: 'conn-1' },
    })

    const updateData = (prisma.googleCalendarConnection.update as jest.Mock).mock.calls[0][0].data
    expect(updateData.syncToken).toBe('st-1')
    expect(updateData.lastSyncedAt).toBeInstanceOf(Date)
    expect(updateData.lastHorizonEnd).toBeInstanceOf(Date)
  })

  it('skips events with extendedProperties.private.avoqadoOrigin = "avoqado" (self-echo)', async () => {
    setupConnectionWithSyncToken(null)
    eventsListMock.mockResolvedValueOnce({
      data: {
        items: [makeEvent({ id: 'self', extendedProperties: { private: { avoqadoOrigin: 'avoqado' } } }), makeEvent({ id: 'keep' })],
        nextPageToken: null,
        nextSyncToken: 'st-1',
      },
    })

    await runBackfill('conn-1')

    const calls = (externalBusyBlockService.upsertBlock as jest.Mock).mock.calls
    const ids = calls.map(c => c[1].event.id)
    expect(ids).not.toContain('self')
    expect(ids).toContain('keep')
  })

  it('skips events with transparency = "transparent"', async () => {
    setupConnectionWithSyncToken(null)
    eventsListMock.mockResolvedValueOnce({
      data: {
        items: [makeEvent({ id: 'free', transparency: 'transparent' }), makeEvent({ id: 'busy' })],
        nextPageToken: null,
        nextSyncToken: 'st-1',
      },
    })

    await runBackfill('conn-1')

    const ids = (externalBusyBlockService.upsertBlock as jest.Mock).mock.calls.map(c => c[1].event.id)
    expect(ids).not.toContain('free')
    expect(ids).toContain('busy')
  })

  it('skips events where attendees include self with responseStatus=declined', async () => {
    setupConnectionWithSyncToken(null)
    eventsListMock.mockResolvedValueOnce({
      data: {
        items: [
          makeEvent({
            id: 'declined',
            attendees: [{ self: true, responseStatus: 'declined' }],
          }),
          makeEvent({
            id: 'accepted',
            attendees: [{ self: true, responseStatus: 'accepted' }],
          }),
        ],
        nextPageToken: null,
        nextSyncToken: 'st-1',
      },
    })

    await runBackfill('conn-1')

    const ids = (externalBusyBlockService.upsertBlock as jest.Mock).mock.calls.map(c => c[1].event.id)
    expect(ids).not.toContain('declined')
    expect(ids).toContain('accepted')
  })

  it('deletes pre-existing blocks before re-populating (backfill is authoritative for the window)', async () => {
    setupConnectionWithSyncToken(null)
    eventsListMock.mockResolvedValueOnce({
      data: { items: [makeEvent()], nextPageToken: null, nextSyncToken: 'st-1' },
    })

    await runBackfill('conn-1')

    // deleteMany must be invoked exactly once, scoped to the connection.
    expect(prisma.externalBusyBlock.deleteMany).toHaveBeenCalledTimes(1)
    expect(prisma.externalBusyBlock.deleteMany).toHaveBeenCalledWith({
      where: { googleConnectionId: 'conn-1' },
    })
  })

  it('early returns when connection is not CONNECTED (DISCONNECTED, TOKEN_REVOKED, etc.)', async () => {
    ;(prisma.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValue({
      ...baseConnection,
      status: 'TOKEN_REVOKED',
    })

    await runBackfill('conn-1')

    expect(eventsListMock).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('early returns when connection is not found', async () => {
    ;(prisma.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValue(null)

    await runBackfill('conn-1')

    expect(eventsListMock).not.toHaveBeenCalled()
  })

  it('skips events that have no id (defensive — Google should never send these)', async () => {
    setupConnectionWithSyncToken(null)
    eventsListMock.mockResolvedValueOnce({
      data: {
        items: [makeEvent({ id: undefined }), makeEvent({ id: 'keep' })],
        nextPageToken: null,
        nextSyncToken: 'st-1',
      },
    })

    await runBackfill('conn-1')

    const ids = (externalBusyBlockService.upsertBlock as jest.Mock).mock.calls.map(c => c[1].event.id)
    expect(ids).toEqual(['keep'])
  })
})

// ============================================================
// Phase B — runIncrementalPull
// ============================================================
describe('runIncrementalPull', () => {
  it('uses syncToken with showDeleted:true and NO timeMin/timeMax', async () => {
    setupConnectionWithSyncToken('st-existing')
    eventsListMock.mockResolvedValueOnce({
      data: { items: [], nextPageToken: null, nextSyncToken: 'st-next' },
    })

    await runIncrementalPull('conn-1')

    expect(eventsListMock).toHaveBeenCalledTimes(1)
    const arg = eventsListMock.mock.calls[0][0]
    expect(arg.syncToken).toBe('st-existing')
    expect(arg.showDeleted).toBe(true)
    expect(arg.singleEvents).toBe(true)
    // CRITICAL: mixing timeMin/timeMax with syncToken makes Google return 400.
    expect(arg.timeMin).toBeUndefined()
    expect(arg.timeMax).toBeUndefined()
  })

  it('status="cancelled" event deletes the matching ExternalBusyBlock', async () => {
    setupConnectionWithSyncToken('st-1')
    eventsListMock.mockResolvedValueOnce({
      data: {
        items: [{ id: 'gone-1', status: 'cancelled' }],
        nextPageToken: null,
        nextSyncToken: 'st-2',
      },
    })

    await runIncrementalPull('conn-1')

    expect(prisma.externalBusyBlock.deleteMany).toHaveBeenCalledWith({
      where: { googleConnectionId: 'conn-1', externalEventId: 'gone-1' },
    })
    // No upsertBlock for cancelled events.
    expect(externalBusyBlockService.upsertBlock).not.toHaveBeenCalled()
  })

  it('transparency="transparent" deletes the block (user moved event to free)', async () => {
    setupConnectionWithSyncToken('st-1')
    eventsListMock.mockResolvedValueOnce({
      data: {
        items: [makeEvent({ id: 'now-free', transparency: 'transparent' })],
        nextPageToken: null,
        nextSyncToken: 'st-2',
      },
    })

    await runIncrementalPull('conn-1')

    expect(prisma.externalBusyBlock.deleteMany).toHaveBeenCalledWith({
      where: { googleConnectionId: 'conn-1', externalEventId: 'now-free' },
    })
    expect(externalBusyBlockService.upsertBlock).not.toHaveBeenCalled()
  })

  it('self-declined event deletes the block', async () => {
    setupConnectionWithSyncToken('st-1')
    eventsListMock.mockResolvedValueOnce({
      data: {
        items: [
          makeEvent({
            id: 'declined-now',
            attendees: [{ self: true, responseStatus: 'declined' }],
          }),
        ],
        nextPageToken: null,
        nextSyncToken: 'st-2',
      },
    })

    await runIncrementalPull('conn-1')

    expect(prisma.externalBusyBlock.deleteMany).toHaveBeenCalledWith({
      where: { googleConnectionId: 'conn-1', externalEventId: 'declined-now' },
    })
    expect(externalBusyBlockService.upsertBlock).not.toHaveBeenCalled()
  })

  it('event outside horizon [NOW-7d, NOW+maxAdvanceDays] deletes the block', async () => {
    setupConnectionWithSyncToken('st-1')
    const farFuture = new Date(Date.now() + 365 * 86_400_000)
    eventsListMock.mockResolvedValueOnce({
      data: {
        items: [
          makeEvent({
            id: 'far-future',
            start: { dateTime: farFuture.toISOString() },
            end: { dateTime: new Date(farFuture.getTime() + 3_600_000).toISOString() },
          }),
        ],
        nextPageToken: null,
        nextSyncToken: 'st-2',
      },
    })

    await runIncrementalPull('conn-1')

    expect(prisma.externalBusyBlock.deleteMany).toHaveBeenCalledWith({
      where: { googleConnectionId: 'conn-1', externalEventId: 'far-future' },
    })
    expect(externalBusyBlockService.upsertBlock).not.toHaveBeenCalled()
  })

  it('event inside horizon is upserted', async () => {
    setupConnectionWithSyncToken('st-1')
    const soon = new Date(Date.now() + 86_400_000)
    eventsListMock.mockResolvedValueOnce({
      data: {
        items: [
          makeEvent({
            id: 'soon',
            start: { dateTime: soon.toISOString() },
            end: { dateTime: new Date(soon.getTime() + 3_600_000).toISOString() },
          }),
        ],
        nextPageToken: null,
        nextSyncToken: 'st-2',
      },
    })

    await runIncrementalPull('conn-1')

    expect(externalBusyBlockService.upsertBlock).toHaveBeenCalledTimes(1)
    const upsertArgs = (externalBusyBlockService.upsertBlock as jest.Mock).mock.calls[0][1]
    expect(upsertArgs.event.id).toBe('soon')
    expect(upsertArgs.connectionId).toBe('conn-1')
  })

  it('avoqadoOrigin self-echo is skipped (NEITHER upserted NOR deleted)', async () => {
    setupConnectionWithSyncToken('st-1')
    eventsListMock.mockResolvedValueOnce({
      data: {
        items: [
          makeEvent({
            id: 'echo-1',
            extendedProperties: { private: { avoqadoOrigin: 'avoqado' } },
          }),
        ],
        nextPageToken: null,
        nextSyncToken: 'st-2',
      },
    })

    await runIncrementalPull('conn-1')

    expect(externalBusyBlockService.upsertBlock).not.toHaveBeenCalled()
    // deleteMany should NOT be called for the echoed event.
    const deleteCalls = (prisma.externalBusyBlock.deleteMany as jest.Mock).mock.calls
    const echoDeletes = deleteCalls.filter(c => c[0]?.where?.externalEventId === 'echo-1')
    expect(echoDeletes).toHaveLength(0)
  })

  it('falls back to runBackfill when connection.syncToken is null', async () => {
    // First findUnique call (runIncrementalPull) returns no syncToken.
    // Second call (runBackfill via fallback) also returns the connection.
    ;(prisma.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValue({
      ...baseConnection,
      syncToken: null,
    })
    eventsListMock.mockResolvedValueOnce({
      data: { items: [], nextPageToken: null, nextSyncToken: 'st-bf' },
    })

    await runIncrementalPull('conn-1')

    // The single events.list call should look like a backfill (has timeMin/timeMax, no syncToken).
    expect(eventsListMock).toHaveBeenCalledTimes(1)
    const arg = eventsListMock.mock.calls[0][0]
    expect(arg.timeMin).toBeDefined()
    expect(arg.timeMax).toBeDefined()
    expect(arg.syncToken).toBeUndefined()
    expect(arg.showDeleted).toBe(false)
  })

  it('410 GONE: drops all blocks for connection, clears syncToken, re-runs backfill', async () => {
    // First call: incremental — 410 error.
    // Second call: backfill — succeeds.
    ;(prisma.googleCalendarConnection.findUnique as jest.Mock)
      .mockResolvedValueOnce({ ...baseConnection, syncToken: 'st-expired' })
      .mockResolvedValueOnce({ ...baseConnection, syncToken: null })

    const goneErr: any = new Error('Gone')
    goneErr.code = 410
    eventsListMock.mockRejectedValueOnce(goneErr).mockResolvedValueOnce({
      data: { items: [], nextPageToken: null, nextSyncToken: 'st-bf-new' },
    })

    await runIncrementalPull('conn-1')

    // $transaction was called with an array first (drop blocks + clear syncToken),
    // then again as a callback (backfill commit).
    expect(prisma.$transaction).toHaveBeenCalled()

    // The first transaction is an array of operations.
    const firstTxCall = (prisma.$transaction as jest.Mock).mock.calls[0][0]
    expect(Array.isArray(firstTxCall)).toBe(true)

    // The backfill saved the NEW sync token.
    const lastConnUpdate = (prisma.googleCalendarConnection.update as jest.Mock).mock.calls.slice(-1)[0][0]
    expect(lastConnUpdate.data.syncToken).toBe('st-bf-new')
  })

  it('410 GONE detected via err.response.status === 410 too (not just err.code)', async () => {
    ;(prisma.googleCalendarConnection.findUnique as jest.Mock)
      .mockResolvedValueOnce({ ...baseConnection, syncToken: 'st-expired' })
      .mockResolvedValueOnce({ ...baseConnection, syncToken: null })

    const goneErr: any = new Error('Gone')
    goneErr.response = { status: 410 }
    eventsListMock.mockRejectedValueOnce(goneErr).mockResolvedValueOnce({
      data: { items: [], nextPageToken: null, nextSyncToken: 'st-bf' },
    })

    await runIncrementalPull('conn-1')

    // Backfill ran (events.list was called twice — once that 410'd, once that succeeded).
    expect(eventsListMock).toHaveBeenCalledTimes(2)
  })

  it('401 unauthorized invokes handleAuthError (which calls refreshAccessToken)', async () => {
    setupConnectionWithSyncToken('st-1')

    const unauthorizedErr: any = new Error('Unauthorized')
    unauthorizedErr.code = 401
    eventsListMock.mockRejectedValueOnce(unauthorizedErr)

    // handleAuthError will call refreshAccessToken — make it succeed so retry doesn't bomb.
    ;(oauthService.refreshAccessToken as jest.Mock).mockResolvedValue({
      access_token: 'new-at',
      expiry_date: Date.now() + 3_600_000,
    })
    // The retry inside handleAuthError will hit findUnique + events.list again.
    eventsListMock.mockResolvedValueOnce({
      data: { items: [], nextPageToken: null, nextSyncToken: 'st-after-retry' },
    })

    await runIncrementalPull('conn-1')

    expect(oauthService.refreshAccessToken).toHaveBeenCalledTimes(1)
  })

  it('saves nextSyncToken atomically with the per-event handling commit', async () => {
    setupConnectionWithSyncToken('st-old')
    eventsListMock.mockResolvedValueOnce({
      data: { items: [], nextPageToken: null, nextSyncToken: 'st-new' },
    })

    await runIncrementalPull('conn-1')

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    const updateData = (prisma.googleCalendarConnection.update as jest.Mock).mock.calls[0][0].data
    expect(updateData.syncToken).toBe('st-new')
    expect(updateData.lastSyncedAt).toBeInstanceOf(Date)
  })

  it('REGRESSION: does NOT save partial state if pagination throws mid-flight', async () => {
    setupConnectionWithSyncToken('st-1')

    // First page OK, second page throws (non-410, non-401).
    eventsListMock
      .mockResolvedValueOnce({
        data: { items: [makeEvent({ id: 'p1' })], nextPageToken: 'page2' },
      })
      .mockRejectedValueOnce(new Error('upstream blew up'))

    await expect(runIncrementalPull('conn-1')).rejects.toThrow('upstream blew up')

    // The commit transaction must not have run.
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.googleCalendarConnection.update).not.toHaveBeenCalled()
  })
})

// ============================================================
// pullConnection — single-flight lock
// ============================================================
describe('pullConnection (single-flight)', () => {
  it('acquires Postgres advisory lock; if not acquired, returns immediately without running incremental', async () => {
    // Lock NOT acquired
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ acquired: false }])

    await pullConnection('conn-1')

    // findUnique never called → runIncrementalPull never reached.
    expect(prisma.googleCalendarConnection.findUnique).not.toHaveBeenCalled()
    expect(eventsListMock).not.toHaveBeenCalled()
  })

  it('when lock acquired, runs runIncrementalPull and releases lock in finally', async () => {
    // First $queryRaw call: acquire. Second: release.
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ acquired: true }]).mockResolvedValueOnce([])

    setupConnectionWithSyncToken('st-1')
    eventsListMock.mockResolvedValueOnce({
      data: { items: [], nextPageToken: null, nextSyncToken: 'st-2' },
    })

    await pullConnection('conn-1')

    // The incremental pull ran.
    expect(prisma.googleCalendarConnection.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'conn-1' } }))
    // Two $queryRaw calls: acquire + release.
    expect((prisma.$queryRaw as jest.Mock).mock.calls.length).toBe(2)
  })

  it('releases lock even when runIncrementalPull throws', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ acquired: true }]).mockResolvedValueOnce([])

    setupConnectionWithSyncToken('st-1')
    eventsListMock.mockRejectedValue(new Error('boom'))

    await expect(pullConnection('conn-1')).rejects.toThrow('boom')

    // Release still happened.
    expect((prisma.$queryRaw as jest.Mock).mock.calls.length).toBe(2)
  })
})

// ============================================================
// handleAuthError
// ============================================================
describe('handleAuthError', () => {
  it('refresh succeeds → updates accessTokenCiphertext + accessTokenExpiresAt and retries incremental', async () => {
    ;(prisma.googleCalendarConnection.findUnique as jest.Mock)
      // First call: handleAuthError loads the connection.
      .mockResolvedValueOnce({ ...baseConnection })
      // Retry inside handleAuthError calls runIncrementalPull → loadConnection.
      .mockResolvedValueOnce({ ...baseConnection, syncToken: 'st-1' })
    ;(oauthService.refreshAccessToken as jest.Mock).mockResolvedValue({
      access_token: 'new-access-token',
      expiry_date: Date.now() + 3_600_000,
    })

    eventsListMock.mockResolvedValueOnce({
      data: { items: [], nextPageToken: null, nextSyncToken: 'st-2' },
    })

    await handleAuthError('conn-1')

    // Update was called with the new access token (encrypted) and expiry.
    const updateCalls = (prisma.googleCalendarConnection.update as jest.Mock).mock.calls
    const tokenUpdate = updateCalls.find(c => c[0].data.accessTokenCiphertext)
    expect(tokenUpdate).toBeDefined()
    expect(tokenUpdate![0].data.accessTokenExpiresAt).toBeInstanceOf(Date)

    // Incremental retry ran.
    expect(eventsListMock).toHaveBeenCalledTimes(1)
  })

  it('invalid_grant: drops all blocks for the connection AND marks status=TOKEN_REVOKED, NO retry', async () => {
    ;(prisma.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValue({ ...baseConnection })

    const invalidGrantErr: any = new Error('invalid_grant')
    ;(oauthService.refreshAccessToken as jest.Mock).mockRejectedValue(invalidGrantErr)

    await handleAuthError('conn-1')

    // The wipe/revoke transaction ran with an ARRAY (not a callback).
    const txCalls = (prisma.$transaction as jest.Mock).mock.calls
    expect(txCalls.length).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(txCalls[0][0])).toBe(true)

    // Status set to TOKEN_REVOKED.
    const updateCalls = (prisma.googleCalendarConnection.update as jest.Mock).mock.calls
    const revokeUpdate = updateCalls.find(c => c[0].data.status === 'TOKEN_REVOKED')
    expect(revokeUpdate).toBeDefined()
    expect(revokeUpdate![0].data.statusReason).toBe('invalid_grant')

    // Blocks were dropped.
    expect(prisma.externalBusyBlock.deleteMany).toHaveBeenCalledWith({
      where: { googleConnectionId: 'conn-1' },
    })

    // No retry: events.list never called.
    expect(eventsListMock).not.toHaveBeenCalled()
  })

  it('invalid_grant detected via err.response.data.error too', async () => {
    ;(prisma.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValue({ ...baseConnection })

    const invalidGrantErr: any = new Error('refresh failed')
    invalidGrantErr.response = { data: { error: 'invalid_grant' } }
    ;(oauthService.refreshAccessToken as jest.Mock).mockRejectedValue(invalidGrantErr)

    await handleAuthError('conn-1')

    const updateCalls = (prisma.googleCalendarConnection.update as jest.Mock).mock.calls
    const revokeUpdate = updateCalls.find(c => c[0].data.status === 'TOKEN_REVOKED')
    expect(revokeUpdate).toBeDefined()
  })

  it('non-invalid_grant refresh errors are rethrown without corrupting state', async () => {
    ;(prisma.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValue({ ...baseConnection })

    const otherErr = new Error('network unreachable')
    ;(oauthService.refreshAccessToken as jest.Mock).mockRejectedValue(otherErr)

    await expect(handleAuthError('conn-1')).rejects.toThrow('network unreachable')

    // No status update + no block deletion.
    const updateCalls = (prisma.googleCalendarConnection.update as jest.Mock).mock.calls
    const revokeUpdate = updateCalls.find(c => c[0].data.status === 'TOKEN_REVOKED')
    expect(revokeUpdate).toBeUndefined()
    expect(prisma.externalBusyBlock.deleteMany).not.toHaveBeenCalled()
  })

  it('returns early if connection not found (defensive)', async () => {
    ;(prisma.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValue(null)

    await handleAuthError('missing-conn')

    expect(oauthService.refreshAccessToken).not.toHaveBeenCalled()
    expect(prisma.googleCalendarConnection.update).not.toHaveBeenCalled()
  })
})

// ============================================================
// enqueuePullForConnection
// ============================================================
describe('enqueuePullForConnection', () => {
  it('publishes a persistent message to POS_COMMANDS_EXCHANGE with routing key gcal.pull', async () => {
    rabbitPublishMock.mockReturnValue(true)

    await enqueuePullForConnection('conn-1')

    expect(rabbitPublishMock).toHaveBeenCalledTimes(1)
    const [exchange, routingKey, payload, opts] = rabbitPublishMock.mock.calls[0]
    expect(exchange).toBe('pos_commands_exchange')
    expect(routingKey).toBe(GCAL_PULL_ROUTING_KEY)
    expect(routingKey).toBe('gcal.pull')
    expect(JSON.parse(payload.toString())).toEqual({ connectionId: 'conn-1' })
    expect(opts).toEqual({ persistent: true })
  })

  it('throws when publish returns false (buffer full) so caller .catch can degrade gracefully', async () => {
    rabbitPublishMock.mockReturnValue(false)

    await expect(enqueuePullForConnection('conn-1')).rejects.toThrow('rabbitmq_publish_buffer_full')
  })

  it('throws when RabbitMQ is not initialized (getRabbitMQChannel itself throws)', async () => {
    ;(rabbitmqConnection.getRabbitMQChannel as jest.Mock).mockImplementationOnce(() => {
      throw new Error('El canal de RabbitMQ no ha sido inicializado.')
    })

    await expect(enqueuePullForConnection('conn-1')).rejects.toThrow(/no ha sido inicializado/)
  })
})
