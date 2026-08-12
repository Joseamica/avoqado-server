import type { CatalogWorkbookUpload } from '@/types/master-catalog'
import { EventEmitter } from 'node:events'
import * as XLSX from 'xlsx'
import {
  CATALOG_XLSX_MIME,
  createCatalogWorkbookService,
  type CatalogWorkbookWorkerHandle,
  WORKBOOK_TIMEOUT_MS,
} from '@/services/master-catalog/catalogWorkbook.service'
import { MASTER_CATALOG_IMPORT_HEADERS } from '@/workers/masterCatalogXlsx.worker'

const VALID_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
const parsed = {
  sheetNames: ['Metadata', 'Items', 'OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'],
  sheets: {},
}

function upload(overrides: Partial<CatalogWorkbookUpload> = {}): CatalogWorkbookUpload {
  return {
    buffer: VALID_BYTES,
    mimeType: CATALOG_XLSX_MIME,
    originalFilename: 'catalog-master-import-v1.xlsx',
    ...overrides,
  }
}

function handle(result: Promise<unknown> = Promise.resolve(parsed)): CatalogWorkbookWorkerHandle {
  return { result: result as CatalogWorkbookWorkerHandle['result'], terminate: jest.fn().mockResolvedValue(undefined) }
}

function completeWorkbookBuffer(): Buffer {
  // WHY: This minimal real workbook proves the default worker entrypoint and
  // transfer protocol, which an injected handle cannot exercise.
  const workbook = XLSX.utils.book_new()
  for (const [name, headers] of Object.entries(MASTER_CATALOG_IMPORT_HEADERS)) {
    const rows: unknown[][] = [[...headers]]
    if (name === 'Metadata') {
      rows.push(['documentType', 'catalog-master-import'], ['schemaVersion', '1'])
    }
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name)
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true, bookSST: true }) as Buffer
}

