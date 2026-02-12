import { monitorEventLoopDelay, IntervalHistogram } from 'perf_hooks'
import logger from '../../config/logger'

// --- Types ---

export interface MetricsSnapshot {
  timestamp: string
  uptime: number
  memory: {
    rss: number
    rssMb: number
    heapUsed: number
    heapTotal: number
    heapUsedMb: number
    external: number
    arrayBuffers: number
    rssPercent: number
    limitMb: number
  }
  cpu: {
    percent: number
    limitCores: number
  }
  eventLoop: {
    lagMs: number
    lagP99Ms: number
    lagMaxMs: number
  }
  connections: {
    active: number
  }
}

export interface Alert {
  type: 'memory' | 'eventLoop' | 'cpu'
  severity: 'warning' | 'critical'
  message: string
  value: number
  threshold: number
  timestamp: string
}

// --- Constants ---

const MAX_HISTORY_SIZE = 240 // 2 hours at 30s intervals
const COLLECTION_INTERVAL_MS = 30_000

// Alert thresholds (container-meaningful only)
const ALERT_MEMORY_PCT = 80 // RSS vs MEMORY_LIMIT_MB
const ALERT_EVENT_LOOP_MS = 100
const ALERT_CPU_PCT = 80 // CPU % relative to container limit

// --- State ---

const history: MetricsSnapshot[] = []
let collectionInterval: NodeJS.Timeout | null = null
let histogram: IntervalHistogram | null = null

// These will be set by startMetricsCollection to read from app.ts monitoring
let getCpuPercent: () => number = () => 0
let getActiveConnections: () => number = () => 0
let getEventLoopHisto: () => IntervalHistogram | null = () => histogram

// --- Helpers ---

function collectSnapshot(): MetricsSnapshot {
  const mem = process.memoryUsage()
  const MEMORY_LIMIT_MB = parseInt(process.env.MEMORY_LIMIT_MB || '512', 10)
  const CPU_LIMIT = parseFloat(process.env.CPU_LIMIT || '0.5')

  const histo = getEventLoopHisto()

  return {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      rss: mem.rss,
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      rssPercent: parseFloat(((mem.rss / (MEMORY_LIMIT_MB * 1024 * 1024)) * 100).toFixed(1)),
      limitMb: MEMORY_LIMIT_MB,
    },
    cpu: {
      percent: parseFloat(getCpuPercent().toFixed(1)),
      limitCores: CPU_LIMIT,
    },
    eventLoop: {
      lagMs: histo ? parseFloat((histo.mean / 1e6).toFixed(2)) : 0,
      lagP99Ms: histo ? parseFloat((histo.percentile(99) / 1e6).toFixed(2)) : 0,
      lagMaxMs: histo ? parseFloat((histo.max / 1e6).toFixed(2)) : 0,
    },
    connections: {
      active: getActiveConnections(),
    },
  }
}

function evaluateAlerts(snapshot: MetricsSnapshot): Alert[] {
  const alerts: Alert[] = []
  const now = snapshot.timestamp

  // Memory alert (RSS vs container limit — the only memory metric that matters)
  if (snapshot.memory.rssPercent >= ALERT_MEMORY_PCT) {
    alerts.push({
      type: 'memory',
      severity: snapshot.memory.rssPercent >= 95 ? 'critical' : 'warning',
      message: `RSS ${snapshot.memory.rssMb}MB = ${snapshot.memory.rssPercent}% del límite de ${snapshot.memory.limitMb}MB`,
      value: snapshot.memory.rssPercent,
      threshold: ALERT_MEMORY_PCT,
      timestamp: now,
    })
  }

  // NO heap alert: heapUsed/heapTotal is V8 internal bookkeeping.
  // heapTotal grows dynamically; 97% usage is normal V8 behavior, not a problem.

  // Event loop lag alert
  if (snapshot.eventLoop.lagMs >= ALERT_EVENT_LOOP_MS) {
    alerts.push({
      type: 'eventLoop',
      severity: snapshot.eventLoop.lagMs >= 500 ? 'critical' : 'warning',
      message: `Event loop lag ${snapshot.eventLoop.lagMs.toFixed(1)}ms (p99: ${snapshot.eventLoop.lagP99Ms}ms)`,
      value: snapshot.eventLoop.lagMs,
      threshold: ALERT_EVENT_LOOP_MS,
      timestamp: now,
    })
  }

  // CPU alert (relative to container limit, NOT host cores)
  if (snapshot.cpu.percent >= ALERT_CPU_PCT) {
    alerts.push({
      type: 'cpu',
      severity: snapshot.cpu.percent >= 95 ? 'critical' : 'warning',
      message: `CPU ${snapshot.cpu.percent.toFixed(1)}% del límite de ${snapshot.cpu.limitCores} cores`,
      value: snapshot.cpu.percent,
      threshold: ALERT_CPU_PCT,
      timestamp: now,
    })
  }

  return alerts
}

// --- Public API ---

export function getCurrentMetrics(): MetricsSnapshot {
  return collectSnapshot()
}

export function getMetricsHistory(): MetricsSnapshot[] {
  return [...history]
}

export function getActiveAlerts(): Alert[] {
  const current = collectSnapshot()
  return evaluateAlerts(current)
}

/**
 * Start periodic metrics collection. Call once at server startup.
 * Receives getter functions from app.ts to read the live CPU/connection/histogram values.
 */
export function startMetricsCollection(options?: {
  cpuPercentFn?: () => number
  activeConnectionsFn?: () => number
  eventLoopHistogramFn?: () => IntervalHistogram | null
}): void {
  if (collectionInterval) return // Already started

  // Wire up getters from app.ts monitoring
  if (options?.cpuPercentFn) getCpuPercent = options.cpuPercentFn
  if (options?.activeConnectionsFn) getActiveConnections = options.activeConnectionsFn
  if (options?.eventLoopHistogramFn) getEventLoopHisto = options.eventLoopHistogramFn

  // Fallback: initialize own histogram if not provided from app.ts
  if (!options?.eventLoopHistogramFn) {
    try {
      histogram = monitorEventLoopDelay({ resolution: 20 })
      histogram.enable()
      getEventLoopHisto = () => histogram
    } catch (err) {
      logger.warn('Could not initialize event loop monitoring:', err)
    }
  }

  // Collect initial snapshot
  const initial = collectSnapshot()
  history.push(initial)

  // Set up periodic collection
  collectionInterval = setInterval(() => {
    const snapshot = collectSnapshot()
    history.push(snapshot)

    // Trim to max size
    while (history.length > MAX_HISTORY_SIZE) {
      history.shift()
    }
  }, COLLECTION_INTERVAL_MS)

  // Don't prevent Node from exiting
  collectionInterval.unref()

  logger.info('Server metrics collection started (30s intervals, 2h buffer)')
}

/**
 * Stop metrics collection. Called during graceful shutdown.
 */
export function stopMetricsCollection(): void {
  if (collectionInterval) {
    clearInterval(collectionInterval)
    collectionInterval = null
  }
  if (histogram) {
    histogram.disable()
    histogram = null
  }
}
