/**
 * Read-only rollout report for the durable customer-display protocol.
 *
 * JSON is written to stdout so automation can parse it. The concise human
 * summary is written to stderr. Expiration trend is "growing" only when every
 * UTC day in the requested window is strictly greater than its predecessor.
 * Latency percentiles use the nearest-rank method: ceil(p * n), one-indexed.
 * The rollout defaults to seven days and accepts at most 31 days: enough for
 * one monthly investigation without allowing accidental unbounded scans.
 * Database reads use stable keyset pages and never skip or truncate rows.
 */

import { PrismaClient } from '@prisma/client'

const DAY_MS = 24 * 60 * 60 * 1000
export const MAX_REPORT_WINDOW_DAYS = 31
export const REPORT_PAGE_SIZE = 500

export const DISPLAY_MODE_ROLLOUT_ACTIONS = [
  'DISPLAY_MODE_REQUESTED',
  'DISPLAY_MODE_RESOLVED',
  'DISPLAY_MODE_EXPIRED',
  'LEGACY_DISPLAY_MODE_UPDATE_USED',
] as const

export type DisplayModeRolloutAction = (typeof DISPLAY_MODE_ROLLOUT_ACTIONS)[number]

export interface DisplayModeRolloutRange {
  from: Date
  to: Date
}

export interface PosAndroidCapabilityRow {
  capabilitiesObservedAt: Date | null
  displayModeProtocolVersion: number | null
}

export interface DisplayModeAuditRow {
  action: DisplayModeRolloutAction
  createdAt: Date
  data: unknown
}

interface PaginatedPosAndroidCapabilityRow extends PosAndroidCapabilityRow {
  id: string
}

interface PaginatedDisplayModeAuditRow extends DisplayModeAuditRow {
  id: string
}

type CountMap = Record<string, number>

export interface DisplayModeRolloutReport {
  window: { from: string; to: string }
  activePosAndroid: {
    total: number
    freshCapabilities: number
    protocolV1: number
    coveragePercentage: number
  }
  displayMode: {
    requested: number
    resolved: { total: number; byStatus: CountMap; byResultCode: CountMap }
    ackRate: {
      acknowledged: number
      requested: number
      percentage: number | null
      zeroDenominator: boolean
    }
    latencyMs: { count: number; p50: number | null; p95: number | null; method: 'nearest-rank' }
    expirations: {
      total: number
      byUtcDay: CountMap
      trend: 'growing' | 'not-growing'
      trendDefinition: 'strictly-increasing-each-utc-day'
    }
  }
  legacyUpdates: { total: number; byClientVersion: CountMap; byUserAgent: CountMap }
}

interface FindMany<T> {
  findMany(args: unknown): Promise<T[]>
}

export interface DisplayModeRolloutDatabase {
  terminal: FindMany<PaginatedPosAndroidCapabilityRow>
  activityLog: FindMany<PaginatedDisplayModeAuditRow>
  $disconnect(): Promise<void>
}

export interface ExecuteDisplayModeRolloutCliOptions {
  argv?: string[]
  now?: Date
  createDatabase?: () => DisplayModeRolloutDatabase
  writeJson?: (line: string) => void
  writeSummary?: (line: string) => void
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/

function parseStrictIsoInstant(value: string, flag: '--from' | '--to'): Date {
  const match = ISO_INSTANT.exec(value)
  if (!match) throw new Error(`${flag} debe ser un instante ISO con zona horaria explícita`)

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const validOffset = zone === 'Z' || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59)

