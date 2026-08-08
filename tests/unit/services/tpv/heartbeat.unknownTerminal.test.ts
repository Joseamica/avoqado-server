/**
 * Unknown-terminal heartbeats must be identifiable from the log alone.
 *
 * Real incident (2026-08-08): two PAX terminals started heartbeating as
 * `AVQD-B12C42F3E5FB4FA5` / `AVQD-557F4F224BB7BF3D` — 16-hex `ANDROID_ID`
 * values, not hardware serials. `DeviceInfoManager.getSerialNumber()`
 * (avoqado-tpv) catches the SecurityException from `Build.getSerial()` and
 * falls back to `ANDROID_ID`, so the device heartbeats under an identity that
 * was never registered. After 10 consecutive 404s `HeartbeatWorker` wipes its
 * own activation, which bricks the terminal until someone reactivates it.
 *
 * Triage was impossible: the id matches nothing by definition, and the request
 * IP is the Cloudflare edge (identical for the whole fleet). These tests pin
 * the context that makes the device findable — and that the 404 contract for
 * the TPV client is unchanged.
 */

import { tpvHealthService } from '@/services/tpv/tpv-health.service'
import { NotFoundError } from '@/errors/AppError'
import { looksLikeAndroidIdFallback } from '@/utils/terminalSerial'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  broadcastTpvStatusUpdate: jest.fn(),
  broadcastTpvCommandStatusChanged: jest.fn(),
}))

jest.mock('@/services/tpv/command-queue.service', () => ({
  __esModule: true,
  tpvCommandQueueService: { queueCommand: jest.fn(), getPendingCommands: jest.fn().mockResolvedValue([]) },
}))

const mockedFindUnique = prisma.terminal.findUnique as jest.Mock
const mockedFindFirst = prisma.terminal.findFirst as jest.Mock
const mockedWarn = logger.warn as jest.Mock
const mockedError = logger.error as jest.Mock

/** The single log line carrying the device fingerprint, whatever its severity. */
const fingerprintCall = () => {
  const calls = [...mockedError.mock.calls, ...mockedWarn.mock.calls]
  return calls.find(([, context]) => context && typeof context === 'object' && 'androidIdFallbackSuspected' in context)
}

const GHOST_SERIAL = 'AVQD-B12C42F3E5FB4FA5'

/** Mirrors the real payload shape observed in prod `Terminal.systemInfo`. */
const SYSTEM_INFO = {
  platform: 'Android',
  osVersion: 'Android 10',
  deviceModel: 'A910S',
  manufacturer: 'PAX',
  versionCode: 93,
  uptime: 1733,
  batteryLevel: 46,
  networkType: 'CELLULAR',
  storageAvailableGB: 9.1,
  memory: { free: 184, used: 8, total: 192 },
}

const heartbeat = (terminalId: string) => ({
  terminalId,
  timestamp: new Date().toISOString(),
  status: 'ACTIVE' as const,
  version: '2.7.1',
  systemInfo: SYSTEM_INFO,
})

beforeEach(() => {
  jest.clearAllMocks()
})

describe('looksLikeAndroidIdFallback', () => {
  // NEW FEATURE TESTS
  it('flags a 16-hex ANDROID_ID with the AVQD- prefix', () => {
    expect(looksLikeAndroidIdFallback('AVQD-B12C42F3E5FB4FA5')).toBe(true)
  })

  it('flags the second ghost seen in the same incident', () => {
    expect(looksLikeAndroidIdFallback('AVQD-557F4F224BB7BF3D')).toBe(true)
  })

  it('flags a bare ANDROID_ID sent without the prefix', () => {
    expect(looksLikeAndroidIdFallback('B12C42F3E5FB4FA5')).toBe(true)
  })

  it('is case-insensitive — the client may send lowercase', () => {
    expect(looksLikeAndroidIdFallback('avqd-b12c42f3e5fb4fa5')).toBe(true)
  })

  // REGRESSION TESTS — real serials must never be flagged
  it('does not flag a PAX hardware serial', () => {
    expect(looksLikeAndroidIdFallback('AVQD-2840744155')).toBe(false)
  })

  it('does not flag a NEXGO hardware serial', () => {
    expect(looksLikeAndroidIdFallback('AVQD-N860W173570')).toBe(false)
  })

  it('does not flag a desktop POS identifier', () => {
    expect(looksLikeAndroidIdFallback('DESKTOP-D99AD42B5B')).toBe(false)
  })

  it('does not flag a hypothetical 16-DIGIT serial (no A-F chars)', () => {
    expect(looksLikeAndroidIdFallback('AVQD-1234567890123456')).toBe(false)
  })
})

