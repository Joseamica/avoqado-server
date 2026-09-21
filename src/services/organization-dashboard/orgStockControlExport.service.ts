import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import AppError from '../../errors/AppError'
import { orgStockControlService } from './orgStockControl.service'
import type { OrgStockOverview, OrgStockOverviewOptions } from './orgStockControl.types'
import { ORG_STOCK_XLSX_TASK } from '../../workers/orgStockXlsx.worker'

// WHY: 19-sep-2026, 11:44 CDMX — esta descarga congeló el event loop 3.27 s
// (Better Stack «Server congelado ≥3 s»; la única petición en vuelo era ésta).
// La causa no fue la consulta —ya viene paginada de 500 en 500— sino armar el
// libro: `json_to_sheet` y `XLSX.write` de SheetJS son 100 % síncronos, así que
// mientras corrían, ni un cobro de la PAX podía ser atendido. Medido: mandar los
// datos al worker cuesta ~43 ms donde armar el libro cuesta ~1,727 ms (60k SIMs).
// Por eso SheetJS ya no se importa aquí; vive en `workers/orgStockXlsx.worker`.

/** Un export explícito de un año puede tardar segundos; matarlo a los 15 s rompería un caso que hoy funciona. */
export const ORG_STOCK_EXPORT_TIMEOUT_MS = 60_000

export interface OrgStockExportWorkerHandle {
  result: Promise<Buffer>
  terminate(): Promise<unknown>
}

interface OrgStockExportThread {
  once(event: 'message', listener: (message: unknown) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number> | number
}

export interface OrgStockControlExportService {
  generateExcelBuffer(orgId: string, options: OrgStockOverviewOptions, orgSlug: string): Promise<{ buffer: Buffer; filename: string }>
}

interface OrgStockControlExportDependencies {
  fetchOverview?: (orgId: string, options: OrgStockOverviewOptions) => Promise<OrgStockOverview>
  spawnWorker?: (data: OrgStockOverview, orgSlug: string) => OrgStockExportWorkerHandle
  workerFactory?: (filename: string, options: ConstructorParameters<typeof Worker>[1]) => OrgStockExportThread
  timeoutMs?: number
}

function exportError(code: string, statusCode = 500): AppError {
  // WHY: el mensaje no lleva detalle del fallo — el libro contiene ICCIDs y
  // nombres de promotores que no deben acabar en un log ni en una respuesta.
  return new AppError('No se pudo generar el Excel de control de stock. Vuelve a intentarlo.', statusCode, true, code)
}

function createDefaultWorker(
  data: OrgStockOverview,
  orgSlug: string,
  workerFactory: (filename: string, options: ConstructorParameters<typeof Worker>[1]) => OrgStockExportThread = (filename, options) =>
    new Worker(filename, options),
): OrgStockExportWorkerHandle {
  // WHY: en el repo el worker es `.ts` y necesita el loader; en el deploy
  // compilado es el `.js` colocado al lado. Mismo criterio que
  // `catalogWorkbook.service.ts`, que ya lo tenía resuelto.
  const execArgv = __filename.endsWith('.ts') ? ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'] : undefined
  const extension = __filename.endsWith('.ts') ? 'ts' : 'js'
  const workerPath = resolve(__dirname, `../../workers/orgStockXlsx.worker.${extension}`)
  const worker = workerFactory(workerPath, {
    workerData: { task: ORG_STOCK_XLSX_TASK, data, orgSlug },
    // WHY: un tenant que crezca lo bastante mata ESTE thread por memoria en vez
    // de tumbar el proceso que cobra. El contenedor tiene 2 GB y la API ronda
    // los 510 MB, así que 1 GB deja margen para las dos cosas.
    resourceLimits: { maxOldGenerationSizeMb: 1024 },
    ...(execArgv ? { execArgv } : {}),
  })
  const result = new Promise<Buffer>((resolveResult, reject) => {
    let settled = false
    worker.once('message', (message: unknown) => {
      settled = true
      const response = message as { ok?: boolean; bytes?: ArrayBuffer }
      if (response.ok && response.bytes) resolveResult(Buffer.from(response.bytes))
      else reject(exportError('ORG_STOCK_EXPORT_WORKER_FAILED'))
    })
    worker.once('error', () => {
      settled = true
      reject(exportError('ORG_STOCK_EXPORT_WORKER_FAILED'))
    })
    worker.once('exit', () => {
      // WHY: un worker muerto por `resourceLimits` sale sin emitir 'message';
      // sin esto la petición se quedaría colgada hasta el timeout.
      if (!settled) {
        settled = true
        reject(exportError('ORG_STOCK_EXPORT_WORKER_FAILED'))
      }
    })
  })
  return { result, terminate: () => Promise.resolve(worker.terminate()) }
}

export function createOrgStockControlExportService(dependencies: OrgStockControlExportDependencies = {}): OrgStockControlExportService {
  const fetchOverview = dependencies.fetchOverview ?? ((orgId, options) => orgStockControlService.getOrgExportOverview(orgId, options))
  const spawnWorker =
    dependencies.spawnWorker ??
    ((data: OrgStockOverview, orgSlug: string) => createDefaultWorker(data, orgSlug, dependencies.workerFactory))
  const timeoutMs = dependencies.timeoutMs ?? ORG_STOCK_EXPORT_TIMEOUT_MS

  return {
    async generateExcelBuffer(orgId, options, orgSlug) {
      const data = await fetchOverview(orgId, options)

      let handle: OrgStockExportWorkerHandle
      try {
        handle = spawnWorker(data, orgSlug)
      } catch {
        // WHY: `new Worker` puede fallar de forma síncrona antes de que exista
        // un handle que terminar.
        throw exportError('ORG_STOCK_EXPORT_WORKER_FAILED')
      }

      let timeout: NodeJS.Timeout | undefined
      const timeoutFailure = new Promise<never>((_resolveTimeout, reject) => {
        timeout = setTimeout(() => reject(exportError('ORG_STOCK_EXPORT_TIMEOUT', 504)), timeoutMs)
      })

      let buffer: Buffer
      try {
        buffer = await Promise.race([handle.result, timeoutFailure])
      } catch (error) {
        const candidate = error as { code?: string }
        throw candidate?.code?.startsWith('ORG_STOCK_EXPORT_') ? (error as AppError) : exportError('ORG_STOCK_EXPORT_WORKER_FAILED')
      } finally {
        if (timeout) clearTimeout(timeout)
        // WHY: sin esto un worker colgado sobrevive a su petición y fuga un thread.
        await handle.terminate().catch(() => undefined)
      }

      const dateStr = new Date().toISOString().split('T')[0]
      const safeSlug = orgSlug.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
      return { buffer, filename: `${safeSlug}-control-stock-${dateStr}.xlsx` }
    },
  }
}

export const orgStockControlExportService = createOrgStockControlExportService()
