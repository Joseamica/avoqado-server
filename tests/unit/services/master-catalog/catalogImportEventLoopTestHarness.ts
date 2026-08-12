import { EVENT_LOOP_BUDGET_MS } from '@/services/master-catalog/catalogImportCanonical.service'

export interface CatalogImportEventLoopProbeV1 {
  stop(): readonly number[]
}

type CatalogImportThreadCpuUsageV1 = (previousValue?: NodeJS.CpuUsage) => NodeJS.CpuUsage

const runtimeProcess = process as NodeJS.Process & { threadCpuUsage?: CatalogImportThreadCpuUsageV1 }
const threadCpuUsage = runtimeProcess.threadCpuUsage?.bind(process)

// WHY: process.threadCpuUsage() landed in Node 22, but this service builds and
// runs on node:20-alpine (Dockerfile) and CI pins Node 20 to match production.
// Throwing there turned a runtime gap into six red suites on every push, while
// the same tests passed on a developer machine running a newer Node. The probe
// now reports its own support instead: the workload under test still executes,
// and only the CPU-timing assertion steps aside — with a warning, never in
// silence. Deleting this flag is only correct once production itself is on a
// Node that exposes the API.
export const CATALOG_IMPORT_EVENT_LOOP_PROBE_SUPPORTED_V1 = typeof threadCpuUsage === 'function'

// For a test whose subject IS the measurement — a negative control that burns
// CPU and asserts the probe catches it. Degrading that one would assert nothing,
// so it is skipped outright and Jest reports it as skipped rather than passed.
export const itWhenEventLoopProbeSupportedV1 = CATALOG_IMPORT_EVENT_LOOP_PROBE_SUPPORTED_V1 ? it : it.skip

export function readCatalogImportThreadCpuUsageV1(previousValue?: NodeJS.CpuUsage): NodeJS.CpuUsage {
  if (!threadCpuUsage) throw new Error('This event-loop probe requires process.threadCpuUsage().')
  return threadCpuUsage(previousValue)
}

// WHY: Wall-clock-only probes mistake process descheduling for JavaScript
// monopolization. Main-thread CPU time still catches synchronous work without
// charging V8/background threads, while the minimum of wall and thread-CPU
// deltas ignores time in which this Jest thread did not run. stop() records
// the final work slice before clearing the probe.
export function startCatalogImportEventLoopProbeV1(): CatalogImportEventLoopProbeV1 {
  // No samples means "not measured", which expectCatalogImportEventLoopBudgetV1
  // reports out loud. It never means "measured and within budget".
  if (!CATALOG_IMPORT_EVENT_LOOP_PROBE_SUPPORTED_V1) return { stop: () => [] }

  const samples: number[] = []
  let previousWall = performance.now()
  let previousCpu = readCatalogImportThreadCpuUsageV1()
  let stopped = false

  const sample = () => {
    const currentWall = performance.now()
    const currentCpu = readCatalogImportThreadCpuUsageV1()
    const wallDelta = currentWall - previousWall
    const cpuDelta = (currentCpu.user - previousCpu.user + (currentCpu.system - previousCpu.system)) / 1_000
    samples.push(Math.min(wallDelta, cpuDelta))
    previousWall = currentWall
    previousCpu = currentCpu
  }

  const timer = setInterval(sample, 1)
  return {
    stop() {
      if (!stopped) {
        clearInterval(timer)
        sample()
        stopped = true
      }
      return samples
    },
  }
}

export function expectCatalogImportEventLoopBudgetV1(samples: readonly number[]): void {
  // The frozen budget is asserted on every runtime: it is a contract with the
  // production code, not a measurement, so it must hold even where the probe
  // cannot run.
  expect(EVENT_LOOP_BUDGET_MS).toBe(50)

  if (!CATALOG_IMPORT_EVENT_LOOP_PROBE_SUPPORTED_V1) {
    console.warn(
      `[catalog-import] Event-loop budget NOT measured on Node ${process.version}: ` +
        'process.threadCpuUsage() requires Node 22+. The workload ran, the timing assertion did not.',
    )
    return
  }

  expect(samples.length).toBeGreaterThan(2)
  expect(Math.max(...samples)).toBeLessThan(EVENT_LOOP_BUDGET_MS)
}
