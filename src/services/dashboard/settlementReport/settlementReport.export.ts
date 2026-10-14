/**
 * Archivos del reporte de liquidación (spec §7 «Escritura»). CSV completo ANTES de enviar (Codex r3 #2). Excel en un worker
 * (patrón de orgStockControlExport.service.ts: SheetJS es síncrono y congelaría los cobros). Semáforo: uno a la vez.
 */
import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'

import AppError from '@/errors/AppError'
import { csvField } from '@/services/dashboard/export.helpers'
import { SETTLEMENT_XLSX_TASK, type CargaDelLibro } from '@/workers/settlementReportXlsx.worker'

import { neutralizarFormula, type DepositRow, type ReportKind, type TransactionRow } from './settlementReport.rows'
import type { ReporteDeLiquidacion } from './settlementReport.service'

type Tipo = 'texto' | 'dinero'
type Celda = string | number | null
export interface ColumnaDeReporte<R> {
  id: string
  label: string
  tipo: Tipo
  valor: (r: R) => Celda
}

export const COLUMNA_OBLIGATORIA = 'fechaDeposito'
export const NOTA_ESTIMADA = 'Fechas calculadas con las reglas de tu procesador. Avoqado no ve tu cuenta bancaria.'
const SIN_CALCULAR = 'Sin calcular'
const TIPO_TARJETA: Record<string, string> = {
  DEBIT: 'Débito',
  CREDIT: 'Crédito',
  AMEX: 'Amex',
  INTERNATIONAL: 'Internacional',
  OTHER: 'Otra',
  NONE: 'Sin tipo',
}
const OPERACION: Record<string, string> = { SALE: 'Venta', REFUND: 'Devolución', TIP_REFUND: 'Devolución de propina' }

export const COLUMNAS_TRANSACCIONES: ColumnaDeReporte<TransactionRow>[] = [
  { id: 'venue', label: 'Negocio', tipo: 'texto', valor: r => r.venueName },
  { id: 'folio', label: 'Folio', tipo: 'texto', valor: r => r.folio },
  { id: 'fechaCobro', label: 'Fecha del cobro', tipo: 'texto', valor: r => r.fechaCobro },
  { id: 'terminal', label: 'Terminal', tipo: 'texto', valor: r => r.terminal },
  { id: 'autorizacion', label: 'Código de autorización', tipo: 'texto', valor: r => r.autorizacion },
  { id: 'ultimos4', label: 'Tarjeta', tipo: 'texto', valor: r => r.ultimos4 },
  { id: 'tipoTarjeta', label: 'Tipo de tarjeta', tipo: 'texto', valor: r => TIPO_TARJETA[r.tipoTarjeta] },
  { id: 'operacion', label: 'Operación', tipo: 'texto', valor: r => OPERACION[r.operacion] },
  { id: 'marca', label: 'Marca', tipo: 'texto', valor: r => r.marca },
  { id: 'consumo', label: 'Consumo', tipo: 'dinero', valor: r => r.consumo },
  { id: 'propina', label: 'Propina', tipo: 'dinero', valor: r => r.propina },
  { id: 'total', label: 'Total', tipo: 'dinero', valor: r => r.total },
  { id: 'comision', label: 'Comisión', tipo: 'dinero', valor: r => r.comision },
  { id: 'ivaComision', label: 'IVA comisión', tipo: 'dinero', valor: r => r.ivaComision },
  { id: 'totalComision', label: 'Total comisión', tipo: 'dinero', valor: r => r.totalComision },
  { id: 'montoADepositar', label: 'Monto a depositar', tipo: 'dinero', valor: r => r.montoADepositar ?? SIN_CALCULAR },
  { id: 'fechaDeposito', label: 'Fecha de depósito (estimada)', tipo: 'texto', valor: r => r.fechaDeposito ?? SIN_CALCULAR },
]

export const COLUMNAS_DEPOSITOS: ColumnaDeReporte<DepositRow>[] = [
  { id: 'venue', label: 'Negocio', tipo: 'texto', valor: () => null }, // se rellena con el nombre en filasDe
  { id: 'fechaDeposito', label: 'Fecha de depósito (estimada)', tipo: 'texto', valor: r => r.fechaDeposito },
  { id: 'periodo', label: 'Periodo de cobros', tipo: 'texto', valor: r => `${r.primerCobro} al ${r.ultimoCobro}` },
  { id: 'consumo', label: 'Consumo', tipo: 'dinero', valor: r => r.consumo },
  { id: 'propinas', label: 'Propinas', tipo: 'dinero', valor: r => r.propinas },
  { id: 'total', label: 'Total', tipo: 'dinero', valor: r => r.total },
  { id: 'comision', label: 'Comisión', tipo: 'dinero', valor: r => r.comision },
  { id: 'ivaComision', label: 'IVA comisión', tipo: 'dinero', valor: r => r.ivaComision },
  { id: 'totalComision', label: 'Total comisión', tipo: 'dinero', valor: r => r.totalComision },
  { id: 'depositoNeto', label: 'Depósito neto', tipo: 'dinero', valor: r => r.depositoNeto },
]

function elegir<R>(todas: ColumnaDeReporte<R>[], pedidas: string[]): ColumnaDeReporte<R>[] {
  if (pedidas.length === 0) return todas // sin lista = todas las columnas
  const set = new Set([...pedidas, COLUMNA_OBLIGATORIA]) // el servidor también la exige (Codex r3, «para el plan»)
  return todas.filter(c => set.has(c.id))
}

