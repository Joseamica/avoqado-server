import os from 'os'
import { monitorEventLoopDelay, IntervalHistogram } from 'perf_hooks'
import logger from '../../config/logger'

// --- Types ---

export interface MetricsSnapshot {
  timestamp: string
  uptime: number
  memory: {
    rss: number
    heapTotal: number
    heapUsed: number
    external: number
    arrayBuffers: number
  }
  cpu: {
    user: number
    system: number
    percentEstimate: number
  }
  os: {
    loadAvg: number[]
    totalMemory: number
    freeMemory: number
    cpus: number
  }
  eventLoop: {
    lagMs: number
  }
  requests: {
    activeConnections: number
  }
  limits: {
    memoryLimitMb: number
    cpuLimit: number
  }
}

export interface Alert {
  type: 'memory' | 'heap' | 'eventLoop' | 'cpu'
  severity: 'warning' | 'critical'
  message: string
  value: number
  threshold: number
  timestamp: string
}

// --- Constants ---

const MAX_HISTORY_SIZE = 240 // 2 hours at 30s intervals
const COLLECTION_INTERVAL_MS = 30_000

// Alert thresholds
const ALERT_MEMORY_PCT = 80
const ALERT_HEAP_PCT = 85
const ALERT_EVENT_LOOP_MS = 100
const ALERT_CPU_PCT = 90

// --- State ---

const history: MetricsSnapshot[] = []
let collectionInterval: NodeJS.Timeout | null = null
let connectionInterval: NodeJS.Timeout | null = null
let histogram: IntervalHistogram | null = null
let previousCpuUsage: NodeJS.CpuUsage | null = null
let previousCpuTime: number = 0
let activeConnectionCount = 0

// --- Helpers ---

function getEventLoopLagMs(): number {
  if (!histogram) return 0
  // mean is in nanoseconds
  return histogram.mean / 1e6
}

function getCpuPercentEstimate(): number {
  const currentUsage = process.cpuUsage()
  const currentTime = Date.now()

  if (!previousCpuUsage || previousCpuTime === 0) {
    previousCpuUsage = currentUsage
    previousCpuTime = currentTime
    return 0
  }

  const elapsedMs = currentTime - previousCpuTime
  if (elapsedMs === 0) return 0

  const userDiff = currentUsage.user - previousCpuUsage.user
  const systemDiff = currentUsage.system - previousCpuUsage.system

  // cpuUsage is in microseconds, elapsedMs in milliseconds
  // (userDiff + systemDiff) microseconds / (elapsedMs * 1000) microseconds * 100 = percentage
  const cpuPercent = ((userDiff + systemDiff) / (elapsedMs * 1000)) * 100

  previousCpuUsage = currentUsage
  previousCpuTime = currentTime

  return Math.min(Math.round(cpuPercent * 100) / 100, 100)
}

function collectSnapshot(): MetricsSnapshot {
  const mem = process.memoryUsage()
  const cpuUsage = process.cpuUsage()
  const memoryLimitMb = parseInt(process.env.MEMORY_LIMIT_MB || '512', 10)
  const cpuLimit = parseFloat(process.env.CPU_LIMIT || '0.5')

  return {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    },
    cpu: {
      user: cpuUsage.user,
      system: cpuUsage.system,
      percentEstimate: getCpuPercentEstimate(),
    },
    os: {
      loadAvg: os.loadavg(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cpus: os.cpus().length,
    },
    eventLoop: {
      lagMs: Math.round(getEventLoopLagMs() * 100) / 100,
    },
    requests: {
      activeConnections: activeConnectionCount,
    },
    limits: {
      memoryLimitMb,
      cpuLimit,
    },
  }
}

function evaluateAlerts(snapshot: MetricsSnapshot): Alert[] {
  const alerts: Alert[] = []
  const now = snapshot.timestamp

  // Memory alert (RSS vs limit)
  const memoryUsedMb = snapshot.memory.rss / (1024 * 1024)
  const memoryPct = (memoryUsedMb / snapshot.limits.memoryLimitMb) * 100
  if (memoryPct >= ALERT_MEMORY_PCT) {
    alerts.push({
      type: 'memory',
      severity: memoryPct >= 95 ? 'critical' : 'warning',
      message: `RSS memory at ${memoryPct.toFixed(1)}% of ${snapshot.limits.memoryLimitMb}MB limit`,
      value: memoryPct,
      threshold: ALERT_MEMORY_PCT,
      timestamp: now,
    })
  }

  // Heap alert
  const heapPct = (snapshot.memory.heapUsed / snapshot.memory.heapTotal) * 100
  if (heapPct >= ALERT_HEAP_PCT) {
    alerts.push({
      type: 'heap',
      severity: heapPct >= 95 ? 'critical' : 'warning',
      message: `Heap usage at ${heapPct.toFixed(1)}% (${(snapshot.memory.heapUsed / 1024 / 1024).toFixed(0)}MB / ${(snapshot.memory.heapTotal / 1024 / 1024).toFixed(0)}MB)`,
      value: heapPct,
      threshold: ALERT_HEAP_PCT,
      timestamp: now,
    })
  }

  // Event loop lag alert
  if (snapshot.eventLoop.lagMs >= ALERT_EVENT_LOOP_MS) {
    alerts.push({
      type: 'eventLoop',
      severity: snapshot.eventLoop.lagMs >= 500 ? 'critical' : 'warning',
      message: `Event loop lag at ${snapshot.eventLoop.lagMs.toFixed(1)}ms`,
      value: snapshot.eventLoop.lagMs,
      threshold: ALERT_EVENT_LOOP_MS,
      timestamp: now,
    })
  }

  // CPU alert
  if (snapshot.cpu.percentEstimate >= ALERT_CPU_PCT) {
    alerts.push({
      type: 'cpu',
      severity: snapshot.cpu.percentEstimate >= 95 ? 'critical' : 'warning',
      message: `CPU usage at ${snapshot.cpu.percentEstimate.toFixed(1)}%`,
      value: snapshot.cpu.percentEstimate,
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
 * Update active connection count. Called from middleware or server.
 */
export function setActiveConnectionCount(count: number): void {
  activeConnectionCount = count
}

/**
 * Start periodic metrics collection. Call once at server startup.
 */
export function startMetricsCollection(httpServer?: import('http').Server): void {
  if (collectionInterval) return // Already started

  // Initialize event loop monitoring
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()
  } catch (err) {
    logger.warn('Could not initialize event loop monitoring:', err)
  }

  // Initialize CPU baseline
  previousCpuUsage = process.cpuUsage()
  previousCpuTime = Date.now()

  // Keep connection count updated (runs on a faster cycle)
  if (httpServer) {
    const updateConnections = () => {
      httpServer.getConnections((err, count) => {
        if (!err) activeConnectionCount = count
      })
    }
    updateConnections()
    connectionInterval = setInterval(updateConnections, 5_000)
    connectionInterval.unref()
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
  if (connectionInterval) {
    clearInterval(connectionInterval)
    connectionInterval = null
  }
  if (histogram) {
    histogram.disable()
    histogram = null
  }
}