  if (month < 1 || month > 12 || day < 1 || day > maxDay || hour > 23 || minute > 59 || second > 59 || !validOffset) {
    throw new Error(`${flag} no contiene una fecha ISO válida`)
  }

  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${flag} no contiene una fecha ISO válida`)
  return parsed
}

export function parseDisplayModeRolloutArgs(argv: string[], now: Date): DisplayModeRolloutRange {
  const capturedNow = new Date(now.getTime())
  if (!Number.isFinite(capturedNow.getTime())) throw new Error('now debe ser una fecha válida')

  let from: Date | undefined
  let to: Date | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag !== '--from' && flag !== '--to') throw new Error(`Argumento no reconocido: ${flag}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Falta el valor de ${flag}`)
    if ((flag === '--from' && from) || (flag === '--to' && to)) throw new Error(`Argumento duplicado: ${flag}`)

    const parsed = parseStrictIsoInstant(value, flag)
    if (flag === '--from') from = parsed
    else to = parsed
    index += 1
  }

  const resolvedTo = to ?? capturedNow
  const resolvedFrom = from ?? new Date(resolvedTo.getTime() - 7 * DAY_MS)
  if (resolvedFrom.getTime() >= resolvedTo.getTime()) throw new Error('--from debe ser anterior a --to')
  if (resolvedTo.getTime() - resolvedFrom.getTime() > MAX_REPORT_WINDOW_DAYS * DAY_MS) {
    throw new Error(`El reporte admite como máximo ${MAX_REPORT_WINDOW_DAYS} días`)
  }
  return { from: resolvedFrom, to: resolvedTo }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function increment(counts: CountMap, label: string): void {
  counts[label] = (counts[label] ?? 0) + 1
}

function sortedCounts(counts: CountMap): CountMap {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

const RESOLUTION_STATUSES = new Set(['PENDING', 'APPLIED', 'REJECTED', 'SUPERSEDED', 'CANCELLED', 'EXPIRED'])
const RESULT_CODES = new Set([
  'DISPLAY_NOT_PRESENT',
  'DISPLAY_NOT_INVERTIBLE',
  'APPLY_FAILED',
  'LOCAL_OVERRIDE',
  'CANCEL_TOO_LATE',
  'ACK_AFTER_EXPIRY',
  'DEVICE_RETIRED',
])

function boundedResolutionStatus(data: unknown): string {
  if (!isPlainObject(data) || typeof data.status !== 'string' || !RESOLUTION_STATUSES.has(data.status)) return 'UNKNOWN'
  return data.status
}

function boundedResultCode(data: unknown): string {
  if (!isPlainObject(data) || data.resultCode === undefined) return 'NONE'
  if (typeof data.resultCode !== 'string' || !RESULT_CODES.has(data.resultCode)) return 'UNKNOWN'
  return data.resultCode
}

function validLatency(data: unknown): number | null {
  if (!isPlainObject(data) || typeof data.latencyMs !== 'number') return null
  return Number.isFinite(data.latencyMs) && data.latencyMs >= 0 ? data.latencyMs : null
}

function nearestRankFromCounts(counts: Map<number, number>, total: number, percentile: number): number | null {
  if (total === 0) return null
  const targetRank = Math.ceil(percentile * total)
  let cumulative = 0
  for (const [value, count] of [...counts.entries()].sort(([left], [right]) => left - right)) {
    cumulative += count
    if (cumulative >= targetRank) return value
  }
  return null
}

function boundedClientVersion(data: unknown): string {
  if (!isPlainObject(data) || typeof data.appVersion !== 'string') return 'unknown'
  return /^dashboard\/\d{1,3}(?:\.\d{1,3}){1,3}$/.test(data.appVersion) ? data.appVersion : 'unknown'
}

function boundedUserAgent(data: unknown): string {
  if (!isPlainObject(data) || typeof data.userAgent !== 'string') return 'unknown'
  const userAgent = data.userAgent.toLowerCase()
  if (userAgent.includes('avoqado dashboard')) return 'avoqado-dashboard'
  if (userAgent.includes('edg/')) return 'edge'
  if (userAgent.includes('firefox/')) return 'firefox'
  if (userAgent.includes('chrome/')) return 'chrome'
  if (userAgent.includes('safari/')) return 'safari'
  return 'unknown'
}

function utcDayKeys(range: DisplayModeRolloutRange): string[] {
  const firstDay = Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate())
  const keys: string[] = []
  for (let cursor = firstDay; cursor < range.to.getTime(); cursor += DAY_MS) {
    keys.push(new Date(cursor).toISOString().slice(0, 10))
  }
  return keys
}

function inRange(date: Date, range: DisplayModeRolloutRange): boolean {
  const timestamp = date.getTime()
  return Number.isFinite(timestamp) && timestamp >= range.from.getTime() && timestamp < range.to.getTime()
}

interface RolloutAccumulator {
  range: DisplayModeRolloutRange
  terminalTotal: number
  freshTerminals: number
  protocolV1: number
  requested: number
  resolved: number
  acknowledged: number
  expirations: number
  legacyUpdates: number
  byStatus: CountMap
  byResultCode: CountMap
  latencyCounts: Map<number, number>
  latencyTotal: number
  expiryDays: CountMap
  byClientVersion: CountMap
  byUserAgent: CountMap
}

function createRolloutAccumulator(range: DisplayModeRolloutRange): RolloutAccumulator {
  return {
    range,
    terminalTotal: 0,
    freshTerminals: 0,
    protocolV1: 0,
    requested: 0,
    resolved: 0,
    acknowledged: 0,
    expirations: 0,
    legacyUpdates: 0,
    byStatus: {},
    byResultCode: {},
    latencyCounts: new Map(),
    latencyTotal: 0,
    expiryDays: Object.fromEntries(utcDayKeys(range).map(day => [day, 0])),
    byClientVersion: {},
    byUserAgent: {},
  }
}

function consumeTerminalRows(accumulator: RolloutAccumulator, terminals: PosAndroidCapabilityRow[]): void {
  for (const terminal of terminals) {
    accumulator.terminalTotal += 1
    const fresh = terminal.capabilitiesObservedAt !== null && inRange(terminal.capabilitiesObservedAt, accumulator.range)
    if (!fresh) continue
    accumulator.freshTerminals += 1
    if (terminal.displayModeProtocolVersion === 1) accumulator.protocolV1 += 1
  }
}

function consumeAuditRows(accumulator: RolloutAccumulator, auditRows: DisplayModeAuditRow[]): void {
  for (const row of auditRows) {
    if (!inRange(row.createdAt, accumulator.range)) continue

    if (row.action === 'DISPLAY_MODE_REQUESTED') {
      accumulator.requested += 1
    } else if (row.action === 'DISPLAY_MODE_RESOLVED') {
      accumulator.resolved += 1
      const status = boundedResolutionStatus(row.data)
      increment(accumulator.byStatus, status)
      increment(accumulator.byResultCode, boundedResultCode(row.data))
      if (status === 'APPLIED' || status === 'REJECTED') accumulator.acknowledged += 1
      const latency = validLatency(row.data)
      if (latency !== null) {
        accumulator.latencyCounts.set(latency, (accumulator.latencyCounts.get(latency) ?? 0) + 1)
        accumulator.latencyTotal += 1
      }
    } else if (row.action === 'DISPLAY_MODE_EXPIRED') {
      accumulator.expirations += 1
      increment(accumulator.expiryDays, row.createdAt.toISOString().slice(0, 10))
    } else if (row.action === 'LEGACY_DISPLAY_MODE_UPDATE_USED') {
      accumulator.legacyUpdates += 1
      increment(accumulator.byClientVersion, boundedClientVersion(row.data))
      increment(accumulator.byUserAgent, boundedUserAgent(row.data))
    }
  }
}

function finalizeRolloutAccumulator(accumulator: RolloutAccumulator): DisplayModeRolloutReport {
  const coveragePercentage = accumulator.terminalTotal === 0 ? 0 : (accumulator.protocolV1 / accumulator.terminalTotal) * 100
  const expirySeries = Object.values(accumulator.expiryDays)
  const growing = expirySeries.length >= 2 && expirySeries.slice(1).every((count, index) => count > expirySeries[index])

  return {
    window: { from: accumulator.range.from.toISOString(), to: accumulator.range.to.toISOString() },
    activePosAndroid: {
      total: accumulator.terminalTotal,
      freshCapabilities: accumulator.freshTerminals,
      protocolV1: accumulator.protocolV1,
      coveragePercentage,
    },
    displayMode: {
      requested: accumulator.requested,
      resolved: {
        total: accumulator.resolved,
        byStatus: sortedCounts(accumulator.byStatus),
        byResultCode: sortedCounts(accumulator.byResultCode),
      },
      ackRate: {
        acknowledged: accumulator.acknowledged,
        requested: accumulator.requested,
        percentage: accumulator.requested === 0 ? null : (accumulator.acknowledged / accumulator.requested) * 100,
        zeroDenominator: accumulator.requested === 0,
      },
      latencyMs: {
        count: accumulator.latencyTotal,
        p50: nearestRankFromCounts(accumulator.latencyCounts, accumulator.latencyTotal, 0.5),
        p95: nearestRankFromCounts(accumulator.latencyCounts, accumulator.latencyTotal, 0.95),
        method: 'nearest-rank',
      },
      expirations: {
        total: accumulator.expirations,
        byUtcDay: accumulator.expiryDays,
        trend: growing ? 'growing' : 'not-growing',
        trendDefinition: 'strictly-increasing-each-utc-day',
      },
    },
    legacyUpdates: {
      total: accumulator.legacyUpdates,
      byClientVersion: sortedCounts(accumulator.byClientVersion),
      byUserAgent: sortedCounts(accumulator.byUserAgent),
    },
  }
}

export function aggregateDisplayModeRollout(
  terminals: PosAndroidCapabilityRow[],
  auditRows: DisplayModeAuditRow[],
  range: DisplayModeRolloutRange,
): DisplayModeRolloutReport {
  const accumulator = createRolloutAccumulator(range)
  consumeTerminalRows(accumulator, terminals)
  consumeAuditRows(accumulator, auditRows)
  return finalizeRolloutAccumulator(accumulator)
}

export function formatDisplayModeRolloutSummary(report: DisplayModeRolloutReport): string {
  const ack = report.displayMode.ackRate.percentage === null ? 'sin solicitudes' : `${report.displayMode.ackRate.percentage}%`
  return [
    `POS Android activos=${report.activePosAndroid.total}`,
    `cobertura protocolo v1=${report.activePosAndroid.coveragePercentage}%`,
    `ACK=${ack}`,
    `latencia p95=${report.displayMode.latencyMs.p95 ?? 'sin datos'}ms`,
    `expiraciones=${report.displayMode.expirations.total} (${report.displayMode.expirations.trend})`,
    `legacy=${report.legacyUpdates.total}`,
  ].join(' | ')
}

async function queryDisplayModeRollout(
  database: DisplayModeRolloutDatabase,
  range: DisplayModeRolloutRange,
): Promise<DisplayModeRolloutReport> {
  const accumulator = createRolloutAccumulator(range)
  let terminalCursor: string | null = null

  while (true) {
    const terminalPage = await database.terminal.findMany({
      where: {
        type: 'POS_ANDROID',
        status: 'ACTIVE',
        ...(terminalCursor ? { id: { gt: terminalCursor } } : {}),
      },
      select: { id: true, capabilitiesObservedAt: true, displayModeProtocolVersion: true },
      orderBy: { id: 'asc' },
      take: REPORT_PAGE_SIZE,
    })
    consumeTerminalRows(accumulator, terminalPage)
    if (terminalPage.length < REPORT_PAGE_SIZE) break

    const nextCursor = terminalPage[terminalPage.length - 1]?.id
    if (!nextCursor || (terminalCursor !== null && nextCursor <= terminalCursor)) {
      throw new Error('La paginación de terminales no avanzó')
    }
    terminalCursor = nextCursor
  }

  let auditCursor: { createdAt: Date; id: string } | null = null
  while (true) {
    const auditPage = await database.activityLog.findMany({
      where: {
        action: { in: [...DISPLAY_MODE_ROLLOUT_ACTIONS] },
        createdAt: { gte: range.from, lt: range.to },
        ...(auditCursor
          ? {
              OR: [{ createdAt: { gt: auditCursor.createdAt } }, { createdAt: auditCursor.createdAt, id: { gt: auditCursor.id } }],
            }
          : {}),
      },
      select: { id: true, action: true, createdAt: true, data: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: REPORT_PAGE_SIZE,
    })
    consumeAuditRows(accumulator, auditPage)
    if (auditPage.length < REPORT_PAGE_SIZE) break

    const lastRow = auditPage[auditPage.length - 1]
    const cursorAdvanced =
      lastRow &&
      (!auditCursor ||
        lastRow.createdAt.getTime() > auditCursor.createdAt.getTime() ||
        (lastRow.createdAt.getTime() === auditCursor.createdAt.getTime() && lastRow.id > auditCursor.id))
    if (!lastRow || !cursorAdvanced) throw new Error('La paginación de actividad no avanzó')
    auditCursor = { createdAt: lastRow.createdAt, id: lastRow.id }
  }

  return finalizeRolloutAccumulator(accumulator)
}

export async function executeDisplayModeRolloutCli(options: ExecuteDisplayModeRolloutCliOptions = {}): Promise<0 | 1> {
  const argv = options.argv ?? process.argv.slice(2)
  const now = options.now ?? new Date()
  const createDatabase = options.createDatabase ?? (() => new PrismaClient() as DisplayModeRolloutDatabase)
  const writeJson = options.writeJson ?? console.log
  const writeSummary = options.writeSummary ?? console.error
  let database: DisplayModeRolloutDatabase | null = null
  let failed = false

  try {
    const range = parseDisplayModeRolloutArgs(argv, now)
    database = createDatabase()
    const report = await queryDisplayModeRollout(database, range)
    writeJson(JSON.stringify(report))
    writeSummary(formatDisplayModeRolloutSummary(report))
  } catch {
    failed = true
    writeSummary('No se pudo generar el reporte read-only; no se realizó ninguna escritura.')
  } finally {
    if (database) {
      try {
        await database.$disconnect()
      } catch {
        failed = true
        writeSummary('No se pudo cerrar la conexión del reporte read-only.')
      }
    }
  }

  return failed ? 1 : 0
}

if (require.main === module) {
  void executeDisplayModeRolloutCli().then(exitCode => {
    process.exitCode = exitCode
  })
}