function filasDe(rep: ReporteDeLiquidacion, kind: ReportKind, cols: ColumnaDeReporte<any>[]): Celda[][] {
  if (kind === 'transactions') return rep.transacciones.map(r => cols.map(c => c.valor(r)))
  const filas = rep.depositos.map(r => cols.map(c => (c.id === 'venue' ? rep.venueName : c.valor(r))))
  if (rep.sinFecha) {
    const s = rep.sinFecha
    const fijo: Record<string, Celda> = {
      venue: rep.venueName,
      fechaDeposito: 'Sin fecha calculada',
      periodo: `${s.cobros} cobros del ${s.desde} al ${s.hasta}`,
      consumo: s.consumo,
      propinas: s.propinas,
      total: s.total,
    }
    filas.push(cols.map(c => fijo[c.id] ?? null))
  }
  return filas
}

const celdaCsv = (v: Celda, tipo: Tipo): string => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return v.toFixed(2)
  return csvField(tipo === 'texto' ? neutralizarFormula(v) : v)
}

export interface ArchivoGenerado {
  buffer: Buffer
  contentType: string
  extension: 'csv' | 'xlsx'
  nombre: string
}
export type SpawnXlsx = (data: CargaDelLibro) => { result: Promise<Buffer>; terminate(): Promise<unknown> }

const XLSX_TIMEOUT_MS = 30_000

function spawnPorDefecto(data: CargaDelLibro): ReturnType<SpawnXlsx> {
  const execArgv = __filename.endsWith('.ts') ? ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'] : undefined
  const ext = __filename.endsWith('.ts') ? 'ts' : 'js'
  const worker = new Worker(resolve(__dirname, `../../../workers/settlementReportXlsx.worker.${ext}`), {
    workerData: { task: SETTLEMENT_XLSX_TASK, data },
    resourceLimits: { maxOldGenerationSizeMb: 512 },
    ...(execArgv ? { execArgv } : {}),
  })
  const fallo = () =>
    new AppError('No se pudo generar el Excel del reporte. Vuelve a intentarlo.', 500, true, 'SETTLEMENT_REPORT_WORKER_FAILED')
  const result = new Promise<Buffer>((ok, mal) => {
    let listo = false
    worker.once('message', (m: { ok?: boolean; bytes?: ArrayBuffer }) => {
      listo = true
      if (m.ok && m.bytes) ok(Buffer.from(m.bytes))
      else mal(fallo())
    })
    worker.once('error', () => {
      listo = true
      mal(fallo())
    })
    worker.once('exit', () => {
      if (!listo) mal(fallo())
    })
  })
  return { result, terminate: () => Promise.resolve(worker.terminate()) }
}

export async function generarArchivo(
  rep: ReporteDeLiquidacion,
  kind: ReportKind,
  format: 'csv' | 'xlsx',
  columnas: string[],
  deps: { spawnWorker?: SpawnXlsx; timeoutMs?: number } = {},
): Promise<ArchivoGenerado> {
  const cols = kind === 'transactions' ? elegir(COLUMNAS_TRANSACCIONES, columnas) : elegir(COLUMNAS_DEPOSITOS, columnas)
  const filas = filasDe(rep, kind, cols)
  const stem = `${kind === 'transactions' ? 'transacciones' : 'dispersiones'}-${rep.startDate}-a-${rep.endDate}`
  if (format === 'csv') {
    const lineas = [cols.map(c => csvField(c.label)).join(','), ...filas.map(f => f.map((v, i) => celdaCsv(v, cols[i].tipo)).join(','))]
    return {
      buffer: Buffer.from('﻿' + lineas.join('\r\n'), 'utf8'),
      contentType: 'text/csv; charset=utf-8',
      extension: 'csv',
      nombre: `${stem}.csv`,
    }
  }
  const carga: CargaDelLibro = {
    hoja: kind === 'transactions' ? 'Transacciones' : 'Dispersiones',
    encabezado: [
      neutralizarFormula(rep.venueName),
      `${kind === 'transactions' ? 'Reporte de transacciones' : 'Reporte de dispersiones'} · ${rep.startDate} al ${rep.endDate}`,
      `Filtrado por ${rep.dateBasis === 'charge' ? 'fecha del cobro' : 'fecha de depósito'}`,
      NOTA_ESTIMADA,
    ],
    columnas: cols.map(c => ({ label: c.label, tipo: c.tipo })),
    filas: filas.map(f => f.map((v, i) => (cols[i].tipo === 'texto' && typeof v === 'string' ? neutralizarFormula(v) : v))),
  }
  const handle = (deps.spawnWorker ?? spawnPorDefecto)(carga)
  let t: NodeJS.Timeout | undefined
  try {
    const buffer = await Promise.race([
      handle.result,
      new Promise<never>((_, mal) => {
        t = setTimeout(
          () => mal(new AppError('El Excel tardó demasiado. Intenta con menos días o en CSV.', 504, true, 'SETTLEMENT_REPORT_TIMEOUT')),
          deps.timeoutMs ?? XLSX_TIMEOUT_MS,
        )
      }),
    ])
    return {
      buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
      nombre: `${stem}.xlsx`,
    }
  } finally {
    if (t) clearTimeout(t)
    await handle.terminate().catch(() => undefined) // un worker colgado no sobrevive a su petición
  }
}

// ponytail: semáforo en proceso, porque hay una sola instancia y no usamos Redis; si algún día hay dos instancias, pasar a pg_advisory_lock.
let ocupado = false
export async function conTurnoDeReporte<T>(fn: () => Promise<T>, esperaMs = 10_000): Promise<T> {
  const limite = Date.now() + esperaMs
  while (ocupado) {
    if (Date.now() >= limite)
      throw new AppError('Hay otro reporte armándose; intenta en unos segundos.', 429, true, 'SETTLEMENT_REPORT_BUSY')
    await new Promise(r => setTimeout(r, Math.min(200, esperaMs)))
  }
  ocupado = true
  try {
    return await fn()
  } finally {
    ocupado = false
  }
}
