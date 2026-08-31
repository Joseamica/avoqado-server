import {
  aggregateDisplayModeRollout,
  executeDisplayModeRolloutCli,
  MAX_REPORT_WINDOW_DAYS,
  parseDisplayModeRolloutArgs,
  REPORT_PAGE_SIZE,
  type DisplayModeAuditRow,
  type PosAndroidCapabilityRow,
} from '../../../scripts/report-display-mode-rollout'

const FROM = new Date('2026-08-01T00:00:00.000Z')
const TO = new Date('2026-08-04T00:00:00.000Z')

function audit(action: DisplayModeAuditRow['action'], createdAt: string, data: unknown = null): DisplayModeAuditRow {
  return { action, createdAt: new Date(createdAt), data }
}

describe('display-mode rollout report', () => {
  describe('parseDisplayModeRolloutArgs', () => {
    it('uses one captured now for the immediately preceding seven-day default window', () => {
      const now = new Date('2026-08-31T18:30:45.123Z')

      const range = parseDisplayModeRolloutArgs([], now)

      expect(range).toEqual({
        from: new Date('2026-08-24T18:30:45.123Z'),
        to: new Date('2026-08-31T18:30:45.123Z'),
      })
    })

    it('accepts strict ISO instants with an explicit UTC offset', () => {
      expect(parseDisplayModeRolloutArgs(['--from', '2026-08-01T00:00:00.000Z', '--to', '2026-08-08T01:00:00+01:00'], TO)).toEqual({
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-08-08T00:00:00.000Z'),
      })
    })

    it('accepts at most one monthly rollout window and rejects anything larger', () => {
      expect(parseDisplayModeRolloutArgs(['--from', '2026-08-01T00:00:00.000Z', '--to', '2026-09-01T00:00:00.000Z'], TO)).toEqual({
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-09-01T00:00:00.000Z'),
      })
      expect(MAX_REPORT_WINDOW_DAYS).toBe(31)

      expect(() => parseDisplayModeRolloutArgs(['--from', '2026-08-01T00:00:00.000Z', '--to', '2026-09-01T00:00:00.001Z'], TO)).toThrow(
        /31/,
      )
    })

    it.each([
      { argv: ['--from'], reason: 'missing from value' },
      { argv: ['--to', '--from'], reason: 'flag used as to value' },
      { argv: ['--since', '2026-08-01T00:00:00Z'], reason: 'unknown flag' },
      { argv: ['positional'], reason: 'unexpected positional value' },
      { argv: ['--from', '2026-08-01'], reason: 'date without time or offset' },
      { argv: ['--from', 'not-a-date'], reason: 'invalid date' },
      {
        argv: ['--from', '2026-08-02T00:00:00Z', '--to', '2026-08-01T00:00:00Z'],
        reason: 'reversed range',
      },
      {
        argv: ['--from', '2026-08-01T00:00:00Z', '--to', '2026-08-01T00:00:00Z'],
        reason: 'empty range',
      },
      {
        argv: ['--from', '2026-08-01T00:00:00Z', '--from', '2026-08-02T00:00:00Z'],
        reason: 'duplicate flag',
      },
    ])('rejects $reason before reporting', ({ argv }) => {
      expect(() => parseDisplayModeRolloutArgs(argv, TO)).toThrow()
    })
  })

  it('makes empty denominators explicit instead of inventing successful coverage or ACK rates', () => {
    const report = aggregateDisplayModeRollout([], [], { from: FROM, to: TO })

    expect(report.activePosAndroid).toEqual({
      total: 0,
      freshCapabilities: 0,
      protocolV1: 0,
      coveragePercentage: 0,
    })
    expect(report.displayMode.ackRate).toEqual({
      acknowledged: 0,
      requested: 0,
      percentage: null,
      zeroDenominator: true,
    })
    expect(report.displayMode.latencyMs).toEqual({ count: 0, p50: null, p95: null, method: 'nearest-rank' })
    expect(report.legacyUpdates).toEqual({ total: 0, byClientVersion: {}, byUserAgent: {} })
  })

  it('computes the 95% fresh protocol-v1 coverage boundary over all active POS Android devices', () => {
    const terminals: PosAndroidCapabilityRow[] = Array.from({ length: 20 }, (_, index) => ({
      capabilitiesObservedAt: index < 19 ? new Date('2026-08-03T12:00:00.000Z') : null,
      displayModeProtocolVersion: index < 19 ? 1 : null,
    }))

    const report = aggregateDisplayModeRollout(terminals, [], { from: FROM, to: TO })

    expect(report.activePosAndroid).toEqual({
      total: 20,
      freshCapabilities: 19,
      protocolV1: 19,
      coveragePercentage: 95,
    })
  })

  it('groups resolution status/result codes and counts only APPLIED plus REJECTED as terminal ACKs', () => {
    const rows: DisplayModeAuditRow[] = [
      audit('DISPLAY_MODE_REQUESTED', '2026-08-01T01:00:00Z'),
      audit('DISPLAY_MODE_REQUESTED', '2026-08-01T02:00:00Z'),
      audit('DISPLAY_MODE_RESOLVED', '2026-08-01T03:00:00Z', { status: 'APPLIED', latencyMs: 100 }),
      audit('DISPLAY_MODE_RESOLVED', '2026-08-01T04:00:00Z', {
        status: 'REJECTED',
        resultCode: 'DISPLAY_NOT_PRESENT',
        latencyMs: 200,
      }),
      audit('DISPLAY_MODE_RESOLVED', '2026-08-01T05:00:00Z', {
        status: 'CANCELLED',
        resultCode: 'CANCEL_TOO_LATE',
        latencyMs: 300,
      }),
    ]

    const report = aggregateDisplayModeRollout([], rows, { from: FROM, to: TO })

    expect(report.displayMode.requested).toBe(2)
    expect(report.displayMode.resolved).toEqual({
      total: 3,
      byStatus: { APPLIED: 1, CANCELLED: 1, REJECTED: 1 },
      byResultCode: { CANCEL_TOO_LATE: 1, DISPLAY_NOT_PRESENT: 1, NONE: 1 },
    })
    expect(report.displayMode.ackRate).toEqual({
      acknowledged: 2,
      requested: 2,
      percentage: 100,
      zeroDenominator: false,
    })
  })

  it('uses nearest-rank p50/p95 and ignores malformed, negative, and non-finite latency values', () => {
    const valid = Array.from({ length: 20 }, (_, index) =>
      audit('DISPLAY_MODE_RESOLVED', `2026-08-02T00:${String(index).padStart(2, '0')}:00Z`, {
        status: 'APPLIED',
        latencyMs: index + 1,
      }),
    )
    const malformed = [
      audit('DISPLAY_MODE_RESOLVED', '2026-08-02T01:00:00Z', { status: 'REJECTED', latencyMs: -1 }),
      audit('DISPLAY_MODE_RESOLVED', '2026-08-02T01:01:00Z', { status: 'REJECTED', latencyMs: '500' }),
      audit('DISPLAY_MODE_RESOLVED', '2026-08-02T01:02:00Z', { status: 'REJECTED', latencyMs: Number.NaN }),
      audit('DISPLAY_MODE_RESOLVED', '2026-08-02T01:03:00Z', 'not-json-object'),
    ]

    const report = aggregateDisplayModeRollout([], [...valid, ...malformed], { from: FROM, to: TO })

    expect(report.displayMode.latencyMs).toEqual({ count: 20, p50: 10, p95: 19, method: 'nearest-rank' })
  })

  it('groups expirations by every UTC day in the window and calls only a strictly increasing series growing', () => {
    const growingRows = [
      audit('DISPLAY_MODE_EXPIRED', '2026-08-01T23:59:59Z'),
      audit('DISPLAY_MODE_EXPIRED', '2026-08-02T00:00:00Z'),
      audit('DISPLAY_MODE_EXPIRED', '2026-08-02T12:00:00Z'),
      audit('DISPLAY_MODE_EXPIRED', '2026-08-03T01:00:00Z'),
      audit('DISPLAY_MODE_EXPIRED', '2026-08-03T02:00:00Z'),
      audit('DISPLAY_MODE_EXPIRED', '2026-08-03T03:00:00Z'),
    ]

    expect(aggregateDisplayModeRollout([], growingRows, { from: FROM, to: TO }).displayMode.expirations).toEqual({
      total: 6,
      byUtcDay: { '2026-08-01': 1, '2026-08-02': 2, '2026-08-03': 3 },
      trend: 'growing',
      trendDefinition: 'strictly-increasing-each-utc-day',
    })

    const nonIncreasing = [...growingRows, audit('DISPLAY_MODE_EXPIRED', '2026-08-02T20:00:00Z')]
    expect(aggregateDisplayModeRollout([], nonIncreasing, { from: FROM, to: TO }).displayMode.expirations.trend).toBe('not-growing')
  })

  it('collapses malicious audit labels to bounded allowlisted values and never emits raw PII or IDs', () => {
    const secretEmail = 'person@example.com'
    const terminalId = 'terminal-secret-123'
    const venueId = 'venue-secret-456'
    const rawUserAgent = `Private Browser ${secretEmail} ${'x'.repeat(500)}`
    const rows = [
      audit('DISPLAY_MODE_RESOLVED', '2026-08-01T01:00:00Z', {
        status: `<script>${secretEmail}</script>`,
        resultCode: terminalId,
        latencyMs: { arbitrary: 'object' },
        requestId: 'request-secret',
        venueId,
      }),
      audit('LEGACY_DISPLAY_MODE_UPDATE_USED', '2026-08-01T02:00:00Z', {
        appVersion: `dashboard/${secretEmail}`,
        userAgent: rawUserAgent,
        staffName: 'Private Person',
      }),
      audit('LEGACY_DISPLAY_MODE_UPDATE_USED', '2026-08-01T03:00:00Z', {
        appVersion: 'dashboard/2.8.0',
        userAgent: 'Mozilla/5.0 Chrome/120.0 Safari/537.36',
      }),
    ] satisfies DisplayModeAuditRow[]

    const report = aggregateDisplayModeRollout([], rows, { from: FROM, to: TO })
    const serialized = JSON.stringify(report)

    expect(report.displayMode.resolved.byStatus).toEqual({ UNKNOWN: 1 })
    expect(report.displayMode.resolved.byResultCode).toEqual({ UNKNOWN: 1 })
    expect(report.legacyUpdates).toEqual({
      total: 2,
      byClientVersion: { 'dashboard/2.8.0': 1, unknown: 1 },
      byUserAgent: { chrome: 1, unknown: 1 },
    })
    expect(serialized).not.toContain(secretEmail)
    expect(serialized).not.toContain(terminalId)
    expect(serialized).not.toContain(venueId)
    expect(serialized).not.toContain(rawUserAgent)
    expect(serialized).not.toContain('Private Person')
    expect(serialized).not.toContain('request-secret')
  })

  it('is import-safe: loading the module does not construct Prisma, query, or exit', () => {
    jest.resetModules()
    const findMany = jest.fn()
    const disconnect = jest.fn()
    const prismaConstructor = jest.fn(() => ({ terminal: { findMany }, activityLog: { findMany }, $disconnect: disconnect }))
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    jest.isolateModules(() => {
      jest.doMock('@prisma/client', () => ({ PrismaClient: prismaConstructor }))
      require('../../../scripts/report-display-mode-rollout')
    })

    expect(prismaConstructor).not.toHaveBeenCalled()
    expect(findMany).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    exit.mockRestore()
    jest.dontMock('@prisma/client')
  })

  it('queries only bounded selected fields, writes JSON plus a human summary, and disconnects on success', async () => {
    const terminalFindMany = jest.fn().mockResolvedValue([])
    const activityFindMany = jest.fn().mockResolvedValue([])
    const disconnect = jest.fn().mockResolvedValue(undefined)
    const database = { terminal: { findMany: terminalFindMany }, activityLog: { findMany: activityFindMany }, $disconnect: disconnect }
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await executeDisplayModeRolloutCli({
      argv: ['--from', FROM.toISOString(), '--to', TO.toISOString()],
      now: new Date('2026-09-01T00:00:00Z'),
      createDatabase: () => database,
      writeJson: line => stdout.push(line),
      writeSummary: line => stderr.push(line),
    })

    expect(exitCode).toBe(0)
    expect(() => JSON.parse(stdout.join('\n'))).not.toThrow()
    expect(stderr.join('\n')).toContain('ACK')
    expect(terminalFindMany).toHaveBeenCalledWith({
      where: { type: 'POS_ANDROID', status: 'ACTIVE' },
      select: { id: true, capabilitiesObservedAt: true, displayModeProtocolVersion: true },
      orderBy: { id: 'asc' },
      take: REPORT_PAGE_SIZE,
    })
    expect(activityFindMany).toHaveBeenCalledWith({
      where: {
        action: {
          in: ['DISPLAY_MODE_REQUESTED', 'DISPLAY_MODE_RESOLVED', 'DISPLAY_MODE_EXPIRED', 'LEGACY_DISPLAY_MODE_UPDATE_USED'],
        },
        createdAt: { gte: FROM, lt: TO },
      },
      select: { id: true, action: true, createdAt: true, data: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: REPORT_PAGE_SIZE,
    })
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('aggregates every terminal and audit row across stable keyset pages without leaking cursors or malicious data', async () => {
    const terminalFirstPage = Array.from({ length: REPORT_PAGE_SIZE }, (_, index) => ({
      id: `terminal-${String(index).padStart(4, '0')}`,
      capabilitiesObservedAt: new Date('2026-08-03T12:00:00.000Z'),
      displayModeProtocolVersion: 1,
    }))
    const terminalSecondPage = [
      {
        id: `terminal-${String(REPORT_PAGE_SIZE).padStart(4, '0')}`,
        capabilitiesObservedAt: new Date('2026-08-03T12:00:00.000Z'),
        displayModeProtocolVersion: 1,
      },
    ]
    const sharedCreatedAt = new Date('2026-08-02T12:00:00.000Z')
    const auditFirstPage = Array.from({ length: REPORT_PAGE_SIZE }, (_, index) => ({
      id: `audit-${String(index).padStart(4, '0')}`,
      action: 'DISPLAY_MODE_REQUESTED' as const,
      createdAt: sharedCreatedAt,
      data: { requestId: `request-private-${index}` },
    }))
    const secret = 'private-person@example.com'
    const auditSecondPage = [
      {
        id: `audit-${String(REPORT_PAGE_SIZE).padStart(4, '0')}`,
        action: 'DISPLAY_MODE_RESOLVED' as const,
        createdAt: sharedCreatedAt,
        data: { status: 'APPLIED', latencyMs: 123, requestId: 'request-private-last' },
      },
      {
        id: `audit-${String(REPORT_PAGE_SIZE + 1).padStart(4, '0')}`,
        action: 'LEGACY_DISPLAY_MODE_UPDATE_USED' as const,
        createdAt: new Date('2026-08-03T12:00:00.000Z'),
        data: { appVersion: `dashboard/${secret}`, userAgent: `PrivateBrowser/${secret}` },
      },
    ]
    const terminalFindMany = jest.fn().mockResolvedValueOnce(terminalFirstPage).mockResolvedValueOnce(terminalSecondPage)
    const activityFindMany = jest.fn().mockResolvedValueOnce(auditFirstPage).mockResolvedValueOnce(auditSecondPage)
    const disconnect = jest.fn().mockResolvedValue(undefined)
    const stdout: string[] = []

    const exitCode = await executeDisplayModeRolloutCli({
      argv: ['--from', FROM.toISOString(), '--to', TO.toISOString()],
      now: TO,
      createDatabase: () => ({
        terminal: { findMany: terminalFindMany },
        activityLog: { findMany: activityFindMany },
        $disconnect: disconnect,
      }),
      writeJson: line => stdout.push(line),
      writeSummary: jest.fn(),
    })

    expect(exitCode).toBe(0)
    const report = JSON.parse(stdout.join('\n'))
    expect(report.activePosAndroid).toEqual({
      total: REPORT_PAGE_SIZE + 1,
      freshCapabilities: REPORT_PAGE_SIZE + 1,
      protocolV1: REPORT_PAGE_SIZE + 1,
      coveragePercentage: 100,
    })
    expect(report.displayMode.requested).toBe(REPORT_PAGE_SIZE)
    expect(report.displayMode.resolved).toEqual({ total: 1, byStatus: { APPLIED: 1 }, byResultCode: { NONE: 1 } })
    expect(report.displayMode.ackRate).toEqual({
      acknowledged: 1,
      requested: REPORT_PAGE_SIZE,
      percentage: (1 / REPORT_PAGE_SIZE) * 100,
      zeroDenominator: false,
    })
    expect(report.displayMode.latencyMs).toEqual({ count: 1, p50: 123, p95: 123, method: 'nearest-rank' })
    expect(report.legacyUpdates).toEqual({ total: 1, byClientVersion: { unknown: 1 }, byUserAgent: { unknown: 1 } })
    expect(stdout.join('\n')).not.toContain(secret)
    expect(stdout.join('\n')).not.toContain('terminal-')
    expect(stdout.join('\n')).not.toContain('audit-')
    expect(stdout.join('\n')).not.toContain('request-private')

    expect(terminalFindMany).toHaveBeenCalledTimes(2)
    expect(terminalFindMany.mock.calls[1][0]).toEqual({
      where: { type: 'POS_ANDROID', status: 'ACTIVE', id: { gt: `terminal-${String(REPORT_PAGE_SIZE - 1).padStart(4, '0')}` } },
      select: { id: true, capabilitiesObservedAt: true, displayModeProtocolVersion: true },
      orderBy: { id: 'asc' },
      take: REPORT_PAGE_SIZE,
    })
    expect(activityFindMany).toHaveBeenCalledTimes(2)
    expect(activityFindMany.mock.calls[1][0]).toEqual({
      where: {
        action: {
          in: ['DISPLAY_MODE_REQUESTED', 'DISPLAY_MODE_RESOLVED', 'DISPLAY_MODE_EXPIRED', 'LEGACY_DISPLAY_MODE_UPDATE_USED'],
        },
        createdAt: { gte: FROM, lt: TO },
        OR: [
          { createdAt: { gt: sharedCreatedAt } },
          { createdAt: sharedCreatedAt, id: { gt: `audit-${String(REPORT_PAGE_SIZE - 1).padStart(4, '0')}` } },
        ],
      },
      select: { id: true, action: true, createdAt: true, data: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: REPORT_PAGE_SIZE,
    })
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid arguments before constructing Prisma and disconnects after a query failure', async () => {
    const createDatabase = jest.fn()

    await expect(
      executeDisplayModeRolloutCli({
        argv: ['--unknown'],
        now: TO,
        createDatabase,
        writeJson: jest.fn(),
        writeSummary: jest.fn(),
      }),
    ).resolves.toBe(1)
    expect(createDatabase).not.toHaveBeenCalled()

    await expect(
      executeDisplayModeRolloutCli({
        argv: ['--from', '2026-01-01T00:00:00.000Z', '--to', '2026-08-01T00:00:00.000Z'],
        now: TO,
        createDatabase,
        writeJson: jest.fn(),
        writeSummary: jest.fn(),
      }),
    ).resolves.toBe(1)
    expect(createDatabase).not.toHaveBeenCalled()

    const disconnect = jest.fn().mockResolvedValue(undefined)
    const database = {
      terminal: { findMany: jest.fn().mockRejectedValue(new Error('database unavailable')) },
      activityLog: { findMany: jest.fn() },
      $disconnect: disconnect,
    }

    await expect(
      executeDisplayModeRolloutCli({
        argv: ['--from', FROM.toISOString(), '--to', TO.toISOString()],
        now: TO,
        createDatabase: () => database,
        writeJson: jest.fn(),
        writeSummary: jest.fn(),
      }),
    ).resolves.toBe(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
