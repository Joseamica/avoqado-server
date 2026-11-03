/**
 * Carga del histórico de números de vinculación de PlayTelecom (spec 2026-10-30 §5.7): lee el Excel del back-office y decide
 * qué hace cada fila. Puro (sin base): lo aplica `scripts/importar-numeros-de-vinculacion.ts`.
 */
import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'

import { isValidTerminalNumber, normalizeLinkingNumber } from '../../../src/services/playtelecom/linkingNumber.rules'

export interface HistoricalRow {
  iccid: string
  simType: string | null
  saleDate: Date | null
  rawNumber: string
  status: string | null
  rowIndex: number
}

/** La forma de `normalizeSerial` del inventario serializado (no se importa: aquel módulo carga Prisma). */
export const normalizeIccid = (raw: string): string => raw.trim().toUpperCase()

/** «# Vinculación» → «vinculacion», «Tipo deSIM» (así viene en el archivo) → «tipodesim». */
const clave = (v: unknown): string =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()

const COLUMNAS = { iccid: 'idsim', simType: 'tipodesim', fecha: 'fecha', numero: 'vinculacion', status: 'statusventa' } as const
/** El archivo trae los encabezados en la fila 3; se buscan en las primeras filas por si el del lanzamiento se mueve. */
const FILAS_DE_ENCABEZADO = 10

const texto = (v: unknown): string | null => {
  const s = v === null || v === undefined ? '' : String(v).trim()
  return s || null
}

/** El día civil de la celda (número de serie de Excel), al mediodía de México: se ve el mismo día en cualquier zona del país. */
function fechaCivil(v: unknown, date1904: boolean): Date | null {
  if (typeof v !== 'number') return null
  const p = XLSX.SSF.parse_date_code(v, { date1904 })
  return p ? new Date(Date.UTC(p.y, p.m - 1, p.d, 18)) : null
}

export function parseHistoricalWorkbook(wb: XLSX.WorkBook): HistoricalRow[] {
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws?.['!ref']) throw new Error('El Excel no tiene una hoja con datos.')
  // Desde A1 a propósito: el índice del arreglo es la fila de Excel menos uno, aunque la hoja empiece en B3.
  const filas = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
    range: { s: { r: 0, c: 0 }, e: XLSX.utils.decode_range(ws['!ref']).e },
  })
  const h = filas.slice(0, FILAS_DE_ENCABEZADO).findIndex(f => f?.some(c => clave(c) === COLUMNAS.iccid))
  if (h < 0) throw new Error(`No encontré el encabezado «ID SIM» en las primeras ${FILAS_DE_ENCABEZADO} filas.`)
  const col = (k: string) => filas[h].findIndex(c => clave(c) === k)
  const idx = {
    iccid: col(COLUMNAS.iccid),
    simType: col(COLUMNAS.simType),
    fecha: col(COLUMNAS.fecha),
    numero: col(COLUMNAS.numero),
    status: col(COLUMNAS.status),
  }
  if (idx.numero < 0)
    throw new Error(`Falta la columna «# Vinculación» (encabezados de la fila ${h + 1}: ${filas[h].filter(c => c !== null).join(', ')}).`)
  const date1904 = !!wb.Workbook?.WBProps?.date1904

  const out: HistoricalRow[] = []
  filas.slice(h + 1).forEach((f, i) => {
    if (!f || f.every(c => texto(c) === null)) return
    const celda = (j: number) => (j < 0 ? null : f[j])
    const id = celda(idx.iccid)
    out.push({
      // Un ICCID numérico ya perdió dígitos (Excel guarda 15): queda vacío y la fila va a inválidos.
      iccid: typeof id === 'string' ? normalizeIccid(id) : '',
      simType: texto(celda(idx.simType)),
      saleDate: fechaCivil(celda(idx.fecha), date1904),
      rawNumber: texto(celda(idx.numero)) ?? '',
      status: texto(celda(idx.status)),
      rowIndex: h + i + 2,
    })
  })
  return out
}

/**
 * `salesByIccid` va con las llaves de `normalizeIccid`. Una venta sin número se llena; con otro número es choque y no se pisa
 * (tampoco contra lo que una fila anterior del mismo archivo ya le puso); un ICCID sin venta va al histórico, una vez por par
 * (ICCID, número). `repeatedNumbers`: los números que el archivo trae en más de una fila; cada fila es una venta, así que la
 * misma SIM vendida dos veces con el mismo número también cuenta (spec §5.2; así salen los 52 que midió el spec).
 */
export function planHistoricalImport(
  rows: HistoricalRow[],
  salesByIccid: Map<string, { id: string; linkingNumber: string | null }>,
): {
  fillSale: { verificationId: string; number: string; rowIndex: number }[]
  conflicts: { verificationId: string; current: string; excel: string; rowIndex: number }[]
  toHistorical: { iccid: string; number: string; saleDate: Date | null; status: string | null }[]
  invalid: { rowIndex: number; raw: string }[]
  repeatedNumbers: string[]
} {
  const plan: ReturnType<typeof planHistoricalImport> = { fillSale: [], conflicts: [], toHistorical: [], invalid: [], repeatedNumbers: [] }
  const numeroDeVenta = new Map<string, string>() // lo que cada venta ya trae o le va a poner este archivo
  const historicos = new Set<string>()
  const filasPorNumero = new Map<string, number>()

  for (const row of rows) {
    const number = normalizeLinkingNumber(row.rawNumber)
    if (!row.iccid || !isValidTerminalNumber(number)) {
      plan.invalid.push({ rowIndex: row.rowIndex, raw: row.rawNumber })
      continue
    }
    filasPorNumero.set(number, (filasPorNumero.get(number) ?? 0) + 1)

    const sale = salesByIccid.get(row.iccid)
    if (sale) {
      const current = numeroDeVenta.get(sale.id) ?? sale.linkingNumber
      if (current === null) {
        plan.fillSale.push({ verificationId: sale.id, number, rowIndex: row.rowIndex })
        numeroDeVenta.set(sale.id, number)
      } else if (current !== number) {
        plan.conflicts.push({ verificationId: sale.id, current, excel: number, rowIndex: row.rowIndex })
      }
      continue
    }
    const par = `${row.iccid}\u0000${number}`
    if (historicos.has(par)) continue
    historicos.add(par)
    plan.toHistorical.push({ iccid: row.iccid, number, saleDate: row.saleDate, status: row.status })
  }

  plan.repeatedNumbers = [...filasPorNumero]
    .filter(([, filas]) => filas > 1)
    .map(([n]) => n)
    .sort()
  return plan
}

/** `importBatch` = `<fecha de México>-<8 del sha1 del archivo>`: el mismo archivo el mismo día da el mismo lote. */
export const importBatchFor = (file: Buffer, now: Date): string =>
  `${new Date(now.getTime() - 6 * 3_600_000).toISOString().slice(0, 10)}-${createHash('sha1').update(file).digest('hex').slice(0, 8)}`