describe('catalogWorkbook.service upload and worker boundary', () => {
  it('freezes the 15-second timeout and accepts only XLSX MIME or a valid octet-stream .xlsx fallback', async () => {
    // WHY: MIME is a boundary hint, never a replacement for suffix plus OOXML
    // validation inside the worker; the generic binary fallback needs both.
    expect(WORKBOOK_TIMEOUT_MS).toBe(15_000)
    const spawnWorker = jest.fn().mockImplementation(() => handle())
    const service = createCatalogWorkbookService({ spawnWorker })

    await expect(service.parse(upload())).resolves.toBe(parsed)
    await expect(service.parse(upload({ originalFilename: 'opaque-upload.bin' }))).resolves.toBe(parsed)
    await expect(
      service.parse(upload({ mimeType: 'application/octet-stream', originalFilename: 'CATALOG-MASTER-IMPORT-V1.XLSX' })),
    ).resolves.toBe(parsed)
    expect(spawnWorker).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['wrong MIME', { mimeType: 'text/csv' }, 'CATALOG_WORKBOOK_MIME_INVALID'],
    [
      'binary fallback without suffix',
      { mimeType: 'application/octet-stream', originalFilename: 'payload.bin' },
      'CATALOG_WORKBOOK_MIME_INVALID',
    ],
    ['wrong magic', { buffer: Buffer.from('not-a-zip') }, 'CATALOG_WORKBOOK_MAGIC_INVALID'],
    ['empty upload', { buffer: Buffer.alloc(0) }, 'CATALOG_WORKBOOK_MAGIC_INVALID'],
    ['compressed limit', { buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x50) }, 'CATALOG_WORKBOOK_COMPRESSED_LIMIT'],
  ])('rejects %s before allocating a worker', async (_label, overrides, code) => {
    const spawnWorker = jest.fn()
    const service = createCatalogWorkbookService({ spawnWorker })

    await expect(service.parse(upload(overrides))).rejects.toMatchObject({ code })
    expect(spawnWorker).not.toHaveBeenCalled()
  })

  it('transfers an upload-sized standalone ArrayBuffer instead of detaching or leaking the caller Buffer pool', async () => {
    let transferred: ArrayBuffer | undefined
    const spawnWorker = jest.fn().mockImplementation((bytes: ArrayBuffer) => {
      transferred = bytes
      return handle()
    })
    const source = Buffer.from(VALID_BYTES)

    await createCatalogWorkbookService({ spawnWorker }).parse(upload({ buffer: source }))

    // WHY: A dedicated copy is transferable without detaching a pooled Buffer
    // that another middleware may still own after validation fails.
    expect(transferred).toBeInstanceOf(ArrayBuffer)
    expect(transferred?.byteLength).toBe(source.length)
    expect(Buffer.from(transferred ?? new ArrayBuffer(0))).toEqual(source)
    expect(source).toEqual(VALID_BYTES)
  })

  it('parses through the real default worker entrypoint instead of the main thread', async () => {
    const result = await createCatalogWorkbookService().parse(upload({ buffer: completeWorkbookBuffer() }))

    expect(result.sheetNames).toEqual(Object.keys(MASTER_CATALOG_IMPORT_HEADERS))
  }, 15_000)

  it('spawns the parser with bounded old/young heaps and stack plus an exact transfer list', async () => {
    const thread = new EventEmitter() as EventEmitter & { terminate: jest.Mock<Promise<number>, []> }
    thread.terminate = jest.fn().mockResolvedValue(0)
    let workerOptions: Record<string, unknown> | undefined
    const workerFactory = jest.fn((_filename: string, options: Record<string, unknown>) => {
      workerOptions = options
      queueMicrotask(() => thread.emit('message', { ok: true, parsed }))
      return thread as never
    })

    await createCatalogWorkbookService({ workerFactory: workerFactory as never }).parse(upload())

    // WHY: Decompression/parser allocation failures stay confined to a short-
    // lived worker and cannot consume the API process's unrestricted heap.
    expect(workerOptions?.resourceLimits).toEqual({
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    })
    const bytes = (workerOptions?.workerData as { bytes?: ArrayBuffer } | undefined)?.bytes
    expect(bytes).toBeInstanceOf(ArrayBuffer)
    expect(workerOptions?.transferList).toEqual([bytes])
  })

  it('terminates a timed-out worker and returns a stable file error without partial data', async () => {
    jest.useFakeTimers()
    const worker = handle(new Promise(() => undefined))
    const service = createCatalogWorkbookService({ spawnWorker: () => worker, timeoutMs: 25 })
    const pending = service.parse(upload())
    // WHY: Attach the rejection observer before advancing fake time so Jest
    // does not misclassify the intentional timeout as an unhandled rejection.
    const rejection = expect(pending).rejects.toMatchObject({ statusCode: 400, code: 'CATALOG_WORKBOOK_TIMEOUT' })

    await jest.advanceTimersByTimeAsync(25)

    await rejection
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  it.each([
    ['crash', new Error('worker exited 1'), 'CATALOG_WORKBOOK_WORKER_FAILED'],
    ['cancel', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'CATALOG_WORKBOOK_CANCELLED'],
  ])('maps a worker %s to a stable safe error and terminates it', async (_label, error, code) => {
    const worker = handle(Promise.reject(error))

    await expect(createCatalogWorkbookService({ spawnWorker: () => worker }).parse(upload())).rejects.toMatchObject({ code })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('classifies a clean worker exit without a result as a crash instead of waiting for the timeout', async () => {
    const thread = new EventEmitter() as EventEmitter & { terminate: jest.Mock<Promise<number>, []> }
    thread.terminate = jest.fn().mockResolvedValue(0)
    const service = createCatalogWorkbookService({ workerFactory: () => thread as never, timeoutMs: 5_000 })
    const pending = service.parse(upload())
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CATALOG_WORKBOOK_WORKER_FAILED' })

    // WHY: An exit code of zero only describes the process; without the tagged
    // result message it is still an incomplete parse and must fail immediately.
    thread.emit('exit', 0)

    await rejection
    expect(thread.terminate).toHaveBeenCalledTimes(1)
  })

  it('never includes the original filename, payload, SKU, or row price in a worker error', async () => {
    const worker = handle(Promise.reject(new Error('SKU-SECRET price=999.99 in private.xlsx')))

    const rejection = createCatalogWorkbookService({ spawnWorker: () => worker }).parse(upload({ originalFilename: 'private.xlsx' }))

    await expect(rejection).rejects.toMatchObject({ message: expect.not.stringMatching(/SKU-SECRET|999\.99|private\.xlsx/u) })

    const spawnCrash = createCatalogWorkbookService({
      spawnWorker: () => {
        throw new Error('constructor leaked SKU-SECRET')
      },
    })
    await expect(spawnCrash.parse(upload())).rejects.toMatchObject({ code: 'CATALOG_WORKBOOK_WORKER_FAILED' })
  })
})
