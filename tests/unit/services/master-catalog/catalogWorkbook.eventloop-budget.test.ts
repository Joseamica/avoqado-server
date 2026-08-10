import { canonicalizeAndHashCatalogImportRows, EVENT_LOOP_BUDGET_MS } from '@/services/master-catalog/catalogImport.service'
import {
  expectCatalogImportEventLoopBudgetV1,
  readCatalogImportThreadCpuUsageV1,
  startCatalogImportEventLoopProbeV1,
} from './catalogImportEventLoopTestHarness'

function representativeRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    sourceSheet: 'Items',
    sourceRow: index + 2,
    command: {
      operation: index % 3 === 0 ? 'CREATE' : 'UPDATE',
      corporateSku: `SKU-${String(index).padStart(8, '0')}`,
      description: `Descripción ${index} ${'x'.repeat(180)}`,
      amount: `${index % 100000}.00`,
      fields: ['name', 'description', 'imageUrl', 'taxRate', 'unit'],
    },
  }))
}

describe('catalog import main-thread event-loop budget', () => {
  it('freezes the 50 ms budget and cooperatively yields while canonicalizing and hashing the maximum row envelope', async () => {
    // WHY: Moving ZIP parsing to a worker is insufficient if 50k domain rows
    // are then canonicalized in one synchronous main-thread loop.
    expect(EVENT_LOOP_BUDGET_MS).toBe(50)
    const rows = representativeRows(50_000)
    const probe = startCatalogImportEventLoopProbeV1()

    const result = await canonicalizeAndHashCatalogImportRows(rows)
    const samples = probe.stop()

    expect(result.hash).toMatch(/^[a-f0-9]{64}$/u)
    expectCatalogImportEventLoopBudgetV1(samples)
  }, 20_000)

  it('is deterministic across chunk boundaries and rejects cancellation without returning a partial hash', async () => {
    const rows = representativeRows(2_001)
    const first = await canonicalizeAndHashCatalogImportRows(rows, { chunkSize: 7 })
    const second = await canonicalizeAndHashCatalogImportRows(rows, { chunkSize: 503 })
    expect(first).toEqual(second)

    const controller = new AbortController()
    controller.abort()
    await expect(canonicalizeAndHashCatalogImportRows(rows, { signal: controller.signal })).rejects.toMatchObject({
      code: 'CATALOG_IMPORT_CANCELLED',
    })
  })

  it('yields by elapsed time even when each row carries the maximum 64-by-4096 cell envelope', async () => {
    const maximumRow = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`column_${index}`, `${index}:${'x'.repeat(4_094)}`]))
    const rows = Array.from({ length: 192 }, (_, index) => ({ ...maximumRow, sourceRow: index + 2 }))
    const probe = startCatalogImportEventLoopProbeV1()

    const result = await canonicalizeAndHashCatalogImportRows(rows, { chunkSize: 2_048 })
    const samples = probe.stop()

    // WHY: A count-only chunk could process the whole 48 MiB envelope in one
    // turn; the monotonic time budget must yield before reaching 50 ms.
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/u)
    expectCatalogImportEventLoopBudgetV1(samples)
  }, 20_000)

  it('keeps detecting a synchronous CPU monopolizer without blaming process descheduling', async () => {
    const probe = startCatalogImportEventLoopProbeV1()
    await new Promise<void>(resolve => setTimeout(resolve, 10))

    const started = readCatalogImportThreadCpuUsageV1()
    let checksum = 0
    while (true) {
      for (let index = 0; index < 10_000; index += 1) checksum = Math.imul(checksum + index, 31)
      const elapsed = readCatalogImportThreadCpuUsageV1(started)
      if ((elapsed.user + elapsed.system) / 1_000 >= EVENT_LOOP_BUDGET_MS + 10) break
    }

    await new Promise<void>(resolve => setTimeout(resolve, 10))
    const samples = probe.stop()
    expect(checksum).toEqual(expect.any(Number))
    expect(samples.length).toBeGreaterThan(2)
    expect(Math.max(...samples)).toBeGreaterThanOrEqual(EVENT_LOOP_BUDGET_MS)
  })
})