describe('processHeartbeat — unknown terminal', () => {
  beforeEach(() => {
    // Every lookup path (id, serial, prefixed serial, mentaTerminalId) misses.
    mockedFindUnique.mockResolvedValue(null)
    mockedFindFirst.mockResolvedValue(null)
  })

  // NEW FEATURE TESTS
  it('logs the device fingerprint so the physical terminal can be found', async () => {
    await expect(tpvHealthService.processHeartbeat(heartbeat(GHOST_SERIAL), '189.203.44.10')).rejects.toThrow(NotFoundError)

    const call = fingerprintCall()
    expect(call).toBeDefined()
    const [, context] = call!

    expect(context).toMatchObject({
      terminalId: GHOST_SERIAL,
      androidIdFallbackSuspected: true,
      clientIp: '189.203.44.10',
      appVersion: '2.7.1',
      deviceModel: 'A910S',
      manufacturer: 'PAX',
      osVersion: 'Android 10',
      appVersionCode: 93,
      uptimeSeconds: 1733,
      batteryLevel: 46,
      networkType: 'CELLULAR',
    })
  })

  it('derives bootedAt from uptime — the strongest fingerprint for pinning a device', async () => {
    const now = new Date('2026-08-08T17:25:00.000Z')
    jest.useFakeTimers().setSystemTime(now)

    try {
      await expect(tpvHealthService.processHeartbeat(heartbeat(GHOST_SERIAL))).rejects.toThrow(NotFoundError)

      // 1733s before 17:25:00 → 16:56:07
      expect(fingerprintCall()![1]).toMatchObject({ bootedAt: '2026-08-08T16:56:07.000Z' })
    } finally {
      jest.useRealTimers()
    }
  })

  it('degrades to "unknown" instead of throwing when an old client sends no systemInfo', async () => {
    const legacyPayload = { terminalId: GHOST_SERIAL, timestamp: new Date().toISOString(), status: 'ACTIVE' as const }

    await expect(tpvHealthService.processHeartbeat(legacyPayload)).rejects.toThrow(NotFoundError)

    expect(fingerprintCall()![1]).toMatchObject({
      deviceModel: 'unknown',
      appVersion: 'unknown',
      uptimeSeconds: 'unknown',
      bootedAt: 'unknown',
      clientIp: 'unknown',
    })
  })

  // SEVERITY SPLIT — only a device that LOST its identity is an incident worth paging on.
  // Better Stack alerting only sees error level, so this routing is what makes the
  // self-wiping case visible and keeps routine provisioning gaps out of the alert.
  it('logs at ERROR when a provisioned device fell back to ANDROID_ID', async () => {
    await expect(tpvHealthService.processHeartbeat(heartbeat(GHOST_SERIAL))).rejects.toThrow(NotFoundError)

    const [message, context] = mockedError.mock.calls[0]
    expect(message).toContain('lost its hardware serial')
    expect(context).toMatchObject({ androidIdFallbackSuspected: true })
  })

  it('logs at WARN when the serial looks real and is simply not provisioned yet', async () => {
    await expect(tpvHealthService.processHeartbeat(heartbeat('AVQD-2899999999'))).rejects.toThrow(NotFoundError)

    const [message, context] = mockedWarn.mock.calls[0]
    expect(message).toContain('not provisioned')
    expect(context).toMatchObject({ androidIdFallbackSuspected: false })

    // The pre-existing catch-all still logs an error, but it must NOT be the
    // fingerprint line — otherwise routine provisioning would trip the alert.
    const errorsWithFingerprint = mockedError.mock.calls.filter(
      ([, ctx]) => ctx && typeof ctx === 'object' && 'androidIdFallbackSuspected' in ctx,
    )
    expect(errorsWithFingerprint).toHaveLength(0)
  })

  // REGRESSION TESTS — the 404 contract the TPV client depends on must not move
  it('still throws NotFoundError with the original message', async () => {
    await expect(tpvHealthService.processHeartbeat(heartbeat(GHOST_SERIAL))).rejects.toThrow(
      `Terminal with ID, serial number, or Menta terminal ID ${GHOST_SERIAL} not found`,
    )
  })

  it('never writes to the database for an unknown terminal', async () => {
    await expect(tpvHealthService.processHeartbeat(heartbeat(GHOST_SERIAL))).rejects.toThrow(NotFoundError)

    expect(prisma.terminal.update).not.toHaveBeenCalled()
  })
})

describe('processHeartbeat — known terminal (regression)', () => {
  it('does not emit the unknown-terminal warning when the serial resolves', async () => {
    mockedFindUnique.mockResolvedValue(null)
    mockedFindFirst.mockResolvedValueOnce({
      id: 'term-1',
      serialNumber: 'AVQD-2840744155',
      venueId: 'venue-1',
      status: 'ACTIVE',
      ipAddress: null,
      systemInfo: null,
    })
    ;(prisma.terminal.update as jest.Mock).mockResolvedValue({ id: 'term-1', venueId: 'venue-1' })

    await tpvHealthService.processHeartbeat(heartbeat('AVQD-2840744155'), '189.203.44.10')

    expect(fingerprintCall()).toBeUndefined()
    expect(prisma.terminal.update).toHaveBeenCalled()
  })
})
