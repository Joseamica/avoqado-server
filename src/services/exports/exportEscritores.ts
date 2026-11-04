import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import { csvField } from '@/services/dashboard/export.helpers'
import type { CabeceraXlsx } from './xlsxDesdeMatriz'
import { EXPORT_XLSX_TASK } from '@/workers/exportXlsx.worker'

const XLSX_TIMEOUT_MS = 5 * 60_000
const CSV_TIMEOUT_MS = 2 * 60_000

interface Hilo {
  postMessage(m: unknown): void
  once(e: 'message', l: (m: any) => void): unknown
  once(e: 'error', l: (e: Error) => void): unknown
  once(e: 'exit', l: (code: number) => void): unknown
  terminate(): Promise<number> | number
}
export type CrearHilo = (archivo: string, opciones: ConstructorParameters<typeof Worker>[1]) => Hilo

export interface LibroXlsx {
  agregar(filas: (string | number)[][]): void
  cerrar(): Promise<Buffer>
  abortar(): void
}

export function abrirLibroXlsx(cabecera: CabeceraXlsx, opciones: { timeoutMs?: number; crearHilo?: CrearHilo } = {}): LibroXlsx {
  const esTs = __filename.endsWith('.ts')
  const crear: CrearHilo = opciones.crearHilo ?? ((f, o) => new Worker(f, o))
  const hilo = crear(resolve(__dirname, `../../workers/exportXlsx.worker.${esTs ? 'ts' : 'js'}`), {
    workerData: { task: EXPORT_XLSX_TASK, cabecera },
    // WHY: si un libro no cabe, muere ESTE hilo y no el proceso que cobra (2 GB; la API ronda 510 MB).
    resourceLimits: { maxOldGenerationSizeMb: 1024 },
    ...(esTs ? { execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'] } : {}),
  })
  let muerto = false
  const resultado = new Promise<Buffer>((ok, mal) => {
    hilo.once('message', (m: { ok?: boolean; bytes?: ArrayBuffer }) => {
      if (m.ok && m.bytes) ok(Buffer.from(m.bytes))
      else mal(new Error('EXPORT_XLSX_WORKER_FAILED'))
    })
    hilo.once('error', () => mal(new Error('EXPORT_XLSX_WORKER_FAILED')))
    hilo.once('exit', () => {
      muerto = true
      mal(new Error('EXPORT_XLSX_WORKER_FAILED')) // tras ok(), este mal() no hace nada
    })
  })
  resultado.catch(() => undefined) // evita «unhandled» si abortan antes de cerrar
  return {
    agregar(filas) {
      if (!muerto && filas.length > 0) hilo.postMessage({ tipo: 'filas', filas })
    },
    async cerrar() {
      hilo.postMessage({ tipo: 'cerrar' })
      let reloj: NodeJS.Timeout | undefined
      const tope = new Promise<never>((_, mal) => {
        reloj = setTimeout(() => mal(new Error('EXPORT_XLSX_TIMEOUT')), opciones.timeoutMs ?? XLSX_TIMEOUT_MS)
      })
      try {
        return await Promise.race([resultado, tope])
      } finally {
        clearTimeout(reloj)
        void Promise.resolve(hilo.terminate()).catch(() => undefined)
      }
    },
    abortar() {
      void Promise.resolve(hilo.terminate()).catch(() => undefined)
    },
  }
}

/** Escribe un CSV por tandas a un stream (almacenamiento privado). Nunca espera para siempre: error o tiempo ⇒ rechaza. */
export class EscritorCsv {
  private bytes = 0
  private fallo: Error | null = null
  private readonly timeoutMs: number
  constructor(
    private readonly destino: NodeJS.WritableStream,
    encabezados: string[],
    opciones: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = opciones.timeoutMs ?? CSV_TIMEOUT_MS
    // Codex r2 N1: escucha `error` TODA su vida. Sin esto, un fallo de Storage mientras se espera la siguiente página es una
    // excepción sin capturar y el SERVIDOR se apaga. El error se guarda y sale en la siguiente escritura o al cerrar.
    this.destino.on('error', (e: Error) => {
      this.fallo ??= e
    })
    this.escribir('﻿' + encabezados.map(csvField).join(','))
  }
  private escribir(s: string): boolean {
    const b = Buffer.from(s, 'utf8')
    this.bytes += b.length
    return this.destino.write(b)
  }
  private revisar(): void {
    if (this.fallo) throw this.fallo
  }
  private esperar(evento: 'drain' | 'finish'): Promise<void> {
    if (this.fallo) return Promise.reject(this.fallo)
    return new Promise<void>((ok, mal) => {
      const limpiar = () => {
        clearTimeout(reloj)
        this.destino.removeListener(evento, alListo)
        this.destino.removeListener('error', alError)
      }
      const alListo = () => {
        limpiar()
        ok()
      }
      const alError = (e: Error) => {
        limpiar()
        mal(e)
      }
      const reloj = setTimeout(() => {
        limpiar()
        mal(new Error('EXPORT_CSV_TIMEOUT'))
      }, this.timeoutMs)
      this.destino.once(evento, alListo)
      this.destino.once('error', alError)
    })
  }
  async agregar(filas: (string | number)[][]): Promise<void> {
    this.revisar()
    if (filas.length === 0) return
    const listo = this.escribir(filas.map(f => '\r\n' + f.map(csvField).join(',')).join(''))
    if (!listo) await this.esperar('drain')
  }
  async cerrar(): Promise<number> {
    this.revisar()
    const fin = this.esperar('finish')
    this.destino.end()
    await fin
    return this.bytes
  }
  abortar(): void {
    ;(this.destino as NodeJS.WritableStream & { destroy?: (e?: Error) => void }).destroy?.()
  }
}
