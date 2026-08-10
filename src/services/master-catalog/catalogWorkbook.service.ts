import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import AppError from '../../errors/AppError'
import type { CatalogWorkbookUpload } from '../../types/master-catalog'
import { DEFAULT_MASTER_CATALOG_WORKBOOK_LIMITS, type ParsedMasterCatalogWorkbook } from '../../workers/masterCatalogXlsx.worker'

export const CATALOG_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const WORKBOOK_TIMEOUT_MS = 15_000

export interface CatalogWorkbookWorkerHandle {
  result: Promise<ParsedMasterCatalogWorkbook>
  terminate(): Promise<unknown>
}

export interface CatalogWorkbookService {
  parse(upload: CatalogWorkbookUpload, options?: { signal?: AbortSignal }): Promise<ParsedMasterCatalogWorkbook>
}

interface CatalogWorkbookServiceDependencies {
  spawnWorker?: (bytes: ArrayBuffer) => CatalogWorkbookWorkerHandle
  workerFactory?: (filename: string, options: ConstructorParameters<typeof Worker>[1]) => CatalogWorkbookThread
  timeoutMs?: number
}

interface CatalogWorkbookThread {
  once(event: 'message', listener: (message: unknown) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number> | number
}

function safeWorkbookError(code: string, statusCode = 400): AppError {
  // WHY: Workbook errors deliberately omit the original filename and cell
  // content so malformed uploads cannot copy catalog data into logs/responses.
  return new AppError('El archivo XLSX de catálogo no es válido.', statusCode, true, code)
}

function validateUpload(upload: CatalogWorkbookUpload): void {
  // WHY: Cheap boundary checks happen before allocating a worker; deep OOXML
  // verification remains worker-owned and never trusts these hints alone.
  if (!upload || !Buffer.isBuffer(upload.buffer)) throw safeWorkbookError('CATALOG_WORKBOOK_MAGIC_INVALID')
  if (upload.buffer.length > DEFAULT_MASTER_CATALOG_WORKBOOK_LIMITS.maxCompressedBytes) {
    throw safeWorkbookError('CATALOG_WORKBOOK_COMPRESSED_LIMIT')
  }
  const hasSuffix = typeof upload.originalFilename === 'string' && /\.xlsx$/iu.test(upload.originalFilename)
  const officialMime = upload.mimeType === CATALOG_XLSX_MIME
  const safeFallback = upload.mimeType === 'application/octet-stream' && hasSuffix
  if (!officialMime && !safeFallback) throw safeWorkbookError('CATALOG_WORKBOOK_MIME_INVALID')
  if (upload.buffer.length < 4 || !upload.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw safeWorkbookError('CATALOG_WORKBOOK_MAGIC_INVALID')
  }
}

function transferableCopy(buffer: Buffer): ArrayBuffer {
  // WHY: A dedicated exact-size allocation can be transferred safely without
  // detaching a pooled Buffer still owned by Multer or later middleware.
  const bytes = new ArrayBuffer(buffer.length)
  new Uint8Array(bytes).set(buffer)
  return bytes
}

function createDefaultWorker(
  bytes: ArrayBuffer,
  workerFactory: (filename: string, options: ConstructorParameters<typeof Worker>[1]) => CatalogWorkbookThread = (filename, options) =>
    new Worker(filename, options),
): CatalogWorkbookWorkerHandle {
  // WHY: Source-mode workers need the repository TypeScript loader, while the
  // compiled deployment starts the colocated JavaScript worker directly.
  const execArgv = __filename.endsWith('.ts') ? ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'] : undefined
  const extension = __filename.endsWith('.ts') ? 'ts' : 'js'
  const workerPath = resolve(__dirname, `../../workers/masterCatalogXlsx.worker.${extension}`)
  const worker = workerFactory(workerPath, {
    workerData: { task: 'parse-master-catalog-xlsx', bytes },
    transferList: [bytes],
    // WHY: Hostile decompression/parser allocations die with this isolated
    // worker instead of pressuring the API process's unrestricted heap/stack.
    resourceLimits: {
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    },
    ...(execArgv ? { execArgv } : {}),
  })
  const result = new Promise<ParsedMasterCatalogWorkbook>((resolve, reject) => {
    let settled = false
    worker.once('message', (message: unknown) => {
      settled = true
      const response = message as {
        ok?: boolean
        parsed?: ParsedMasterCatalogWorkbook
        error?: { code?: string; statusCode?: number }
      }
      if (response.ok && response.parsed) resolve(response.parsed)
      else reject(safeWorkbookError(response.error?.code ?? 'CATALOG_WORKBOOK_WORKER_FAILED', response.error?.statusCode))
    })
    worker.once('error', () => {
      settled = true
      reject(safeWorkbookError('CATALOG_WORKBOOK_WORKER_FAILED'))
    })
    worker.once('exit', () => {
      if (!settled) {
        settled = true
        reject(safeWorkbookError('CATALOG_WORKBOOK_WORKER_FAILED'))
      }
    })
  })
  return { result, terminate: () => Promise.resolve(worker.terminate()) }
}

function mapWorkerFailure(error: unknown): AppError {
  const candidate = error as { name?: string; code?: string; statusCode?: number }
  if (candidate?.name === 'AbortError') return safeWorkbookError('CATALOG_WORKBOOK_CANCELLED')
  if (candidate?.code?.startsWith('CATALOG_WORKBOOK_')) {
    return safeWorkbookError(candidate.code, candidate.statusCode ?? 400)
  }
  return safeWorkbookError('CATALOG_WORKBOOK_WORKER_FAILED')
}

export function createCatalogWorkbookService(dependencies: CatalogWorkbookServiceDependencies = {}): CatalogWorkbookService {
  const spawnWorker = dependencies.spawnWorker ?? ((bytes: ArrayBuffer) => createDefaultWorker(bytes, dependencies.workerFactory))
  const timeoutMs = dependencies.timeoutMs ?? WORKBOOK_TIMEOUT_MS
  return {
    async parse(upload, options = {}) {
      validateUpload(upload)
      if (options.signal?.aborted) throw safeWorkbookError('CATALOG_WORKBOOK_CANCELLED')
      let handle: CatalogWorkbookWorkerHandle
      try {
        handle = spawnWorker(transferableCopy(upload.buffer))
      } catch (error) {
        // WHY: Worker construction can fail synchronously before a handle
        // exists; map it through the same non-leaking crash boundary.
        throw mapWorkerFailure(error)
      }
      let timeout: NodeJS.Timeout | undefined
      let abortListener: (() => void) | undefined
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(safeWorkbookError('CATALOG_WORKBOOK_TIMEOUT')), timeoutMs)
      })
      const abortFailure = new Promise<never>((_resolve, reject) => {
        if (!options.signal) return
        abortListener = () => reject(safeWorkbookError('CATALOG_WORKBOOK_CANCELLED'))
        options.signal.addEventListener('abort', abortListener, { once: true })
      })
      try {
        // WHY: No partial parse escapes a timeout/cancel/crash; callers receive
        // either one complete serializable workbook or one stable rejection.
        return await Promise.race([handle.result, timeoutFailure, abortFailure])
      } catch (error) {
        throw mapWorkerFailure(error)
      } finally {
        if (timeout) clearTimeout(timeout)
        if (abortListener) options.signal?.removeEventListener('abort', abortListener)
        await handle.terminate().catch(() => undefined)
      }
    },
  }
}
