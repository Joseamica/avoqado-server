import { EVENT_LOOP_BUDGET_MS } from '@/services/master-catalog/catalogImportCanonical.service'

export interface CatalogImportEventLoopProbeV1 {
  stop(): readonly number[]
}

type CatalogImportThreadCpuUsageV1 = (previousValue?: NodeJS.CpuUsage) => NodeJS.CpuUsage

const runtimeProcess = process as NodeJS.Process & { threadCpuUsage?: CatalogImportThreadCpuUsageV1 }
const threadCpuUsage = runtimeProcess.threadCpuUsage?.bind(process)

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
  expect(EVENT_LOOP_BUDGET_MS).toBe(50)
  expect(samples.length).toBeGreaterThan(2)
  expect(Math.max(...samples)).toBeLessThan(EVENT_LOOP_BUDGET_MS)
}
